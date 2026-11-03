import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Download, DownloadStatus, Game, GameMod, InstalledGame } from "../../src/shared/types";

interface CatalogGame {
  name: string;
  thumbnail?: string;
  download_links?: Record<string, string>;
  mods?: GameMod[];
}

export class LibraryDatabase {
  private readonly db: Database.Database;

  constructor(databasePath: string, catalogPath?: string) {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        thumbnail TEXT NOT NULL DEFAULT '',
        download_links TEXT NOT NULL DEFAULT '{}',
        mods TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS downloads (
        game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('downloading','paused','cancelled','failed','installed')),
        bytes_downloaded INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER,
        archive_path TEXT NOT NULL,
        install_dir TEXT NOT NULL,
        run_after INTEGER NOT NULL DEFAULT 0,
        selected_mods TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const downloadColumns = this.db.prepare("PRAGMA table_info(downloads)").all() as Array<{ name: string }>;
    if (!downloadColumns.some((column) => column.name === "url")) {
      this.db.exec("ALTER TABLE downloads ADD COLUMN url TEXT NOT NULL DEFAULT ''");
    }
    if (!downloadColumns.some((column) => column.name === "selected_mods")) {
      this.db.exec("ALTER TABLE downloads ADD COLUMN selected_mods TEXT NOT NULL DEFAULT '[]'");
    }
    if (catalogPath) this.seed(readFileSync(catalogPath, "utf8"));
  }

  seed(json: string): void {
    const catalog: unknown = JSON.parse(json);
    if (!Array.isArray(catalog)) throw new Error("The game catalog must be a JSON array.");
    const insert = this.db.prepare(`
      INSERT INTO games (name, thumbnail, download_links, mods)
      VALUES (@name, @thumbnail, @downloadLinks, @mods)
      ON CONFLICT(name) DO UPDATE SET
        thumbnail=excluded.thumbnail,
        download_links=excluded.download_links,
        mods=excluded.mods
    `);
    const transaction = this.db.transaction((entries: unknown[]) => {
      for (const entry of entries) {
        if (!entry || typeof entry !== "object" || !("name" in entry) || typeof entry.name !== "string" || !entry.name.trim()) {
          throw new Error("Every game in the catalog must have a non-empty name.");
        }
        const game = entry as CatalogGame;
        const links = game.download_links ?? {};
        if (!links || typeof links !== "object" || Array.isArray(links) ||
            Object.values(links).some((url) => typeof url !== "string")) {
          throw new Error(`Invalid download links for ${game.name}.`);
        }
        insert.run({
          name: game.name.trim(),
          thumbnail: typeof game.thumbnail === "string" ? game.thumbnail : "",
          downloadLinks: JSON.stringify(links),
          mods: JSON.stringify(normalizeMods(game.mods, game.name)),
        });
      }
    });
    transaction(catalog);
  }

  listGames(): Game[] {
    return this.db.prepare(`
      SELECT g.id, g.name, g.thumbnail, g.download_links AS downloadLinks,
        g.mods, d.install_dir AS installDir
      FROM games g LEFT JOIN downloads d
        ON d.game_id=g.id AND d.status='installed'
      ORDER BY g.id
    `).all().map((row) => {
      const game = row as {
        id: number; name: string; thumbnail: string;
        downloadLinks: string; mods: string; installDir: string | null;
      };
      return {
        id: game.id,
        name: game.name,
        thumbnail: game.thumbnail,
        downloadLinks: JSON.parse(game.downloadLinks) as Record<string, string>,
        mods: JSON.parse(game.mods) as GameMod[],
        installDir: game.installDir,
      };
    });
  }

  getGame(gameId: number): Game | undefined {
    return this.listGames().find((game) => game.id === gameId);
  }

  listDownloads(): Download[] {
    return this.db.prepare(`
      SELECT d.game_id AS gameId, g.name AS gameName, g.thumbnail,
        d.status, d.bytes_downloaded AS bytesDownloaded,
        d.total_bytes AS totalBytes, d.error, d.install_dir AS installDir
      FROM downloads d JOIN games g ON g.id=d.game_id
      WHERE d.status != 'installed'
      ORDER BY d.updated_at DESC
    `).all() as Download[];
  }

  listLibrary(runningIds: ReadonlySet<number> = new Set()): InstalledGame[] {
    const installed = this.db.prepare(`
      SELECT g.id, g.name, g.thumbnail, g.download_links AS downloadLinks,
        g.mods, d.install_dir AS installDir
      FROM downloads d JOIN games g ON g.id=d.game_id
      WHERE d.status='installed'
      ORDER BY g.name COLLATE NOCASE
    `).all() as Array<Omit<Game, "downloadLinks" | "mods"> & {
      downloadLinks: string;
      mods: string;
      installDir: string | null;
    }>;
    return installed
      .filter((game): game is typeof game & { installDir: string } => game.installDir !== null)
      .map((game) => ({
      ...game,
      downloadLinks: JSON.parse(game.downloadLinks) as Record<string, string>,
      mods: JSON.parse(game.mods) as GameMod[],
      running: runningIds.has(game.id),
      }));
  }

