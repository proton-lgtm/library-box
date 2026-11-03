import { EventEmitter } from "node:events";
import { execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { path7za } from "7zip-bin";
import { validateArchivePaths, extractArchive } from "./archive";
import { canTransition, LibraryDatabase } from "./database";
import { DownloadManager } from "./download-manager";
import { Launcher } from "./launcher";
import { applyModArchive } from "./mod-installer";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

import { spawn } from "node:child_process";

const temporaryDirectories: string[] = [];

function makeTempDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "redline-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function makeDatabase(): LibraryDatabase {
  const database = new LibraryDatabase(":memory:");
  database.seed(JSON.stringify([{
    name: "Sample Game",
    thumbnail: "",
    download_links: { direct_link: "https://downloads.example/game.zip" },
    mods: [],
  }]));
  return database;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite library", () => {
  it("seeds games from the catalog and updates them idempotently", () => {
    const database = makeDatabase();
    expect(database.listGames()).toMatchObject([{
      name: "Sample Game",
      downloadLinks: { direct_link: "https://downloads.example/game.zip" },
    }]);
    database.seed(JSON.stringify([{
      name: "Sample Game",
      thumbnail: "https://covers.example/game.jpg",
      download_links: { pixeldrain: "https://pixeldrain.com/u/abc123" },
      mods: [{ name: "Patch" }],
    }]));
    expect(database.listGames()).toHaveLength(1);
    expect(database.listGames()[0]).toMatchObject({
      thumbnail: "https://covers.example/game.jpg",
      downloadLinks: { pixeldrain: "https://pixeldrain.com/u/abc123" },
      mods: [{ name: "Patch" }],
    });
    database.close();
  });

  it("validates download state transitions", () => {
    expect(canTransition("downloading", "paused")).toBe(true);
    expect(canTransition("paused", "downloading")).toBe(true);
    expect(canTransition("downloading", "installed")).toBe(true);
    expect(canTransition("installed", "paused")).toBe(false);
    const database = makeDatabase();
    database.saveDownload({
      gameId: 1,
      url: "https://downloads.example/game.zip",
      status: "downloading",
      archivePath: "C:\\Games\\.redline\\game.archive",
      installDir: "C:\\Games\\Sample Game",
      runAfter: false,
      selectedModIds: [0, 2],
    });
    expect(database.getDownload(1)?.selectedModIds).toEqual([0, 2]);
    expect(() => database.updateDownload(1, { status: "installed" })).not.toThrow();
    expect(() => database.updateDownload(1, { status: "paused" })).toThrow(/transition/);
    database.close();
  });
});

