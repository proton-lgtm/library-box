import Database from "better-sqlite3";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Download, DownloadPhase, DownloadStatus, Game, GameMod, InstalledGame } from "../../src/shared/types";

export interface CatalogEntry {
  id: string;
  name: string;
  thumbnail: string;
  sizeBytes: number | null;
  lastUpdated: string | null;
  tags: string[];
  description: string;
  releaseDate: string | null;
  detailsLastUpdated: string | null;
  developerLinks: Record<string, string>;
  version: string | null;
  operatingSystems: string[];
  downloadLinks: Record<string, string>;
  mods: GameMod[];
}

interface GameDatabaseRow {
  id: number;
  supabase_id: string | null;
  name: string;
  thumbnail: string;
  size_bytes: number | null;
  last_updated: string | null;
  tags: string;
  description: string;
  release_date: string | null;
  details_last_updated: string | null;
  developer_links: string;
  version: string | null;
  operating_systems: string;
  download_links: string;
  mods: string;
  installDir?: string | null;
  gameRoot?: string | null;
  appliedMods?: string;
}

export class LibraryDatabase {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY,
        supabase_id TEXT,
        name TEXT NOT NULL UNIQUE,
        thumbnail TEXT NOT NULL DEFAULT '',
        size_bytes INTEGER,
        last_updated TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        description TEXT NOT NULL DEFAULT '',
        release_date TEXT,
        details_last_updated TEXT,
        developer_links TEXT NOT NULL DEFAULT '{}',
        version TEXT,
        operating_systems TEXT NOT NULL DEFAULT '[]',
        download_links TEXT NOT NULL DEFAULT '{}',
        mods TEXT NOT NULL DEFAULT '[]',
        catalog_available INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS downloads (
        game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('downloading','paused','cancelled','failed','installed')),
        bytes_downloaded INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER,
        phase TEXT,
        phase_detail TEXT,
        archive_path TEXT NOT NULL,
        install_dir TEXT NOT NULL,
        game_root TEXT,
        run_after INTEGER NOT NULL DEFAULT 0,
        selected_mods TEXT NOT NULL DEFAULT '[]',
        applied_mods TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS catalog_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.addMissingGameColumns();
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS games_supabase_id_idx
      ON games(supabase_id) WHERE supabase_id IS NOT NULL;
    `);
    const downloadColumns = this.db.prepare("PRAGMA table_info(downloads)").all() as Array<{ name: string }>;
    if (!downloadColumns.some((column) => column.name === "url")) {
      this.db.exec("ALTER TABLE downloads ADD COLUMN url TEXT NOT NULL DEFAULT ''");
    }
    if (!downloadColumns.some((column) => column.name === "selected_mods")) {
      this.db.exec("ALTER TABLE downloads ADD COLUMN selected_mods TEXT NOT NULL DEFAULT '[]'");
    }
    if (!downloadColumns.some((column) => column.name === "phase")) {
      this.db.exec("ALTER TABLE downloads ADD COLUMN phase TEXT");
    }
    if (!downloadColumns.some((column) => column.name === "phase_detail")) {
      this.db.exec("ALTER TABLE downloads ADD COLUMN phase_detail TEXT");
    }
    if (!downloadColumns.some((column) => column.name === "game_root")) {
      this.db.exec("ALTER TABLE downloads ADD COLUMN game_root TEXT");
    }
    if (!downloadColumns.some((column) => column.name === "applied_mods")) {
      this.db.exec("ALTER TABLE downloads ADD COLUMN applied_mods TEXT NOT NULL DEFAULT '[]'");
    }
  }

  private addMissingGameColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(games)").all() as Array<{ name: string }>;
    const existing = new Set(columns.map((column) => column.name));
    const additions: Record<string, string> = {
      supabase_id: "TEXT",
      size_bytes: "INTEGER",
      last_updated: "TEXT",
      tags: "TEXT NOT NULL DEFAULT '[]'",
      description: "TEXT NOT NULL DEFAULT ''",
      release_date: "TEXT",
      details_last_updated: "TEXT",
      developer_links: "TEXT NOT NULL DEFAULT '{}'",
      version: "TEXT",
      operating_systems: "TEXT NOT NULL DEFAULT '[]'",
      catalog_available: "INTEGER NOT NULL DEFAULT 1",
    };
    for (const [name, definition] of Object.entries(additions)) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE games ADD COLUMN ${name} ${definition}`);
    }
  }

  seed(json: string): void {
    const catalog: unknown = JSON.parse(json);
    if (!Array.isArray(catalog)) throw new Error("The game catalog must be a JSON array.");
    const insert = this.db.prepare(`
      INSERT INTO games (name, thumbnail, download_links, mods, catalog_available)
      VALUES (@name, @thumbnail, @downloadLinks, @mods, 1)
      ON CONFLICT(name) DO UPDATE SET
        thumbnail=excluded.thumbnail,
        download_links=excluded.download_links,
        mods=excluded.mods,
        catalog_available=1
    `);
    const transaction = this.db.transaction((entries: unknown[]) => {
      for (const entry of entries) {
        if (!entry || typeof entry !== "object" || !("name" in entry) || typeof entry.name !== "string" || !entry.name.trim()) {
          throw new Error("Every game in the catalog must have a non-empty name.");
        }
        const game = entry as { name: string; thumbnail?: string; download_links?: Record<string, string>; mods?: GameMod[] };
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

  syncCatalog(entries: CatalogEntry[], syncedAt = new Date().toISOString()): void {
    const markUnavailable = this.db.prepare("UPDATE games SET catalog_available=0");
    const findExisting = this.db.prepare(`
      SELECT id FROM games
      WHERE supabase_id=@id OR (supabase_id IS NULL AND name=@name)
      ORDER BY CASE WHEN supabase_id=@id THEN 0 ELSE 1 END
      LIMIT 1
    `);
    const findNameConflict = this.db.prepare(`
      SELECT id FROM games
      WHERE name=@name AND (@localId IS NULL OR id<>@localId)
      LIMIT 1
    `);
    const nameExists = this.db.prepare("SELECT 1 FROM games WHERE name=?");
    const archiveLocalConflict = this.db.prepare(`
      UPDATE games SET name=@archivedName, catalog_available=0
      WHERE id=@conflictId
    `);
    const insert = this.db.prepare(`
      INSERT INTO games (
        supabase_id, name, thumbnail, size_bytes, last_updated, tags,
        description, release_date, details_last_updated, developer_links,
        version, operating_systems, download_links, mods, catalog_available
      ) VALUES (
        @id, @name, @thumbnail, @sizeBytes, @lastUpdated, @tags,
        @description, @releaseDate, @detailsLastUpdated, @developerLinks,
        @version, @operatingSystems, @downloadLinks, @mods, 1
      )
    `);
    const update = this.db.prepare(`
      UPDATE games SET
        supabase_id=@id, name=@name, thumbnail=@thumbnail, size_bytes=@sizeBytes,
        last_updated=@lastUpdated, tags=@tags, description=@description,
        release_date=@releaseDate, details_last_updated=@detailsLastUpdated,
        developer_links=@developerLinks, version=@version,
        operating_systems=@operatingSystems, download_links=@downloadLinks,
        mods=@mods, catalog_available=1
      WHERE id=@localId
    `);
    const transaction = this.db.transaction((games: CatalogEntry[]) => {
      markUnavailable.run();
      for (const game of games) {
        const existing = findExisting.get({ id: game.id, name: game.name }) as { id: number } | undefined;
        const conflict = findNameConflict.get({
          name: game.name,
          localId: existing?.id ?? null,
        }) as { id: number } | undefined;
        if (conflict) {
          const baseName = `${game.name} (local record ${conflict.id})`;
          let archivedName = baseName;
          let suffix = 2;
          while (nameExists.get(archivedName)) {
            archivedName = `${baseName} ${suffix}`;
            suffix += 1;
          }
          archiveLocalConflict.run({ archivedName, conflictId: conflict.id });
        }
        const values = {
          ...game,
          tags: JSON.stringify(game.tags),
          developerLinks: JSON.stringify(game.developerLinks),
          operatingSystems: JSON.stringify(game.operatingSystems),
          downloadLinks: JSON.stringify(game.downloadLinks),
          mods: JSON.stringify(normalizeMods(game.mods, game.name)),
        };
        if (existing) update.run({ ...values, localId: existing.id });
        else insert.run(values);
      }
      this.db.prepare(`
        INSERT INTO catalog_state (key, value) VALUES ('last_synced_at', ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `).run(syncedAt);
    });
    transaction(entries);
  }

  getCatalogLastSyncedAt(): string | null {
    const state = this.db.prepare(
      "SELECT value FROM catalog_state WHERE key='last_synced_at'",
    ).get() as { value: string } | undefined;
    return state?.value ?? null;
  }

  listGames(): Game[] {
    this.reconcileMissingInstallations();
    return this.db.prepare(`
      SELECT g.*, d.install_dir AS installDir
      FROM games g LEFT JOIN downloads d
        ON d.game_id=g.id AND d.status='installed'
      WHERE g.catalog_available=1
      ORDER BY g.id
    `).all().map((row) => mapGameRow(row as GameDatabaseRow));
  }

  getGame(gameId: number): Game | undefined {
    const row = this.db.prepare("SELECT * FROM games WHERE id=?").get(gameId) as GameDatabaseRow | undefined;
    return row ? mapGameRow(row) : undefined;
  }

  listDownloads(): Download[] {
    return this.db.prepare(`
      SELECT d.game_id AS gameId, g.name AS gameName, g.thumbnail,
        d.status, d.bytes_downloaded AS bytesDownloaded,
        d.total_bytes AS totalBytes, g.size_bytes AS expectedBytes,
        d.error, d.install_dir AS installDir,
        d.phase, d.phase_detail AS phaseDetail
      FROM downloads d JOIN games g ON g.id=d.game_id
      WHERE d.status != 'installed'
      ORDER BY d.updated_at DESC
    `).all() as Download[];
  }

  listLibrary(runningIds: ReadonlySet<number> = new Set()): InstalledGame[] {
    this.reconcileMissingInstallations();
    const installed = this.db.prepare(`
      SELECT g.*, d.install_dir AS installDir,
        d.game_root AS gameRoot, d.applied_mods AS appliedMods
      FROM downloads d JOIN games g ON g.id=d.game_id
      WHERE d.status='installed'
      ORDER BY g.name COLLATE NOCASE
    `).all() as GameDatabaseRow[];
    return installed
      .filter((game): game is typeof game & { installDir: string } => game.installDir !== null)
      .map((game) => ({
        ...mapGameRow(game),
        installDir: game.installDir as string,
        gameRoot: game.gameRoot ?? game.installDir as string,
        appliedModIds: JSON.parse(game.appliedMods ?? "[]") as number[],
        running: runningIds.has(game.id),
      }));
  }

  removeInstalledGame(gameId: number): void {
    const result = this.db.prepare(
      "DELETE FROM downloads WHERE game_id=? AND status='installed'",
    ).run(gameId);
    if (result.changes !== 1) throw new Error("Installed game record was not found.");
  }

  removeCancelledDownload(gameId: number): void {
    const result = this.db.prepare(
      "DELETE FROM downloads WHERE game_id=? AND status='cancelled'",
    ).run(gameId);
    if (result.changes !== 1) throw new Error("Cancelled download was not found.");
  }

  private reconcileMissingInstallations(): void {
    const installed = this.db.prepare(
      "SELECT game_id AS gameId, install_dir AS installDir FROM downloads WHERE status='installed'",
    ).all() as Array<{ gameId: number; installDir: string }>;
    for (const game of installed) {
      try {
        if (!statSync(game.installDir).isDirectory()) this.removeInstalledGame(game.gameId);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          this.removeInstalledGame(game.gameId);
        } else {
          throw error;
        }
      }
    }
  }

  getDownload(gameId: number): (Download & {
    archivePath: string;
    url: string;
    runAfter: boolean;
    selectedModIds: number[];
    gameRoot: string;
    appliedModIds: number[];
  }) | undefined {
    const row = this.db.prepare(`
      SELECT d.game_id AS gameId, g.name AS gameName, g.thumbnail,
        d.status, d.bytes_downloaded AS bytesDownloaded,
        d.total_bytes AS totalBytes, d.error, d.install_dir AS installDir,
        d.phase, d.phase_detail AS phaseDetail,
        d.archive_path AS archivePath, d.url, d.run_after AS runAfter,
        d.selected_mods AS selectedMods, d.game_root AS gameRoot,
        d.applied_mods AS appliedMods
      FROM downloads d JOIN games g ON g.id=d.game_id
      WHERE d.game_id=?
    `).get(gameId) as (Download & {
      archivePath: string;
      url: string;
      runAfter: number;
      selectedMods: string;
      gameRoot: string | null;
      appliedMods: string;
      phase: DownloadPhase | null;
      phaseDetail: string | null;
    }) | undefined;
    return row ? {
      ...row,
      runAfter: row.runAfter === 1,
      selectedModIds: JSON.parse(row.selectedMods) as number[],
      gameRoot: row.gameRoot ?? row.installDir,
      appliedModIds: JSON.parse(row.appliedMods) as number[],
      phase: row.phase as DownloadPhase | null,
      phaseDetail: row.phaseDetail,
    } : undefined;
  }

  saveDownload(download: {
    gameId: number;
    url: string;
    status: DownloadStatus;
    archivePath: string;
    installDir: string;
    gameRoot?: string;
    runAfter: boolean;
    selectedModIds?: number[];
    appliedModIds?: number[];
    bytesDownloaded?: number;
    totalBytes?: number | null;
    error?: string | null;
    phase?: DownloadPhase | null;
    phaseDetail?: string | null;
  }): void {
    this.db.prepare(`
      INSERT INTO downloads
        (game_id,url,status,bytes_downloaded,total_bytes,phase,phase_detail,archive_path,install_dir,game_root,run_after,selected_mods,applied_mods,error,updated_at)
      VALUES (@gameId,@url,@status,@bytesDownloaded,@totalBytes,@phase,@phaseDetail,@archivePath,@installDir,@gameRoot,@runAfter,@selectedMods,@appliedMods,@error,CURRENT_TIMESTAMP)
      ON CONFLICT(game_id) DO UPDATE SET
        url=excluded.url,
        status=excluded.status,
        bytes_downloaded=excluded.bytes_downloaded,
        total_bytes=excluded.total_bytes,
        phase=excluded.phase,
        phase_detail=excluded.phase_detail,
        archive_path=excluded.archive_path,
        install_dir=excluded.install_dir,
        game_root=excluded.game_root,
        run_after=excluded.run_after,
        selected_mods=excluded.selected_mods,
        applied_mods=excluded.applied_mods,
        error=excluded.error,
        updated_at=CURRENT_TIMESTAMP
    `).run({
      ...download,
      bytesDownloaded: download.bytesDownloaded ?? 0,
      totalBytes: download.totalBytes ?? null,
      phase: download.phase ?? null,
      phaseDetail: download.phaseDetail ?? null,
      gameRoot: download.gameRoot ?? download.installDir,
      runAfter: download.runAfter ? 1 : 0,
      selectedMods: JSON.stringify(download.selectedModIds ?? []),
      appliedMods: JSON.stringify(download.appliedModIds ?? []),
      error: download.error ?? null,
    });
  }

  updateDownload(
    gameId: number,
    patch: Partial<Pick<Download, "status" | "bytesDownloaded" | "totalBytes" | "error" | "phase" | "phaseDetail">> &
      Partial<Pick<InstalledGame, "gameRoot" | "appliedModIds">>,
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
      SET status='failed', phase=NULL, phase_detail=NULL,
          error='The app closed before this download finished.',
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
      ...(typeof mod.file_type === "string" ? { file_type: mod.file_type } : {}),
    };
  });
}

function mapGameRow(row: GameDatabaseRow): Game {
  return {
    id: row.id,
    supabaseId: row.supabase_id,
    name: row.name,
    thumbnail: row.thumbnail,
    sizeBytes: row.size_bytes,
    lastUpdated: row.last_updated,
    tags: JSON.parse(row.tags) as string[],
    description: row.description,
    releaseDate: row.release_date,
    detailsLastUpdated: row.details_last_updated,
    developerLinks: JSON.parse(row.developer_links) as Record<string, string>,
    version: row.version,
    operatingSystems: JSON.parse(row.operating_systems) as string[],
    downloadLinks: JSON.parse(row.download_links) as Record<string, string>,
    mods: JSON.parse(row.mods) as GameMod[],
    installDir: row.installDir ?? null,
  };
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