  getDownload(gameId: number): (Download & {
    archivePath: string;
    url: string;
    runAfter: boolean;
    selectedModIds: number[];
  }) | undefined {
    const row = this.db.prepare(`
      SELECT d.game_id AS gameId, g.name AS gameName, g.thumbnail,
        d.status, d.bytes_downloaded AS bytesDownloaded,
        d.total_bytes AS totalBytes, d.error, d.install_dir AS installDir,
        d.archive_path AS archivePath, d.url, d.run_after AS runAfter,
        d.selected_mods AS selectedMods
      FROM downloads d JOIN games g ON g.id=d.game_id
      WHERE d.game_id=?
    `).get(gameId) as (Download & {
      archivePath: string;
      url: string;
      runAfter: number;
      selectedMods: string;
    }) | undefined;
    return row ? {
      ...row,
      runAfter: row.runAfter === 1,
      selectedModIds: JSON.parse(row.selectedMods) as number[],
    } : undefined;
  }

  saveDownload(download: {
    gameId: number;
    url: string;
    status: DownloadStatus;
    archivePath: string;
    installDir: string;
    runAfter: boolean;
    selectedModIds?: number[];
    bytesDownloaded?: number;
    totalBytes?: number | null;
    error?: string | null;
  }): void {
    this.db.prepare(`
      INSERT INTO downloads
        (game_id,url,status,bytes_downloaded,total_bytes,archive_path,install_dir,run_after,selected_mods,error,updated_at)
      VALUES (@gameId,@url,@status,@bytesDownloaded,@totalBytes,@archivePath,@installDir,@runAfter,@selectedMods,@error,CURRENT_TIMESTAMP)
      ON CONFLICT(game_id) DO UPDATE SET
        url=excluded.url,
        status=excluded.status,
        bytes_downloaded=excluded.bytes_downloaded,
        total_bytes=excluded.total_bytes,
        archive_path=excluded.archive_path,
        install_dir=excluded.install_dir,
        run_after=excluded.run_after,
        selected_mods=excluded.selected_mods,
        error=excluded.error,
        updated_at=CURRENT_TIMESTAMP
    `).run({
      ...download,
      bytesDownloaded: download.bytesDownloaded ?? 0,
      totalBytes: download.totalBytes ?? null,
      runAfter: download.runAfter ? 1 : 0,
      selectedMods: JSON.stringify(download.selectedModIds ?? []),
      error: download.error ?? null,
    });
  }

  updateDownload(
    gameId: number,
    patch: Partial<Pick<Download, "status" | "bytesDownloaded" | "totalBytes" | "error">>,
  ): void {
    const current = this.getDownload(gameId);
    if (!current) throw new Error("Download not found.");
    if (patch.status && !canTransition(current.status, patch.status)) {
      throw new Error(`Invalid download status transition: ${current.status} -> ${patch.status}.`);
    }
    this.saveDownload({ ...current, ...patch });
  }

  close(): void {
    this.db.close();
  }

  recoverInterruptedDownloads(): void {
    this.db.prepare(`
      UPDATE downloads
      SET status='failed', error='The app closed before this download finished.',
          updated_at=CURRENT_TIMESTAMP
      WHERE status IN ('downloading','paused')
    `).run();
  }
}

function normalizeMods(value: unknown, gameName: string): GameMod[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`The mods list for ${gameName} must be an array.`);
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Mod ${index + 1} for ${gameName} must be an object.`);
    }
    const mod = entry as Partial<GameMod>;
    const links = mod.download_links ?? {};
    if (!mod.name || typeof mod.name !== "string" ||
        !links || typeof links !== "object" || Array.isArray(links) ||
        Object.values(links).some((url) => typeof url !== "string")) {
      throw new Error(`Mod ${index + 1} for ${gameName} has invalid name or download links.`);
    }
    const steps = mod.steps_to_apply ?? [];
    if (!Array.isArray(steps) || steps.some((step) =>
      !step || !["extract", "move"].includes(step.type) ||
      typeof step.target_folder !== "string" ||
      (step.source_folder !== undefined && typeof step.source_folder !== "string"),
    )) {
      throw new Error(`Mod ${mod.name} for ${gameName} has invalid apply steps.`);
    }
    return {
      name: mod.name,
      download_links: { ...links },
      steps_to_apply: steps.map((step) => ({ ...step })),
    };
  });
}

export function canTransition(from: DownloadStatus, to: DownloadStatus): boolean {
  if (from === to) return true;
  const allowed: Record<DownloadStatus, DownloadStatus[]> = {
    downloading: ["paused", "cancelled", "failed", "installed"],
    paused: ["downloading", "cancelled", "failed"],
    cancelled: ["downloading"],
    failed: ["downloading", "cancelled"],
    installed: ["downloading"],
  };
  return allowed[from].includes(to);
}
