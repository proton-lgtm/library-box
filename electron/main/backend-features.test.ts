import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { path7za } from "7zip-bin";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DownloadUpdate } from "../../src/shared/types";

vi.mock("electron", () => ({ BrowserWindow: vi.fn(), session: {} }));
import { extractArchive, validateArchivePaths, type ExtractionProgress } from "./archive";
import { LibraryDatabase } from "./database";
import { DownloadManager } from "./downloads/download-manager";
import { restoreOriginalInstallation } from "./downloads/restore-original";
import { Launcher } from "./launcher";

const directories: string[] = [];
const databases: LibraryDatabase[] = [];
const launcherName = process.platform === "win32" ? "game.exe" : "game.sh";
function fixture() {
  const root = mkdtempSync(path.join(process.cwd(), ".backend-feature-"));
  directories.push(root);
  const source = path.join(root, "source");
  const installDir = path.join(root, "installed");
  mkdirSync(source);
  mkdirSync(installDir);
  writeFileSync(path.join(source, launcherName), "original launcher");
  chmodSync(path.join(source, launcherName), 0o755);
  writeFileSync(path.join(source, "base.txt"), "original content");
  const archivePath = path.join(installDir, "game.zip");
  execFileSync(path7za, ["a", archivePath, launcherName, "base.txt"], { cwd: source, windowsHide: true, stdio: "ignore" });
  writeFileSync(path.join(installDir, launcherName), "modified launcher");
  chmodSync(path.join(installDir, launcherName), 0o755);
  writeFileSync(path.join(installDir, "local-save.dat"), "local save");
  const database = new LibraryDatabase(":memory:");
  databases.push(database);
  database.seed(JSON.stringify([{
    name: "Installed", download_links: {}, mods: [],
  }]));
  database.saveDownload({
    gameId: 1, status: "installed", url: "https://example.com/game.zip", installDir, archivePath,
    runAfter: false, appliedModIds: [0, 2],
  });
  const launcher = new Launcher(database);
  const manager = new DownloadManager(database, launcher);
  return { root, source, installDir, archivePath, database, launcher, manager };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("extraction progress and path safety", () => {
  it("streams real bounded archive progress, with indeterminate initialization", async () => {
    const { root, archivePath } = fixture();
    const updates: ExtractionProgress[] = [];
    const destination = path.join(root, "extracted");
    await extractArchive(archivePath, destination, (update) => updates.push(update));
    expect(updates[0]).toEqual({ percent: null, detail: null });
    expect(updates.at(-1)?.percent).toBe(100);
    expect(updates.filter((update) => update.percent !== null).every((update) => update.percent! >= 0 && update.percent! <= 100)).toBe(true);
    expect(readFileSync(path.join(destination, "base.txt"), "utf8")).toBe("original content");
  });

  it.each(["../x.txt", "C:/x.txt", "\\outside.txt", "folder/thing:stream", "folder./x", "NUL.txt"])("rejects unsafe entry %s", (entry) => {
    expect(() => validateArchivePaths([entry], process.cwd())).toThrow(/unsafe path/);
  });

  it("rejects archive traversal before extraction", async () => {
    const { root, source } = fixture();
    writeFileSync(path.join(source, "safe.txt"), "outside");
    const archive = path.join(root, "unsafe.zip");
    execFileSync(path7za, ["a", archive, "safe.txt"], { cwd: source, stdio: "ignore" });
    writeFileSync(archive, Buffer.from(readFileSync(archive).toString("latin1").replaceAll("safe.txt", "../x.txt"), "latin1"));
    await expect(extractArchive(archive, path.join(root, "target"))).rejects.toThrow(/unsafe path/);
    expect(existsSync(path.join(root, "x.txt"))).toBe(false);
  });

  it("rejects symbolic-link archive entries before extraction", async () => {
    const { root, source } = fixture();
    writeFileSync(path.join(source, "link.txt"), "../outside.txt");
    const archive = path.join(root, "symlink.zip");
    execFileSync(path7za, ["a", archive, "link.txt"], { cwd: source, stdio: "ignore" });
    const bytes = readFileSync(archive);
    const centralHeader = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt16LE(0x0314, centralHeader + 4);
    bytes.writeUInt32LE((0xa1ff * 0x10000) >>> 0, centralHeader + 38);
    writeFileSync(archive, bytes);
    await expect(extractArchive(archive, path.join(root, "output"))).rejects.toThrow(/links/);
    expect(existsSync(path.join(root, "output", "link.txt"))).toBe(false);
  });

  it("rejects pre-existing junction targets without writing outside the destination", async () => {
    const { root, source } = fixture();
    mkdirSync(path.join(source, "linked"));
    writeFileSync(path.join(source, "linked", "outside.txt"), "bad");
    const archive = path.join(root, "link-target.zip");
    execFileSync(path7za, ["a", archive, "linked"], { cwd: source, stdio: "ignore" });
    const destination = path.join(root, "destination");
    const outside = path.join(root, "outside");
    mkdirSync(destination);
    mkdirSync(outside);
    symlinkSync(outside, path.join(destination, "linked"), "junction");
    await expect(extractArchive(archive, destination)).rejects.toThrow(/link|junction/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("forwards live extraction updates for both game and mod archives", async () => {
    const { database, manager, installDir, archivePath } = fixture();
    const updates: DownloadUpdate[] = [];
    manager.onUpdate((update) => updates.push(update));
    database.saveDownload({ ...database.getDownload(1)!, status: "failed", appliedModIds: [] });
    manager.resume(1);
    await vi.waitFor(() => expect(manager.isActive(1)).toBe(false), { timeout: 10000 });
    expect(database.getDownload(1)?.status).toBe("installed");
    expect(updates.some((item) => item.kind === "game" && item.phase === "extracting" && item.extractionProgress === 100)).toBe(true);
    database.seed(JSON.stringify([{
      name: "Installed", download_links: {}, mods: [{
        name: "Patch", download_links: { direct_link: "https://example.com/patch.zip" },
        steps_to_apply: [{ type: "move", target_folder: "%GAME_ROOT%/patch" }],
      }],
    }]));
    writeFileSync(path.join(installDir, "Patch.zip"), readFileSync(archivePath));
    await manager.applyMods(1, [0]);
    await vi.waitFor(() => expect(manager.isActive(1)).toBe(false), { timeout: 10000 });
    expect(updates.some((item) => item.kind === "mod" && item.phase === "applying-mods" && item.extractionProgress === 100)).toBe(true);
    expect(database.getDownload(1)?.appliedModIds).toEqual([0]);
    expect(manager.listQueue().find((item) => item.kind === "mod")).toMatchObject({ status: "completed", extractionProgress: null });
  });

  it("persists extraction progress and forwards it through game queue snapshots", () => {
    const { database, manager } = fixture();
    database.saveDownload({ ...database.getDownload(1)!, status: "downloading", phase: "extracting", extractionProgress: 42 });
    expect(database.listDownloads()[0].extractionProgress).toBe(42);
    expect(database.getDownload(1)?.extractionProgress).toBe(42);
    expect(manager.listQueue()[0]).toMatchObject({ extractionProgress: 42, phase: "extracting" });
  });
});

describe("explicit local reverification", () => {
  it("removes stale installed records with no launcher, but never deletes remaining files", async () => {
    const { database, manager, installDir, archivePath } = fixture();
    rmSync(path.join(installDir, launcherName));
    await manager.reverifyLocalGames();
    expect(database.getDownload(1)).toBeUndefined();
    expect(existsSync(archivePath)).toBe(true);
    expect(readFileSync(path.join(installDir, "local-save.dat"), "utf8")).toBe("local save");
  });

  it.each(["downloading", "paused"] as const)("keeps %s records even when their folders are absent", async (status) => {
    const { database, manager, installDir } = fixture();
    database.saveDownload({ ...database.getDownload(1)!, status });
    rmSync(installDir, { recursive: true });
    await manager.reverifyLocalGames();
    expect(database.getDownload(1)?.status).toBe(status);
  });

  it("removes a missing terminal download and retains a valid installed game", async () => {
    const { database, manager, root } = fixture();
    database.seed(JSON.stringify([{ name: "Missing", download_links: {}, mods: [] }]));
    database.saveDownload({ gameId: 2, status: "failed", url: "https://example.com/a.zip", installDir: path.join(root, "absent"), archivePath: path.join(root, "absent", "game.zip"), runAfter: false });
    await manager.reverifyLocalGames();
    expect(database.getDownload(2)).toBeUndefined();
    expect(database.getDownload(1)?.status).toBe("installed");
  });

  it("keeps running games and missing protected installations during ordinary library reads", async () => {
    const { database, manager, launcher, installDir } = fixture();
    vi.spyOn(launcher, "runningIds").mockReturnValue(new Set([1]));
    rmSync(installDir, { recursive: true });
    await manager.reverifyLocalGames();
    expect(database.listLibrary(new Set([1]))).toHaveLength(1);
    expect(database.getDownload(1)).toBeDefined();
  });
});

describe("remove all mods", { timeout: 15_000 }, () => {
  it("restores only original contents, preserves archive bytes, clears markers after success, and publishes progress", async () => {
    const { manager, database, installDir, archivePath, root } = fixture();
    const original = readFileSync(archivePath);
    const updates: DownloadUpdate[] = [];
    let settled = false;
    manager.onUpdate((update) => {
      updates.push(update);
      expect(settled).toBe(false);
      expect(manager.listQueue().find((item) => item.id === update.id)).toEqual(update);
      if (update.status === "applying") expect(manager.isActive(1)).toBe(true);
    });
    const operation = manager.removeAllMods(1).then(() => { settled = true; });
    expect(settled).toBe(false);
    expect(manager.listQueue()[0]).toMatchObject({ status: "applying", phase: null, extractionProgress: null, phaseDetail: expect.stringContaining("Preparing") });
    await operation;
    expect(settled).toBe(true);
    expect(readFileSync(archivePath)).toEqual(original);
    expect(readFileSync(path.join(installDir, launcherName), "utf8")).toBe("original launcher");
    expect(existsSync(path.join(installDir, "local-save.dat"))).toBe(false);
    expect(database.getDownload(1)).toMatchObject({ status: "installed", appliedModIds: [], phase: null, extractionProgress: null, error: null });
    expect(database.listLibrary()).toEqual([expect.objectContaining({ appliedModIds: [] })]);
    expect(updates.some((item) => item.status === "applying" && item.phase === "extracting" && item.extractionProgress === 100)).toBe(true);
    expect(updates.at(-1)?.status).toBe("completed");
    expect(readdirSync(root).filter((entry) => entry.includes("-restore-"))).toEqual([]);
    expect(manager.isActive(1)).toBe(false);
  });

  it("retains the original installation and markers if the archive is corrupt", async () => {
    const { manager, database, archivePath, installDir } = fixture();
    const updates: DownloadUpdate[] = [];
    manager.onUpdate((update) => updates.push(update));
    writeFileSync(archivePath, readFileSync(archivePath).subarray(0, 40));
    const originalFiles = readdirSync(installDir);
    await expect(manager.removeAllMods(1)).rejects.toThrow();
    expect(readdirSync(installDir)).toEqual(originalFiles);
    expect(updates.some((item) => item.phase === "extracting")).toBe(false);
    expect(readFileSync(path.join(installDir, "local-save.dat"), "utf8")).toBe("local save");
    expect(database.getDownload(1)?.appliedModIds).toEqual([0, 2]);
    expect(manager.listQueue()[0]).toMatchObject({ status: "failed", phase: null, extractionProgress: null, error: expect.any(String) });
    expect(manager.isActive(1)).toBe(false);
  });

  it("refuses a valid archive with no launcher before cleanup", async () => {
    const { manager, database, archivePath, installDir, source } = fixture();
    rmSync(archivePath);
    execFileSync(path7za, ["a", archivePath, "base.txt"], { cwd: source, stdio: "ignore" });
    await expect(manager.removeAllMods(1)).rejects.toThrow(/launcher/);
    expect(existsSync(path.join(installDir, "local-save.dat"))).toBe(true);
    expect(database.getDownload(1)?.appliedModIds).toEqual([0, 2]);
  });

  it("rolls the folder back if metadata commit fails", async () => {
    const { database, root, installDir } = fixture();
    await expect(restoreOriginalInstallation(database.getDownload(1)!, [], () => {}, () => { throw new Error("commit failed"); })).rejects.toThrow(/commit failed/);
    expect(readFileSync(path.join(installDir, launcherName), "utf8")).toBe("modified launcher");
    expect(existsSync(path.join(installDir, "local-save.dat"))).toBe(true);
    expect(database.getDownload(1)?.appliedModIds).toEqual([0, 2]);
    expect(readdirSync(root).filter((entry) => entry.includes("-restore-"))).toEqual([]);
  });

  it("blocks competing operations and reverification while staging is active", async () => {
    const { manager, database } = fixture();
    const operation = manager.removeAllMods(1);
    expect(manager.isActive(1)).toBe(true);
    await expect(manager.removeAllMods(1)).rejects.toThrow(/active operation/);
    await expect(manager.applyMods(1, [])).rejects.toThrow(/active operation/);
    await manager.reverifyLocalGames();
    expect(database.getDownload(1)).toBeDefined();
    await operation;
  });

  it("rejects running and noninstalled games", async () => {
    const { manager, launcher, database } = fixture();
    vi.spyOn(launcher, "runningIds").mockReturnValue(new Set([1]));
    await expect(manager.removeAllMods(1)).rejects.toThrow(/Stop the game/);
    database.saveDownload({ ...database.getDownload(1)!, status: "failed" });
    await expect(manager.removeAllMods(1)).rejects.toThrow(/not installed/);
  });

  it.each(["root", "external-archive", "outside-game-root"])("refuses unsafe %s records", async (scenario) => {
    const { manager, database, installDir, root } = fixture();
    const patch = scenario === "root" ? { installDir: path.parse(root).root }
      : scenario === "external-archive" ? { archivePath: path.join(root, "source", "base.txt") }
        : { gameRoot: root };
    database.saveDownload({ ...database.getDownload(1)!, ...patch });
    await expect(manager.removeAllMods(1)).rejects.toThrow(/unsafe|expected location/);
    expect(existsSync(path.join(installDir, "local-save.dat"))).toBe(true);
    expect(database.getDownload(1)?.appliedModIds).toEqual([0, 2]);
  });

  it("rejects nested junctions and hard links without removing their targets", async () => {
    const { manager, installDir, root } = fixture();
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "keep.txt"), "keep");
    symlinkSync(outside, path.join(installDir, "linked"), "junction");
    await expect(manager.removeAllMods(1)).rejects.toThrow(/link/);
    rmSync(path.join(installDir, "linked"));
    linkSync(path.join(outside, "keep.txt"), path.join(installDir, "hard-link.txt"));
    await expect(manager.removeAllMods(1)).rejects.toThrow(/link/);
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

  it("rejects installation junctions and overlapping local game folders", async () => {
    const { database, manager, installDir, root } = fixture();
    const alias = path.join(root, "alias");
    symlinkSync(installDir, alias, "junction");
    const record = database.getDownload(1)!;
    database.saveDownload({ ...record, installDir: alias, gameRoot: alias, archivePath: path.join(alias, "game.zip") });
    await expect(manager.removeAllMods(1)).rejects.toThrow(/link|junction/);
    database.saveDownload(record);
    database.seed(JSON.stringify([{ name: "Nested", download_links: {}, mods: [] }]));
    database.saveDownload({ gameId: 2, status: "paused", url: "https://example.com/other.zip", archivePath: path.join(installDir, "nested", "game.zip"), installDir: path.join(installDir, "nested"), runAfter: false });
    await expect(manager.removeAllMods(1)).rejects.toThrow(/overlaps/);
    expect(existsSync(path.join(installDir, "local-save.dat"))).toBe(true);
  });

  it("does not race with an in-flight launcher or deletion operation", async () => {
    const { manager } = fixture();
    let finish!: () => void;
    const work = manager.runExclusive(1, () => new Promise<void>((resolve) => { finish = resolve; }));
    await expect(manager.removeAllMods(1)).rejects.toThrow(/active operation/);
    finish();
    await work;
    expect(manager.isActive(1)).toBe(false);
  });

  it("supports legacy original archive locations without deleting the original", async () => {
    const { database, manager, root, archivePath } = fixture();
    const legacy = path.join(root, ".redline-downloads");
    mkdirSync(legacy);
    const legacyArchive = path.join(legacy, "1.archive");
    writeFileSync(legacyArchive, readFileSync(archivePath));
    rmSync(archivePath);
    database.saveDownload({ ...database.getDownload(1)!, archivePath: legacyArchive });
    await manager.removeAllMods(1);
    expect(existsSync(legacyArchive)).toBe(true);
    expect(database.getDownload(1)?.appliedModIds).toEqual([]);
  });
});
