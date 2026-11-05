import { EventEmitter } from "node:events";
import { execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { path7za } from "7zip-bin";
import { validateArchivePaths, extractArchive } from "./archive";
import { canTransition, LibraryDatabase } from "./database";
import { DownloadManager } from "./download-manager";
import { Launcher } from "./launcher";
import { LibraryManager } from "./library-manager";
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

  it("syncs remote metadata by UUID without losing local download records", () => {
    const root = makeTempDirectory();
    const installDir = path.join(root, "Sample Game");
    mkdirSync(installDir);
    const database = makeDatabase();
    const localId = database.listGames()[0].id;
    database.saveDownload({
      gameId: localId,
      url: "https://downloads.example/game.zip",
      status: "installed",
      archivePath: path.join(installDir, "game.zip"),
      installDir,
      runAfter: false,
      selectedModIds: [],
    });

    database.syncCatalog([{
      id: "69e2af3e-4128-4e15-95a0-b90e33ae11cd",
      name: "Sample Game",
      thumbnail: "https://covers.example/game.webp",
      sizeBytes: 1024,
      lastUpdated: "2026-11-01T00:00:00.000Z",
      tags: ["visual novel", "demo"],
      description: "A game description.",
      releaseDate: "2026-10-25",
      detailsLastUpdated: "2026-11-02T00:00:00.000Z",
      developerLinks: { website: "https://developer.example" },
      version: "1.2.0",
      operatingSystems: ["Windows", "Linux"],
      downloadLinks: { pixeldrain: "https://pixeldrain.com/u/example" },
      mods: [],
    }]);

    expect(database.listGames()[0]).toMatchObject({
      id: localId,
      supabaseId: "69e2af3e-4128-4e15-95a0-b90e33ae11cd",
      sizeBytes: 1024,
      tags: ["visual novel", "demo"],
      description: "A game description.",
      developerLinks: { website: "https://developer.example" },
      operatingSystems: ["Windows", "Linux"],
    });
    expect(database.getDownload(localId)?.status).toBe("installed");
    expect(database.getCatalogLastSyncedAt()).toBeTruthy();

    database.syncCatalog([]);
    expect(database.listGames()).toEqual([]);
    expect(database.listLibrary()).toHaveLength(1);
    expect(database.getDownload(localId)?.status).toBe("installed");
    database.close();
  });

  it("preserves an old local row when a remote rename collides with its name", () => {
    const root = makeTempDirectory();
    const installDir = path.join(root, "New Remote Name");
    mkdirSync(installDir);
    const database = makeDatabase();
    const oldRemoteId = "69e2af3e-4128-4e15-95a0-b90e33ae11cd";
    database.syncCatalog([{
      id: oldRemoteId,
      name: "Old Remote Name",
      thumbnail: "",
      sizeBytes: null,
      lastUpdated: null,
      tags: [],
      description: "",
      releaseDate: null,
      detailsLastUpdated: null,
      developerLinks: {},
      version: null,
      operatingSystems: [],
      downloadLinks: {},
      mods: [],
    }]);
    database.seed(JSON.stringify([{
      name: "New Remote Name",
      download_links: {},
      mods: [],
    }]));
    const localGame = database.listGames().find((game) => game.name === "New Remote Name");
    if (!localGame) throw new Error("The legacy local game was not seeded.");
    database.saveDownload({
      gameId: localGame.id,
      url: "https://downloads.example/older-game.zip",
      status: "installed",
      archivePath: path.join(installDir, "older-game.zip"),
      installDir,
      runAfter: false,
      selectedModIds: [],
    });

    database.syncCatalog([{
      id: oldRemoteId,
      name: "New Remote Name",
      thumbnail: "",
      sizeBytes: null,
      lastUpdated: null,
      tags: [],
      description: "",
      releaseDate: null,
      detailsLastUpdated: null,
      developerLinks: {},
      version: null,
      operatingSystems: [],
      downloadLinks: {},
      mods: [],
    }]);

    expect(database.listGames()).toHaveLength(1);
    expect(database.listGames()[0]).toMatchObject({
      name: "New Remote Name",
      supabaseId: oldRemoteId,
    });
    expect(database.listLibrary()).toMatchObject([{
      name: expect.stringMatching(/^New Remote Name \(local record \d+\)$/),
      installDir,
    }]);
    expect(database.getCatalogLastSyncedAt()).toBeTruthy();
    database.close();
  });

  it("adds catalog cache columns to an existing local database without dropping installs", () => {
    const root = makeTempDirectory();
    const databasePath = path.join(root, "library.sqlite");
    const installDir = path.join(root, "Sample Game");
    mkdirSync(installDir);
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE games (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        thumbnail TEXT NOT NULL DEFAULT '',
        download_links TEXT NOT NULL DEFAULT '{}',
        mods TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE downloads (
        game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        status TEXT NOT NULL,
        bytes_downloaded INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER,
        archive_path TEXT NOT NULL,
        install_dir TEXT NOT NULL,
        run_after INTEGER NOT NULL DEFAULT 0,
        selected_mods TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO games (id,name) VALUES (17,'Sample Game');
      INSERT INTO downloads (game_id,url,status,archive_path,install_dir)
      VALUES (17,'https://downloads.example/game.zip','installed',
        '${path.join(installDir, "game.zip").replace(/'/g, "''")}',
        '${installDir.replace(/'/g, "''")}');
    `);
    legacy.close();

    const migrated = new LibraryDatabase(databasePath);
    expect(migrated.listGames()[0]).toMatchObject({
      id: 17,
      name: "Sample Game",
      tags: [],
      developerLinks: {},
    });
    expect(migrated.listLibrary()).toHaveLength(1);
    migrated.close();
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

  it("removes installed records when their folders are deleted outside the app", () => {
    const root = makeTempDirectory();
    const installDir = path.join(root, "Sample Game");
    mkdirSync(installDir);
    const database = makeDatabase();
    database.saveDownload({
      gameId: 1,
      url: "https://downloads.example/game.zip",
      status: "installed",
      archivePath: path.join(installDir, "game.zip"),
      installDir,
      runAfter: false,
      selectedModIds: [],
    });

    rmSync(installDir, { recursive: true });

    expect(database.listLibrary()).toEqual([]);
    expect(database.listGames()[0].installDir).toBeNull();
    expect(database.getDownload(1)).toBeUndefined();
    database.close();
  });

  it("deletes an installed game folder and removes it from the library", async () => {
    const root = makeTempDirectory();
    const installDir = path.join(root, "Sample Game");
    const archivePath = path.join(installDir, "game.zip");
    mkdirSync(installDir);
    writeFileSync(path.join(installDir, "game.exe"), "game");
    writeFileSync(archivePath, "archive");
    writeFileSync(`${archivePath}.part`, "partial");
    const database = makeDatabase();
    database.saveDownload({
      gameId: 1,
      url: "https://downloads.example/game.zip",
      status: "installed",
      archivePath,
      installDir,
      runAfter: false,
      selectedModIds: [],
    });
    const launcher = new Launcher(database);
    const library = new LibraryManager(database, launcher);

    await library.deleteGame(1);

    expect(existsSync(installDir)).toBe(false);
    expect(existsSync(archivePath)).toBe(false);
    expect(database.listLibrary()).toEqual([]);
    expect(database.listGames()[0].installDir).toBeNull();
    database.close();
  });

  it("does not delete an unrelated folder when the recorded install has no game launcher", async () => {
    const root = makeTempDirectory();
    const installDir = path.join(root, "unrelated");
    mkdirSync(installDir);
    const database = makeDatabase();
    database.saveDownload({
      gameId: 1,
      url: "https://downloads.example/game.zip",
      status: "installed",
      archivePath: path.join(installDir, "game.zip"),
      installDir,
      runAfter: false,
      selectedModIds: [],
    });
    const library = new LibraryManager(database, new Launcher(database));

    await expect(library.deleteGame(1)).resolves.toBeUndefined();
    expect(existsSync(installDir)).toBe(true);
    expect(database.getDownload(1)).toBeUndefined();
    expect(database.listLibrary()).toEqual([]);
    database.close();
  });

  it("deletes a renamed install when its recorded folder contains the game launcher", async () => {
    const root = makeTempDirectory();
    const installDir = path.join(root, "Sample Game");
    const archivePath = path.join(installDir, "game.zip");
    mkdirSync(installDir);
    writeFileSync(path.join(installDir, "game.exe"), "game");
    writeFileSync(archivePath, "archive");
    const database = makeDatabase();
    database.syncCatalog([{
      id: "69e2af3e-4128-4e15-95a0-b90e33ae11cd",
      name: "Sample Game",
      thumbnail: "",
      sizeBytes: null,
      lastUpdated: null,
      tags: [],
      description: "",
      releaseDate: null,
      detailsLastUpdated: null,
      developerLinks: {},
      version: null,
      operatingSystems: [],
      downloadLinks: {},
      mods: [],
    }]);
    database.saveDownload({
      gameId: 1,
      url: "https://downloads.example/game.zip",
      status: "installed",
      archivePath,
      installDir,
      runAfter: false,
      selectedModIds: [],
    });
    database.syncCatalog([{
      id: "69e2af3e-4128-4e15-95a0-b90e33ae11cd",
      name: "Renamed Game",
      thumbnail: "",
      sizeBytes: null,
      lastUpdated: null,
      tags: [],
      description: "",
      releaseDate: null,
      detailsLastUpdated: null,
      developerLinks: {},
      version: null,
      operatingSystems: [],
      downloadLinks: {},
      mods: [],
    }]);
    const library = new LibraryManager(database, new Launcher(database));

    await library.deleteGame(1);

    expect(existsSync(installDir)).toBe(false);
    expect(database.getDownload(1)).toBeUndefined();
    expect(database.listLibrary()).toEqual([]);
    database.close();
  });

  it("clears the installed record when the game folder is already missing", async () => {
    const root = makeTempDirectory();
    const installDir = path.join(root, "Sample Game");
    const database = makeDatabase();
    database.saveDownload({
      gameId: 1,
      url: "https://downloads.example/game.zip",
      status: "installed",
      archivePath: path.join(installDir, "game.zip"),
      installDir,
      runAfter: false,
      selectedModIds: [],
    });
    const library = new LibraryManager(database, new Launcher(database));

    await library.deleteGame(1);

    expect(database.getDownload(1)).toBeUndefined();
    expect(database.listLibrary()).toEqual([]);
    database.close();
  });

  it("clears a stale installed record if its launcher executable was removed", async () => {
    const root = makeTempDirectory();
    const installDir = path.join(root, "Sample Game");
    mkdirSync(installDir);
    writeFileSync(path.join(installDir, "game.zip"), "archive");
    const database = makeDatabase();
    database.saveDownload({
      gameId: 1,
      url: "https://downloads.example/game.zip",
      status: "installed",
      archivePath: path.join(installDir, "game.zip"),
      installDir,
      runAfter: false,
      selectedModIds: [],
    });
    const library = new LibraryManager(database, new Launcher(database));

    await library.deleteGame(1);

    expect(existsSync(installDir)).toBe(true);
    expect(database.getDownload(1)).toBeUndefined();
    expect(database.listLibrary()).toEqual([]);
    database.close();
  });
});

describe("download controls", () => {
  it("pauses, resumes, and cancels an active direct download", async () => {
    const database = makeDatabase();
    const directory = makeTempDirectory();
    const installDir = path.join(directory, "Sample Game");
    mkdirSync(installDir);
    database.saveDownload({
      gameId: 1,
      url: "https://downloads.example/game.zip",
      status: "downloading",
      archivePath: path.join(installDir, "game.zip"),
      installDir,
      runAfter: false,
      selectedModIds: [],
    });
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
    await manager.cancel(1);
    expect(database.getDownload(1)).toBeUndefined();
    expect(database.listDownloads()).toEqual([]);
    expect(requests[1]?.aborted).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    database.close();
  });

  it("removes a failed download and its partial archive without an active transfer", async () => {
    const database = makeDatabase();
    const directory = makeTempDirectory();
    const installDir = path.join(directory, "Sample Game");
    mkdirSync(installDir);
    const archivePath = path.join(installDir, "game.zip");
    writeFileSync(`${archivePath}.part`, "partial download");
    database.saveDownload({
      gameId: 1,
      url: "https://downloads.example/game.zip",
      status: "failed",
      archivePath,
      installDir,
      runAfter: false,
      selectedModIds: [],
      error: "The connection was interrupted.",
    });
    const manager = new DownloadManager(database, new Launcher(database));

    await expect(manager.cancel(1)).resolves.toBeUndefined();
    expect(database.getDownload(1)).toBeUndefined();
    expect(database.listDownloads()).toEqual([]);
    expect(existsSync(`${archivePath}.part`)).toBe(false);
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
    const observedPhases = new Set<string>();
    manager.onUpdate((update) => {
      if (update.phase) observedPhases.add(update.phase);
    });
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
    expect(observedPhases).toEqual(new Set([
      "extracting",
      "downloading-mod",
      "applying-mods",
      "finalizing",
    ]));
    const installedRoot = path.join(root, "Modded Game");
    const installedPatch = path.join(installedRoot, "game", "patch.rpy");
    expect(await import("node:fs/promises").then(({ readFile }) => readFile(installedPatch, "utf8"))).toBe("patched");
    const installedDirectMod = path.join(installedRoot, "mods", "Direct Fix.dll");
    expect(await import("node:fs/promises").then(({ readFile }) => readFile(installedDirectMod, "utf8"))).toBe("direct mod contents");
    expect(existsSync(path.join(installedRoot, "game.zip"))).toBe(true);
    expect(existsSync(path.join(installedRoot, "Patch.zip"))).toBe(true);
    expect(existsSync(path.join(installedRoot, "Direct Fix.dll"))).toBe(true);
    expect(existsSync(path.join(root, ".redline-downloads"))).toBe(false);
    database.close();
  });

  it("reuses an existing game archive in the game root without downloading it again", async () => {
    const root = makeTempDirectory();
    const installDir = path.join(root, "Sample Game");
    const source = path.join(root, "source");
    const modSource = path.join(root, "mod-source");
    mkdirSync(installDir);
    mkdirSync(source);
    mkdirSync(path.join(modSource, "patch", "game"), { recursive: true });
    writeFileSync(path.join(source, "game.exe"), "launcher");
    writeFileSync(path.join(modSource, "patch", "game", "patch.rpy"), "reused mod");
    const archivePath = path.join(installDir, "game.zip");
    const modArchivePath = path.join(installDir, "Patch.zip");
    execFileSync(path7za, ["a", archivePath, "game.exe"], {
      cwd: source,
      windowsHide: true,
    });
    execFileSync(path7za, ["a", modArchivePath, "patch"], {
      cwd: modSource,
      windowsHide: true,
    });
    const database = new LibraryDatabase(":memory:");
    database.seed(JSON.stringify([{
      name: "Sample Game",
      download_links: { direct_link: "https://downloads.example/game.zip" },
      mods: [{
        name: "Patch",
        download_links: { direct_link: "https://downloads.example/patch.zip" },
        steps_to_apply: [{
          type: "move",
          source_folder: "patch/game",
          target_folder: "%GAME_ROOT%/game",
        }],
      }],
    }]));
    const manager = new DownloadManager(database, new Launcher(database));
    const fetchMock = vi.fn().mockRejectedValue(new Error("Should use the existing archive."));
    vi.stubGlobal("fetch", fetchMock);

    await manager.start({
      gameId: 1,
      url: "https://downloads.example/game.zip",
      destination: root,
      runAfter: false,
      selectedModIds: [0],
    });
    await vi.waitFor(() => expect(database.getDownload(1)?.status).toBe("installed"));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(archivePath)).toBe(true);
    expect(existsSync(modArchivePath)).toBe(true);
    expect(existsSync(path.join(installDir, "game.exe"))).toBe(true);
    expect(await import("node:fs/promises").then(({ readFile }) =>
      readFile(path.join(installDir, "game", "patch.rpy"), "utf8"))).toBe("reused mod");
    database.close();
  });

  it("moves legacy game and mod archives out of the old hidden folder and reuses them", async () => {
    const root = makeTempDirectory();
    const installDir = path.join(root, "Sample Game");
    const legacyDirectory = path.join(root, ".redline-downloads");
    const gameSource = path.join(root, "game-source");
    const modSource = path.join(root, "mod-source");
    mkdirSync(gameSource);
    mkdirSync(path.join(modSource, "patch", "game"), { recursive: true });
    mkdirSync(path.join(legacyDirectory, "mods"), { recursive: true });
    writeFileSync(path.join(gameSource, "game.exe"), "launcher");
    writeFileSync(path.join(modSource, "patch", "game", "patch.rpy"), "migrated mod");
    const legacyArchive = path.join(legacyDirectory, "1.archive");
    execFileSync(path7za, ["a", "-tzip", legacyArchive, "game.exe"], {
      cwd: gameSource,
      windowsHide: true,
    });
    const legacyMod = path.join(legacyDirectory, "mods", "Patch.zip");
    execFileSync(path7za, ["a", legacyMod, "patch"], {
      cwd: modSource,
      windowsHide: true,
    });
    const database = new LibraryDatabase(":memory:");
    database.seed(JSON.stringify([{
      name: "Sample Game",
      download_links: { direct_link: "https://downloads.example/game.zip" },
      mods: [{
        name: "Patch",
        download_links: { direct_link: "https://downloads.example/patch.zip" },
        steps_to_apply: [{
          type: "move",
          source_folder: "patch/game",
          target_folder: "%GAME_ROOT%/game",
        }],
      }],
    }]));
    database.saveDownload({
      gameId: 1,
      url: "https://downloads.example/game.zip",
      status: "failed",
      archivePath: legacyArchive,
      installDir,
      runAfter: false,
      selectedModIds: [0],
    });
    const manager = new DownloadManager(database, new Launcher(database));
    const fetchMock = vi.fn().mockRejectedValue(new Error("Should reuse legacy archives."));
    vi.stubGlobal("fetch", fetchMock);

    await manager.start({
      gameId: 1,
      url: "https://downloads.example/game.zip",
      destination: root,
      runAfter: false,
      selectedModIds: [0],
    });
    await vi.waitFor(() => expect(database.getDownload(1)?.status).toBe("installed"));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(path.join(installDir, "game.zip"))).toBe(true);
    expect(existsSync(path.join(installDir, "Patch.zip"))).toBe(true);
    expect(existsSync(path.join(installDir, "game", "patch.rpy"))).toBe(true);
    expect(existsSync(legacyArchive)).toBe(false);
    expect(existsSync(legacyMod)).toBe(false);
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
    const modContents = path.join(sourceRoot, "DEAR-0.3-Joker WT Mod", "Optional", "game", "gui");
    mkdirSync(gameRoot);
    mkdirSync(modContents, { recursive: true });
    mkdirSync(path.join(gameRoot, "game", "gui"), { recursive: true });
    writeFileSync(path.join(gameRoot, "game", "existing.txt"), "base");
    writeFileSync(path.join(gameRoot, "game", "gui", "base.txt"), "base");
    writeFileSync(path.join(modContents, "base.txt"), "mod override");
    writeFileSync(path.join(modContents, "new.txt"), "new mod file");
    const archive = path.join(root, "gallery.zip");
    execFileSync(path7za, ["a", archive, "DEAR-0.3-Joker WT Mod"], {
      cwd: sourceRoot,
      windowsHide: true,
    });

    await applyModArchive(archive, {
      name: "Gallery Unlocker",
      download_links: { direct_link: "https://downloads.example/gallery.zip" },
      steps_to_apply: [{
        type: "move",
        source_folder: "DEAR-0.3-Joker WT Mod/Optional/game",
        target_folder: "%GAME_ROOT%/game",
      }],
    }, gameRoot);

    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path.join(gameRoot, "game", "gui", "base.txt"), "utf8")).toBe("mod override");
    expect(await readFile(path.join(gameRoot, "game", "gui", "new.txt"), "utf8")).toBe("new mod file");
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