describe("download controls", () => {
  it("pauses, resumes, and cancels an active direct download", async () => {
    const database = makeDatabase();
    const directory = makeTempDirectory();
    const launcher = new Launcher(database);
    const manager = new DownloadManager(database, launcher);
    const requests: Array<AbortSignal | undefined> = [];
    vi.stubGlobal("fetch", vi.fn((_url: URL, options?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        requests.push(options?.signal ?? undefined);
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
    ));

    await manager.start({
      gameId: 1,
      url: "https://downloads.example/game.zip",
      destination: directory,
      runAfter: false,
      selectedModIds: [],
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    manager.pause(1);
    expect(database.getDownload(1)?.status).toBe("paused");

    manager.resume(1);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(database.getDownload(1)?.status).toBe("downloading");
    manager.cancel(1);
    expect(database.getDownload(1)?.status).toBe("cancelled");
    expect(requests[1]?.aborted).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    database.close();
  });

  it("downloads selected mods and applies their catalog steps during installation", async () => {
    const root = makeTempDirectory();
    const gameSource = path.join(root, "game-source");
    const modSource = path.join(root, "mod-source");
    mkdirSync(path.join(gameSource, "game"), { recursive: true });
    mkdirSync(path.join(modSource, "mod", "game"), { recursive: true });
    writeFileSync(path.join(gameSource, "game.exe"), "launcher");
    writeFileSync(path.join(gameSource, "game", "base.txt"), "base");
    writeFileSync(path.join(modSource, "mod", "game", "patch.rpy"), "patched");
    const gameArchive = path.join(root, "base.zip");
    const modArchive = path.join(root, "patch.zip");
    const directMod = Buffer.from("direct mod contents");
    execFileSync(path7za, ["a", gameArchive, "."], {
      cwd: gameSource,
      windowsHide: true,
    });
    execFileSync(path7za, ["a", modArchive, "mod"], {
      cwd: modSource,
      windowsHide: true,
    });
    const database = new LibraryDatabase(":memory:");
    database.seed(JSON.stringify([{
      name: "Modded Game",
      download_links: { direct_link: "https://downloads.example/base.zip" },
      mods: [{
        name: "Patch",
        download_links: { direct_link: "https://downloads.example/patch.zip" },
        steps_to_apply: [{
          type: "move",
          source_folder: "mod/game",
          target_folder: "%GAME_ROOT%/game",
        }],
      }, {
        name: "Direct Fix",
        download_links: { direct_link: "https://downloads.example/fix.dll" },
        steps_to_apply: [{
          type: "move",
          target_folder: "%GAME_ROOT%/mods",
        }],
      }],
    }]));
    const manager = new DownloadManager(database, new Launcher(database));
    const gameBytes = await import("node:fs/promises").then(({ readFile }) => readFile(gameArchive));
    const modBytes = await import("node:fs/promises").then(({ readFile }) => readFile(modArchive));
    vi.stubGlobal("fetch", vi.fn((url: URL) => Promise.resolve(new Response(
        url.pathname.endsWith("patch.zip") ? modBytes :
          url.pathname.endsWith("fix.dll") ? directMod : gameBytes,
        { status: 200, headers: { "content-type": "application/zip" } },
    ))));

    await manager.start({
      gameId: 1,
      url: "https://downloads.example/base.zip",
      destination: root,
      runAfter: false,
      selectedModIds: [0, 1],
    });
    await vi.waitFor(() => expect(database.getDownload(1)).toMatchObject({ status: "installed" }));
    const installedPatch = path.join(root, "Modded Game", "game", "patch.rpy");
    expect(await import("node:fs/promises").then(({ readFile }) => readFile(installedPatch, "utf8"))).toBe("patched");
    const installedDirectMod = path.join(root, "Modded Game", "mods", "Direct Fix.dll");
    expect(await import("node:fs/promises").then(({ readFile }) => readFile(installedDirectMod, "utf8"))).toBe("direct mod contents");
    database.close();
  });
});

describe("safe archive extraction", () => {
  it("rejects traversal and absolute archive paths", () => {
    const destination = path.join(makeTempDirectory(), "install");
    for (const unsafePath of ["../outside.txt", "folder/../../outside.txt", "C:\\outside.txt", "\\\\server\\share\\file"]) {
      expect(() => validateArchivePaths([unsafePath], destination)).toThrow(/unsafe path/);
    }
  });

  it("extracts a valid 7z archive inside the selected destination", async () => {
    const root = makeTempDirectory();
    const source = path.join(root, "story.txt");
    const archive = path.join(root, "game.7z");
    const destination = path.join(root, "installed");
    mkdirSync(destination);
    writeFileSync(source, "installed safely");
    execFileSync(path7za, ["a", archive, "story.txt"], {
      cwd: root,
      windowsHide: true,
    });
    await extractArchive(archive, destination);
    expect(await import("node:fs/promises").then(({ readFile }) => readFile(path.join(destination, "story.txt"), "utf8"))).toBe("installed safely");
  });
});

describe("game launch and stop", () => {
  it("spawns the game without a shell and stops its process tree", async () => {
    const directory = makeTempDirectory();
    const gameDirectory = path.join(directory, "game");
    mkdirSync(gameDirectory);
    const executable = path.join(gameDirectory, process.platform === "win32" ? "game.exe" : "game.sh");
    writeFileSync(executable, "test launcher");
    if (process.platform !== "win32") chmodSync(executable, 0o755);
    const database = makeDatabase();
    database.saveDownload({
      gameId: 1,
      url: "https://downloads.example/game.zip",
      status: "installed",
      archivePath: path.join(directory, "game.archive"),
      installDir: gameDirectory,
      runAfter: false,
      selectedModIds: [],
    });
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { pid: 9876, unref: vi.fn() });
    vi.mocked(spawn).mockImplementation((() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as typeof spawn);
    const launcher = new Launcher(database);

    await launcher.launch(1);
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      executable,
      [],
      expect.objectContaining({ shell: false, cwd: gameDirectory }),
    );
    expect(launcher.runningIds().has(1)).toBe(true);
    launcher.stop(1);
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      "taskkill",
      ["/PID", "9876", "/T", "/F"],
      expect.objectContaining({ shell: false }),
    );
    expect(launcher.runningIds().has(1)).toBe(false);
    database.close();
  });
});

describe("mod application", () => {
  it("extracts a mod safely and merges its configured source into the game", async () => {
    const root = makeTempDirectory();
    const gameRoot = path.join(root, "game");
    const sourceRoot = path.join(root, "source");
    const modContents = path.join(sourceRoot, "mod", "game");
    mkdirSync(gameRoot);
    mkdirSync(modContents, { recursive: true });
    mkdirSync(path.join(gameRoot, "game"));
    writeFileSync(path.join(gameRoot, "game", "existing.txt"), "base");
    writeFileSync(path.join(modContents, "existing.txt"), "mod override");
    writeFileSync(path.join(modContents, "new.txt"), "new mod file");
    const archive = path.join(root, "gallery.zip");
    execFileSync(path7za, ["a", archive, "mod"], {
      cwd: sourceRoot,
      windowsHide: true,
    });

    await applyModArchive(archive, {
      name: "Gallery Unlocker",
      download_links: { direct_link: "https://downloads.example/gallery.zip" },
      steps_to_apply: [{
        type: "move",
        source_folder: "mod/game",
        target_folder: "%GAME_ROOT%/game",
      }],
    }, gameRoot);

    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path.join(gameRoot, "game", "existing.txt"), "utf8")).toBe("mod override");
    expect(await readFile(path.join(gameRoot, "game", "new.txt"), "utf8")).toBe("new mod file");
  });

  it("rejects mod steps that escape the installation directory", async () => {
    const root = makeTempDirectory();
    const gameRoot = path.join(root, "game");
    mkdirSync(gameRoot);
    const source = path.join(root, "source");
    mkdirSync(source);
    const archive = path.join(root, "empty.zip");
    execFileSync(path7za, ["a", archive, "."], {
      cwd: source,
      windowsHide: true,
    });
    await expect(applyModArchive(archive, {
      name: "Unsafe mod",
      download_links: { direct_link: "https://downloads.example/mod.zip" },
      steps_to_apply: [{ type: "extract", target_folder: "../outside" }],
    }, gameRoot)).rejects.toThrow(/escapes/);
  });
});
