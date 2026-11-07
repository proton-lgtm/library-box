import { BrowserWindow, session, type DownloadItem } from "electron";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { lstat, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import type {
  DownloadQueueItem,
  DownloadQueueStatus,
  DownloadUpdate,
  Game,
  GameDownloadRecord,
  GameMod,
  ModDownloadQueueItem,
  StartDownloadInput,
} from "../../../src/shared/types";
import { extractArchive, findGameRootInArchive } from "../archive";
import type { LibraryDatabase } from "../database";
import { findGameLauncher, type Launcher } from "../launcher";
import { applyModArchive } from "./mod-installer";

interface Transfer {
  controller?: AbortController;
  browser?: BrowserWindow;
  item?: DownloadItem;
  completion?: Promise<void>;
}

interface ModJob {
  item: ModDownloadQueueItem;
  gameRoot?: string;
  cancelled: boolean;
  manualBrowser?: boolean;
}

class ModCancelledError extends Error {
  constructor() {
    super("Mod download was cancelled.");
  }
}

function safeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Download URL is invalid.");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new Error("Downloads must use a valid HTTPS URL.");
  }
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") ||
    url.hostname === "127.0.0.1" || url.hostname === "::1") {
    throw new Error("Downloads cannot target a local host.");
  }
  return url;
}

function safeFolderName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").trim() || "game";
}

function gameFolderName(game: Pick<Game, "id" | "name" | "supabaseId">): string {
  const name = game.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "game";
  if (!game.supabaseId) return safeFolderName(game.name);
  const guidPrefix = game.supabaseId.replace(/-/g, "").slice(0, 8);
  return `${name}_${guidPrefix}`;
}

export function isBrowserHost(url: URL): boolean {
  return url.hostname === "gofile.io" || url.hostname.endsWith(".gofile.io") ||
    url.hostname === "workupload.com" || url.hostname.endsWith(".workupload.com") ||
    url.hostname === "bzzhr.to" || url.hostname.endsWith(".bzzhr.to") ||
    url.hostname === "buzzheavier.com" || url.hostname.endsWith(".buzzheavier.com");
}

const DOWNLOAD_BROWSER_PARTITION = "persist:download-browser";
const STORAGE_PERMISSIONS = new Set([
  "persistent-storage",
  "storage-access",
  "top-level-storage-access",
]);
function isTrustedBrowserPage(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && isBrowserHost(url);
  } catch {
    return false;
  }
}

function isSecureOrigin(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    return new URL(rawUrl).protocol === "https:";
  } catch {
    return false;
  }
}

export function configureDownloadBrowserSession(): void {
  const browserSession = session.fromPartition(DOWNLOAD_BROWSER_PARTITION);
  browserSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return STORAGE_PERMISSIONS.has(permission) &&
      webContents !== null &&
      isTrustedBrowserPage(webContents.getURL()) &&
      isSecureOrigin(requestingOrigin);
  });
  browserSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const allowed = STORAGE_PERMISSIONS.has(permission) &&
      isTrustedBrowserPage(webContents.getURL()) &&
      isSecureOrigin(details.requestingUrl);
    callback(allowed);
  });
}

function downloadBrowserPreferences(): Electron.WebPreferences {
  return {
    partition: DOWNLOAD_BROWSER_PARTITION,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

function resolveDirectUrl(url: URL): URL {
  const pixeldrain = url.hostname === "pixeldrain.com" || url.hostname === "www.pixeldrain.com";
  const match = pixeldrain && url.pathname.match(/^\/(?:u|d)\/([a-zA-Z0-9]+)\/?$/);
  return match ? new URL(`/api/file/${match[1]}`, "https://pixeldrain.com") : url;
}

function isSafeRedirectUrl(raw: string): URL {
  return safeUrl(raw);
}

function validateDestination(inputPath: string): string {
  if (!path.isAbsolute(inputPath) || inputPath.includes("\0")) {
    throw new Error("Choose an absolute destination folder.");
  }
  const resolved = path.resolve(inputPath);
  const root = path.parse(resolved).root;
  if (resolved === root || !existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error("The selected destination must be an existing folder.");
  }
  return resolved;
}

function preferredModUrl(mod: GameMod): string | undefined {
  for (const key of ["direct_link", "pixeldrain", "gofile", "workupload", "patreon", "mixdrop", "direct"]) {
    if (mod.download_links[key]) return mod.download_links[key];
  }
  return Object.values(mod.download_links)[0];
}

function isDirectFileMod(mod: GameMod): boolean {
  return mod.asset_type === "file";
}

function safeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").trim() || "mod";
}

function archiveExtension(url: URL): string {
  const extension = path.extname(url.pathname).toLowerCase();
  return [".zip", ".7z", ".rar"].includes(extension) ? extension : ".zip";
}

function modFileExtension(mod: GameMod, url: URL): string {
  const extension = path.extname(url.pathname).toLowerCase();
  return isDirectFileMod(mod) ? extension || ".bin" : archiveExtension(url);
}

function findExistingGameArchive(installDir: string, preferredPath: string): string | undefined {
  const candidates = [
    preferredPath,
    ...[".zip", ".7z", ".rar"].map((extension) => path.join(installDir, `game${extension}`)),
  ];
  return candidates.find((candidate, index) =>
    candidates.indexOf(candidate) === index &&
    existsSync(candidate) &&
    statSync(candidate).isFile(),
  );
}

async function archiveHasSupportedSignature(archivePath: string): Promise<boolean> {
  return (await getArchiveExtension(archivePath)) !== undefined;
}

async function getArchiveExtension(archivePath: string): Promise<string | undefined> {
  const signature = new Uint8Array(8);
  const fileHandle = await open(archivePath, "r");
  try {
    await fileHandle.read(signature, 0, signature.length, 0);
  } finally {
    await fileHandle.close();
  }
  if (signature[0] === 0x50 && signature[1] === 0x4b) return ".zip";
  if ([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c].every((byte, index) => signature[index] === byte)) return ".7z";
  if ([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07].every((byte, index) => signature[index] === byte) &&
    [0x00, 0x01].includes(signature[6])) return ".rar";
  return undefined;
}

function finishWriteStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      stream.removeListener("finish", onFinish);
      reject(error);
    };
    const onFinish = () => {
      stream.removeListener("error", onError);
      resolve();
    };
    stream.once("error", onError);
    stream.once("finish", onFinish);
    stream.end();
  });
}

async function assertRegularDirectory(directory: string): Promise<void> {
  try {
    const details = await lstat(directory);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error("A legacy download folder is not a regular directory.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export class DownloadManager {
  private readonly transfers = new Map<number, Transfer>();
  private readonly listeners = new Set<(update: DownloadUpdate) => void>();
  private readonly modJobs = new Map<string, ModJob>();
  private readonly completedGames = new Map<number, DownloadQueueItem>();
  private activeModId: string | undefined;

  constructor(
    private readonly database: LibraryDatabase,
    private readonly launcher: Launcher,
  ) { }

  onUpdate(listener: (update: DownloadUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listQueue(): DownloadQueueItem[] {
    const games = this.database.listDownloads()
      .filter((record) => !this.completedGames.has(record.gameId))
      .map((record) => this.gameQueueItem(record));
    return [
      ...games,
      ...Array.from(this.modJobs.values(), (job) => ({ ...job.item })),
      ...Array.from(this.completedGames.values(), (item) => ({ ...item })),
    ].sort((left, right) => left.gameId - right.gameId ||
      (left.kind === right.kind
        ? left.kind === "mod" && right.kind === "mod" ? left.modId - right.modId : 0
        : left.kind === "game" ? -1 : 1));
  }

  dismissTerminalDownload(gameId: number): void {
    const item = this.listQueue().find((entry) => entry.kind === "game" && entry.gameId === gameId);
    if (!item || !this.isTerminalGameQueueItem(item)) {
      throw new Error("Only completed or cancelled downloads can be dismissed.");
    }
    this.removeTerminalDownload(gameId, item.status);
  }

  clearTerminalDownloads(): void {
    const terminalGames = this.listQueue().filter((item) =>
      item.kind === "game" && this.isTerminalGameQueueItem(item));
    for (const item of terminalGames) this.removeTerminalDownload(item.gameId, item.status);
  }

  private isTerminalGameQueueItem(item: DownloadQueueItem): boolean {
    if (item.kind !== "game" || !["completed", "cancelled"].includes(item.status)) return false;
    return Array.from(this.modJobs.values()).every((job) =>
      job.item.gameId !== item.gameId || ["completed", "failed", "cancelled"].includes(job.item.status));
  }

  removeGameQueueHistory(gameId: number): void {
    this.completedGames.delete(gameId);
    for (const [id, job] of this.modJobs) {
      if (job.item.gameId === gameId) this.modJobs.delete(id);
    }
  }

  private removeTerminalDownload(gameId: number, status: DownloadQueueStatus): void {
    if (status === "cancelled" && this.database.getDownload(gameId)?.status === "cancelled") {
      this.database.removeCancelledDownload(gameId);
    }
    this.removeGameQueueHistory(gameId);
  }

  private gameQueueItem(record: GameDownloadRecord, status?: DownloadQueueStatus): DownloadQueueItem {
    const queueStatus = status ?? (record.status === "installed"
      ? "completed"
      : record.phase && record.phase !== "downloading-mod"
        ? "applying"
        : record.status);
    return {
      id: `game:${record.gameId}`,
      kind: "game",
      gameId: record.gameId,
      gameName: record.gameName,
      thumbnail: record.thumbnail,
      status: queueStatus,
      bytesDownloaded: record.bytesDownloaded,
      totalBytes: record.totalBytes,
      expectedBytes: record.expectedBytes ?? null,
      error: record.error,
      phase: record.phase ?? null,
      detail: record.phaseDetail ?? null,
      phaseDetail: record.phaseDetail ?? null,
      installDir: record.installDir,
    };
  }

  private enqueueMods(game: Game, installDir: string, modIds: number[]): void {
    for (const modId of modIds) {
      const id = `mod:${game.id}:${modId}`;
      this.modJobs.set(id, {
        cancelled: false,
        item: {
          id,
          kind: "mod",
          gameId: game.id,
          gameName: game.name,
          thumbnail: game.thumbnail,
          modId,
          modName: game.mods[modId].name,
          status: "waiting",
          bytesDownloaded: 0,
          totalBytes: null,
          error: null,
          phase: "downloading-mod",
          detail: game.mods[modId].name,
          phaseDetail: game.mods[modId].name,
          installDir,
        },
      });
      this.emitItem(this.modJobs.get(id)!.item);
    }
  }

  private updateMod(id: string, patch: Partial<ModDownloadQueueItem>): void {
    const job = this.modJobs.get(id);
    if (!job) return;
    Object.assign(job.item, patch);
    this.emitItem(job.item);
  }

  private emitItem(item: DownloadQueueItem): void {
    for (const listener of this.listeners) listener({ ...item });
  }

  async start(input: StartDownloadInput): Promise<void> {
    const game = this.database.getGame(input.gameId);
    if (!game) throw new Error("Game not found.");
    const url = safeUrl(input.url);
    if (!Object.values(game.downloadLinks).includes(input.url)) {
      throw new Error("Download URL is not listed for this game.");
    }
    const selectedModIds = [...new Set(input.selectedModIds ?? [])];
    for (const modId of selectedModIds) {
      const mod = game.mods[modId];
      if (!mod || !preferredModUrl(mod)) {
        throw new Error(`Selected mod ${modId + 1} has no configured download link.`);
      }
    }
    if (this.transfers.has(game.id)) throw new Error("This game already has an active download.");
    const destination = validateDestination(input.destination);
    const installDir = path.resolve(destination, gameFolderName(game));
    if (!installDir.startsWith(`${destination}${path.sep}`)) {
      throw new Error("The installation path is outside the selected destination.");
    }
    const previous = this.database.getDownload(game.id);
    if (previous?.status === "installed") throw new Error("The game is already installed.");
    if (existsSync(installDir)) {
      const details = await lstat(installDir);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new Error("The game folder must be a regular directory.");
      }
      const hasArchive = findExistingGameArchive(installDir, path.join(installDir, `game${archiveExtension(url)}`));
      if (!hasArchive) {
        await rm(installDir, { recursive: true, force: true });
        await mkdir(installDir, { recursive: true });
      }
    } else {
      await mkdir(installDir, { recursive: true });
    }
    const preferredArchivePath = path.join(installDir, `game${archiveExtension(url)}`);
    const rootArchive = findExistingGameArchive(installDir, preferredArchivePath);
    const migratedArchive = await this.migrateLegacyArchives(game.id, installDir, url);
    const archivePath = rootArchive ?? migratedArchive ?? preferredArchivePath;
    this.completedGames.delete(game.id);
    this.database.saveDownload({
      gameId: game.id,
      status: "downloading",
      url: url.href,
      archivePath,
      installDir,
      gameRoot: installDir,
      runAfter: input.runAfter,
      selectedModIds,
      appliedModIds: [],
      phase: null,
    });
    this.enqueueMods(game, installDir, selectedModIds);
    const transfer: Transfer = {};
    this.transfers.set(game.id, transfer);
    this.emit(game.id);
    if (existsSync(archivePath)) {
      transfer.completion = this.installExistingArchive(game.id, archivePath, transfer);
    } else if (isBrowserHost(url)) {
      transfer.completion = this.startBrowserTransfer(game.id, url, archivePath, transfer);
    } else {
      transfer.completion = this.downloadDirect(game.id, resolveDirectUrl(url), archivePath, transfer);
    }
  }

  pause(gameId: number): void {
    const transfer = this.requireTransfer(gameId);
    const record = this.database.getDownload(gameId);
    if (!record || record.status !== "downloading") throw new Error("Download is not active.");
    if (transfer.item) {
      transfer.item.pause();
    } else if (transfer.controller) {
      transfer.controller.abort();
      this.database.updateDownload(gameId, {
        status: "paused",
        error: null,
        phase: null,
        phaseDetail: null,
      });
      this.emit(gameId);
    }
  }

  resume(gameId: number): void {
    const record = this.database.getDownload(gameId);
    if (!record || !["paused", "failed"].includes(record.status)) {
      throw new Error("Download is not paused or failed.");
    }
    const transfer = this.transfers.get(gameId) ?? {};
    this.transfers.set(gameId, transfer);
    if (transfer.item) {
      transfer.item.resume();
      return;
    }
    transfer.controller = new AbortController();
    const validatedUrl = safeUrl(record.url);
    this.database.updateDownload(gameId, {
      status: "downloading",
      error: null,
      phase: null,
      phaseDetail: null,
    });
    this.emit(gameId);
    transfer.completion = this.resumeTransfer(gameId, validatedUrl, transfer);
  }

  manualDownload(gameId: number): void {
    const record = this.database.getDownload(gameId);
    if (!record || record.status !== "failed") {
      throw new Error("Manual download is only available for failed downloads.");
    }
    const transfer = this.transfers.get(gameId) ?? {};
    this.transfers.set(gameId, transfer);
    this.database.updateDownload(gameId, {
      status: "downloading",
      error: null,
      phase: null,
      phaseDetail: null,
    });
    this.emit(gameId);
    transfer.completion = this.startBrowserTransfer(
      gameId,
      safeUrl(record.url),
      record.archivePath,
      transfer,
    );
  }

  private async resumeTransfer(gameId: number, url: URL, transfer: Transfer): Promise<void> {
    try {
      const current = this.database.getDownload(gameId);
      if (!current) throw new Error("Download record was not found.");
      const archivePath = await this.migrateLegacyArchives(
        gameId,
        path.resolve(current.installDir),
        url,
      ) ?? current.archivePath;
      const updated = this.database.getDownload(gameId);
      if (!updated) throw new Error("Download record was not found.");
      if (existsSync(archivePath)) {
        transfer.controller = undefined;
        await this.installExistingArchive(gameId, archivePath, transfer);
      } else if (isBrowserHost(url)) {
        transfer.controller = undefined;
        await this.startBrowserTransfer(gameId, url, archivePath, transfer);
      } else {
        transfer.controller = undefined;
        await this.downloadDirect(gameId, resolveDirectUrl(url), archivePath, transfer);
      }
    } catch (error) {
      this.fail(gameId, error);
    }
  }

  private async migrateLegacyArchives(
    gameId: number,
    installDir: string,
    url: URL,
  ): Promise<string | undefined> {
    const record = this.database.getDownload(gameId);
    if (!record) return undefined;
    const legacyDirectory = path.join(path.dirname(installDir), ".redline-downloads");
    const legacyArchive = path.join(legacyDirectory, `${gameId}.archive`);
    if (path.resolve(record.archivePath) !== legacyArchive) return undefined;

    await assertRegularDirectory(legacyDirectory);
    await mkdir(installDir, { recursive: true });
    const preferredPath = path.join(installDir, `game${archiveExtension(url)}`);
    let archivePath = findExistingGameArchive(installDir, preferredPath);
    if (!archivePath && existsSync(legacyArchive)) {
      const details = await lstat(legacyArchive);
      if (details.isSymbolicLink() || !details.isFile()) {
        throw new Error("The existing game archive is not a regular file.");
      }
      const extension = await getArchiveExtension(legacyArchive);
      if (!extension) throw new Error("The existing game archive is invalid.");
      archivePath = path.join(installDir, `game${extension}`);
      await rename(legacyArchive, archivePath);
    }

    const legacyPartial = `${legacyArchive}.part`;
    if (!archivePath && existsSync(legacyPartial)) {
      const details = await lstat(legacyPartial);
      if (details.isSymbolicLink() || !details.isFile()) {
        throw new Error("The partial game archive is not a regular file.");
      }
      archivePath = preferredPath;
      await rename(legacyPartial, `${archivePath}.part`);
    }

    const game = this.database.getGame(gameId);
    for (const modId of record.selectedModIds) {
      const mod = game?.mods[modId];
      const modUrl = mod && preferredModUrl(mod);
      if (!mod || !modUrl) continue;
      const extension = path.extname(new URL(modUrl).pathname).toLowerCase() ||
        (isDirectFileMod(mod) ? ".bin" : ".zip");
      const legacyMod = path.join(legacyDirectory, "mods", `${safeFileName(mod.name)}${extension}`);
      const rootMod = path.join(installDir, `${safeFileName(mod.name)}${extension}`);
      if (existsSync(legacyMod) && !existsSync(rootMod)) {
        await assertRegularDirectory(path.dirname(legacyMod));
        const details = await lstat(legacyMod);
        if (details.isSymbolicLink() || !details.isFile()) {
          throw new Error("A legacy mod archive is not a regular file.");
        }
        await rename(legacyMod, rootMod);
      }
    }

    archivePath ??= preferredPath;
    await rm(legacyArchive, { force: true });
    await rm(legacyPartial, { force: true });
    this.database.saveDownload({
      ...record,
      installDir,
      archivePath,
      selectedModIds: record.selectedModIds,
    });
    return archivePath;
  }

  async cancel(gameId: number): Promise<void> {
    const record = this.database.getDownload(gameId);
    if (!record || !["downloading", "paused", "failed"].includes(record.status)) {
      throw new Error("Download cannot be cancelled in its current state.");
    }
    const transfer = this.transfers.get(gameId);
    this.completedGames.delete(gameId);
    this.database.updateDownload(gameId, {
      status: "cancelled",
      error: null,
      phase: null,
      phaseDetail: null,
    });
    transfer?.controller?.abort();
    transfer?.item?.cancel();
    transfer?.browser?.close();
    this.transfers.delete(gameId);
    for (const job of this.modJobs.values()) {
      if (job.item.gameId === gameId && !["completed", "failed", "cancelled"].includes(job.item.status)) {
        job.cancelled = true;
        this.updateMod(job.item.id, { status: "cancelled", error: null });
      }
    }
    await transfer?.completion;
    const partialArchives = [`${record.archivePath}.part`];
    const game = this.database.getGame(gameId);
    for (const modId of record.selectedModIds) {
      const mod = game?.mods[modId];
      const modUrl = mod && preferredModUrl(mod);
      if (!mod || !modUrl) continue;
      const url = new URL(modUrl);
      const extension = modFileExtension(mod, url);
      partialArchives.push(path.join(record.installDir, `${safeFileName(mod.name)}${extension}.part`));
    }
    await Promise.all(partialArchives.map((partialPath) => rm(partialPath, { force: true })));
  }

  async applyMods(gameId: number, requestedModIds: number[]): Promise<void> {
    const record = this.database.getDownload(gameId);
    if (!record || record.status !== "installed") {
      throw new Error("Mods can only be applied to an installed game.");
    }
    if (this.launcher.runningIds().has(gameId)) {
      throw new Error("Stop the game before applying mods.");
    }
    if (this.transfers.has(gameId)) throw new Error("This game already has an active operation.");
    const game = this.database.getGame(gameId);
    if (!game) throw new Error("Game not found.");
    const modIds = [...new Set(requestedModIds)];
    for (const modId of modIds) {
      if (!Number.isInteger(modId) || modId < 0 || !game.mods[modId]) {
        throw new Error(`Selected mod ${modId + 1} was not found.`);
      }
      if (record.appliedModIds.includes(modId)) {
        throw new Error(`Mod "${game.mods[modId].name}" has already been applied.`);
      }
      if (!preferredModUrl(game.mods[modId])) {
        throw new Error(`Mod "${game.mods[modId].name}" has no configured download link.`);
      }
    }
    if (modIds.length === 0) return;

    const parentItem = this.gameQueueItem(record, "completed");
    this.completedGames.set(gameId, parentItem);
    this.emitItem(parentItem);
    this.enqueueMods(game, record.installDir, modIds);
    const transfer: Transfer = {};
    this.transfers.set(gameId, transfer);
    transfer.completion = this.processModQueue(game, record.installDir, record.gameRoot, modIds, transfer)
      .finally(() => this.finishModOperation(gameId));
  }

  async cancelModDownload(id: string): Promise<void> {
    const job = this.modJobs.get(id);
    if (!job || job.item.kind !== "mod") throw new Error("Mod queue item was not found.");
    if (["completed", "cancelled"].includes(job.item.status)) {
      throw new Error("Mod download cannot be cancelled in its current state.");
    }
    job.cancelled = true;
    this.updateMod(id, { status: "cancelled", error: null });
    if (this.activeModId === id) {
      const transfer = this.transfers.get(job.item.gameId);
      transfer?.controller?.abort();
      transfer?.item?.cancel();
      transfer?.browser?.close();
      await this.removeModPartial(job.item);
    }
  }

  async retryModDownload(id: string): Promise<void> {
    const job = this.modJobs.get(id);
    if (!job || job.item.status !== "failed") {
      throw new Error("Only failed mod downloads can be retried.");
    }
    const record = this.database.getDownload(job.item.gameId);
    const game = this.database.getGame(job.item.gameId);
    if (!record || record.status !== "installed" || !game) {
      throw new Error("The game must be installed before retrying this mod.");
    }
    if (this.transfers.has(game.id)) throw new Error("This game already has an active operation.");
    job.cancelled = false;
    job.manualBrowser = true;
    this.updateMod(id, {
      status: "waiting",
      bytesDownloaded: 0,
      totalBytes: null,
      error: null,
      phase: "downloading-mod",
    });
    const transfer: Transfer = {};
    this.transfers.set(game.id, transfer);
    transfer.completion = this.processModQueue(game, record.installDir, record.gameRoot, [job.item.modId], transfer)
      .finally(() => this.finishModOperation(game.id));
  }

  private finishModOperation(gameId: number): void {
    this.transfers.delete(gameId);
    const current = this.database.getDownload(gameId);
    if (current?.status === "installed" && current.phase) {
      this.database.updateDownload(gameId, { phase: null, phaseDetail: null });
      this.emit(gameId);
    }
  }

  private async processModQueue(
    game: Game,
    installDir: string,
    gameRoot: string,
    modIds: number[],
    transfer: Transfer,
  ): Promise<void> {
    for (const modId of modIds) {
      const id = `mod:${game.id}:${modId}`;
      const job = this.modJobs.get(id);
      if (!job || job.cancelled) continue;
      const mod = game.mods[modId];
      const rawUrl = preferredModUrl(mod);
      if (!rawUrl) {
        this.updateMod(id, { status: "failed", error: `No download link is configured for mod "${mod.name}".` });
        continue;
      }
      this.activeModId = id;
      job.gameRoot = gameRoot;
      try {
        this.updateMod(id, {
          status: "downloading",
          bytesDownloaded: 0,
          totalBytes: null,
          error: null,
          phase: "downloading-mod",
          detail: mod.name,
          phaseDetail: mod.name,
        });
        const modArchive = await this.downloadMod(
          game.id,
          mod,
          safeUrl(rawUrl),
          installDir,
          transfer,
          this.database.getDownload(game.id)?.status === "installed",
          id,
          job.manualBrowser === true,
        );
        job.manualBrowser = false;
        if (job.cancelled) throw new ModCancelledError();
        this.database.updateDownload(game.id, {
          phase: "applying-mods",
          phaseDetail: mod.name,
        });
        this.emit(game.id);
        this.updateMod(id, {
          status: "applying",
          phase: "applying-mods",
          detail: mod.name,
          phaseDetail: mod.name,
        });
        await applyModArchive(modArchive, mod, gameRoot, isDirectFileMod(mod));
        if (job.cancelled) throw new ModCancelledError();
        const latest = this.database.getDownload(game.id);
        if (!latest) throw new Error("The game download record was lost while applying mods.");
        if (!latest.appliedModIds.includes(modId)) {
          this.database.updateDownload(game.id, {
            appliedModIds: [...latest.appliedModIds, modId],
          });
        }
        this.updateMod(id, {
          status: "completed",
          error: null,
          phase: null,
          detail: null,
          phaseDetail: null,
        });
      } catch (error) {
        await this.removeModPartial(job.item);
        const gameStatus = this.database.getDownload(game.id)?.status;
        if (!job.cancelled && gameStatus === "paused") {
          this.updateMod(id, { status: "paused", error: null });
          throw error;
        }
        if (!job.cancelled && gameStatus === "cancelled") throw error;
        if (job.cancelled || error instanceof ModCancelledError ||
            (error instanceof DOMException && error.name === "AbortError")) {
          this.updateMod(id, { status: "cancelled", error: null });
        } else {
          this.updateMod(id, {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        if (this.activeModId === id) this.activeModId = undefined;
      }
    }
  }

  private async removeModPartial(item: ModDownloadQueueItem): Promise<void> {
    const game = this.database.getGame(item.gameId);
    const mod = game?.mods[item.modId];
    const rawUrl = mod && preferredModUrl(mod);
    if (!mod || !rawUrl) return;
    const extension = modFileExtension(mod, new URL(rawUrl));
    await rm(path.join(item.installDir, `${safeFileName(mod.name)}${extension}.part`), { force: true });
  }

  private requireTransfer(gameId: number): Transfer {
    const transfer = this.transfers.get(gameId);
    if (!transfer) throw new Error("No active download exists for this game.");
    return transfer;
  }

  private emit(gameId: number): void {
    const record = this.database.getDownload(gameId);
    if (!record) return;
    this.emitItem(this.gameQueueItem(record));
  }

  private async installExistingArchive(
    gameId: number,
    archivePath: string,
    transfer: Transfer,
  ): Promise<void> {
    try {
      if (!await archiveHasSupportedSignature(archivePath)) {
        throw new Error("The existing game archive is invalid.");
      }
      await this.finishInstall(gameId, archivePath, transfer);
    } catch (error) {
      this.fail(gameId, error);
    }
  }

  private async downloadDirect(
    gameId: number,
    initialUrl: URL,
    archivePath: string,
    transfer: Transfer,
  ): Promise<void> {
    const partPath = `${archivePath}.part`;
    const controller = new AbortController();
    transfer.controller = controller;
    try {
      let url = initialUrl;
      let response: Response | undefined;
      const existingBytes = existsSync(partPath) ? (await stat(partPath)).size : 0;
      for (let redirects = 0; redirects <= 8; redirects += 1) {
        response = await fetch(url, {
          signal: controller.signal,
          redirect: "manual",
          headers: existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : undefined,
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        if (!location) throw new Error("Download redirected without a destination.");
        url = isSafeRedirectUrl(new URL(location, url).href);
        response.body?.cancel();
        response = undefined;
      }
      if (!response) throw new Error("Too many download redirects.");
      if (!response.ok || !response.body) {
        throw new Error(`Download request failed (HTTP ${response.status}).`);
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("text/html") || contentType.includes("application/json")) {
        throw new Error("The URL returned a web page, not an archive file.");
      }
      const range = response.headers.get("content-range");
      const rangeStart = range?.match(/^bytes (\d+)-\d+\/\d+$/)?.[1];
      if (response.status === 206 && Number(rangeStart) !== existingBytes) {
        throw new Error("The server returned an invalid resume range.");
      }
      const supportsResume = response.status === 206 && existingBytes > 0;
      const start = supportsResume ? existingBytes : 0;
      const totalFromRange = range?.match(/\/(\d+)$/);
      const responseBytes = Number(response.headers.get("content-length")) || null;
      const totalBytes = totalFromRange
        ? Number(totalFromRange[1])
        : responseBytes === null ? null : responseBytes + start;
      const target = createWriteStream(partPath, { flags: start > 0 ? "a" : "w" });
      this.database.updateDownload(gameId, {
        status: "downloading",
        bytesDownloaded: start,
        totalBytes,
        error: null,
        phase: null,
        phaseDetail: null,
      });
      this.emit(gameId);
      const reader = response.body.getReader();
      let received = start;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!target.write(value)) await once(target, "drain");
          received += value.byteLength;
          this.database.updateDownload(gameId, { bytesDownloaded: received });
          this.emit(gameId);
        }
      } finally {
        await finishWriteStream(target);
        reader.releaseLock();
      }
      transfer.controller = undefined;
      if (!await archiveHasSupportedSignature(partPath)) {
        throw new Error("Downloaded file is not a ZIP, 7z, or RAR archive.");
      }
      await rm(archivePath, { force: true });
      await rename(partPath, archivePath);
      await this.finishInstall(gameId, archivePath, transfer);
    } catch (error) {
      if (transfer.controller && transfer.controller !== controller) return;
      const record = this.database.getDownload(gameId);
      if (record?.status === "paused") return;
      if (record?.status === "cancelled") {
        await rm(partPath, { force: true });
        return;
      }
      this.fail(gameId, error);
    }
  }

  private startBrowserTransfer(
    gameId: number,
    url: URL,
    archivePath: string,
    transfer: Transfer,
  ): Promise<void> {
    return new Promise((resolve) => {
      let downloadStarted = false;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const browser = new BrowserWindow({
        width: 1000,
        height: 720,
        title: "Complete download in browser",
        webPreferences: downloadBrowserPreferences(),
      });
      const browserSession = browser.webContents.session;
      transfer.browser = browser;
      const handleDownload = (
        _event: Electron.Event,
        item: DownloadItem,
      ): void => {
        if (downloadStarted) {
          item.cancel();
          return;
        }
        try {
          safeUrl(item.getURL());
        } catch (error) {
          item.cancel();
          this.fail(gameId, error);
          browser.close();
          return;
        }
        downloadStarted = true;
        transfer.item = item;
        item.setSavePath(`${archivePath}.part`);
        item.on("updated", () => {
          if (this.database.getDownload(gameId)?.status === "cancelled") return;
          const status = item.isPaused() ? "paused" : "downloading";
          const received = item.getReceivedBytes();
          this.database.updateDownload(gameId, {
            status,
            bytesDownloaded: received,
            totalBytes: item.getTotalBytes() || null,
            phase: null,
            phaseDetail: null,
          });
          this.emit(gameId);
        });
        item.once("done", (_doneEvent, state) => {
          transfer.item = undefined;
          transfer.browser = undefined;
          if (this.database.getDownload(gameId)?.status === "cancelled") {
            finish();
            return;
          }
          if (state !== "completed") {
            this.transfers.delete(gameId);
            if (state === "cancelled") void rm(`${archivePath}.part`, { force: true });
            if (state === "cancelled") {
              this.database.updateDownload(gameId, { status: "cancelled" });
              this.emit(gameId);
            } else {
              this.fail(gameId, new Error(`Browser download ended with status: ${state}.`));
            }
            finish();
            return;
          }
          void rename(`${archivePath}.part`, archivePath)
            .then(() => this.finishInstall(gameId, archivePath, transfer))
            .catch((error: unknown) => this.fail(gameId, error))
            .finally(finish);
        });
        browser.close();
      };
      browserSession.on("will-download", handleDownload);
      browser.once("closed", () => {
        if (transfer.browser === browser) transfer.browser = undefined;
        browserSession.removeListener("will-download", handleDownload);
        if (!downloadStarted && this.transfers.has(gameId)) {
          this.transfers.delete(gameId);
          this.database.updateDownload(gameId, {
            status: "cancelled",
            error: "The download browser was closed before a download started.",
          });
          this.emit(gameId);
        }
        if (!downloadStarted) finish();
      });
      void browser.loadURL(url.href).catch((error: unknown) => {
        this.fail(gameId, error);
        browser.close();
      });
    });
  }

  private async finishInstall(gameId: number, archivePath: string, transfer: Transfer): Promise<void> {
    const record = this.database.getDownload(gameId);
    const game = this.database.getGame(gameId);
    if (!record || !game) throw new Error("Game disappeared while installing.");
    await mkdir(record.installDir, { recursive: true });
    const gameRoot = await findGameRootInArchive(archivePath, record.installDir);
    this.database.updateDownload(gameId, { gameRoot });
    this.database.updateDownload(gameId, {
      phase: "extracting",
      phaseDetail: null,
    });
    this.emit(gameId);
    await extractArchive(archivePath, record.installDir);
    this.database.updateDownload(gameId, {
      phase: "finalizing",
      phaseDetail: null,
    });
    this.emit(gameId);
    const launcher = await findGameLauncher(gameRoot);
    if (!launcher) throw new Error("No compatible game launcher was found in the archive.");
    const extracted = this.database.getDownload(gameId);
    if (!extracted || extracted.status === "cancelled") {
      throw new Error("Installation was cancelled.");
    }
    const completedItem = this.gameQueueItem(extracted, "completed");
    completedItem.phase = null;
    completedItem.detail = null;
    completedItem.phaseDetail = null;
    this.completedGames.set(gameId, completedItem);
    this.emitItem(completedItem);
    await this.processModQueue(
      game,
      record.installDir,
      gameRoot,
      record.selectedModIds,
      transfer,
    );
    const current = this.database.getDownload(gameId);
    if (!current || current.status === "cancelled") {
      throw new Error("Installation was cancelled.");
    }
    this.database.updateDownload(gameId, {
      status: "installed",
      error: null,
      phase: null,
      phaseDetail: null,
    });
    const completed = this.database.getDownload(gameId);
    if (completed) this.completedGames.set(gameId, this.gameQueueItem(completed, "completed"));
    this.transfers.delete(gameId);
    this.emit(gameId);
    if (record.runAfter) {
      try {
        await this.launcher.launch(gameId);
      } catch (error) {
        this.database.updateDownload(gameId, {
          error: `Installed, but could not auto-run: ${error instanceof Error ? error.message : String(error)}`,
        });
        this.emit(gameId);
      }
    }
    this.transfers.delete(gameId);
  }

  private async downloadMod(
    gameId: number,
    mod: GameMod,
    initialUrl: URL,
    archiveDirectory: string,
    transfer: Transfer,
    keepInstalledStatus = false,
    queueItemId?: string,
    forceBrowser = false,
  ): Promise<string> {
    const directFile = isDirectFileMod(mod);
    const fileExtension = modFileExtension(mod, initialUrl);
    await mkdir(archiveDirectory, { recursive: true });
    const modArchive = path.join(archiveDirectory, `${safeFileName(mod.name)}${fileExtension}`);
    const partPath = `${modArchive}.part`;
    if (existsSync(modArchive)) {
      if (!directFile && !await archiveHasSupportedSignature(modArchive)) {
        throw new Error(`The existing mod archive for "${mod.name}" is invalid.`);
      }
      return modArchive;
    }
    await rm(partPath, { force: true });
    this.database.updateDownload(gameId, {
      ...(keepInstalledStatus ? {} : {
        status: "downloading" as const,
        bytesDownloaded: 0,
        totalBytes: null,
      }),
      error: null,
      phase: "downloading-mod",
      phaseDetail: mod.name,
    });
    this.emit(gameId);
    if (queueItemId) this.updateMod(queueItemId, {
      status: "downloading",
      bytesDownloaded: 0,
      totalBytes: null,
      error: null,
    });

    if (forceBrowser || isBrowserHost(initialUrl)) {
      return this.downloadModInBrowser(
        gameId,
        initialUrl,
        modArchive,
        partPath,
        transfer,
        keepInstalledStatus,
        directFile,
        queueItemId,
      );
    }

    const controller = new AbortController();
    transfer.controller = controller;
    try {
      if (queueItemId && this.modJobs.get(queueItemId)?.cancelled) {
        controller.abort();
        throw new ModCancelledError();
      }
      let url = resolveDirectUrl(initialUrl);
      let response: Response | undefined;
      for (let redirects = 0; redirects <= 8; redirects += 1) {
        response = await fetch(url, {
          signal: controller.signal,
          redirect: "manual"
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        if (!location) throw new Error("Mod download redirected without a destination.");
        url = isSafeRedirectUrl(new URL(location, url).href);
        response.body?.cancel();
        response = undefined;
      }
      if (!response) throw new Error(`Too many redirects while downloading "${mod.name}".`);
      if (!response.ok || !response.body) {
        throw new Error(`Mod download failed with HTTP ${response.status}.`);
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("text/html") || contentType.includes("application/json")) {
        throw new Error(`The link for "${mod.name}" returned a page, not a mod file.`);
      }
      const totalBytes = Number(response.headers.get("content-length")) || null;
      this.database.updateDownload(gameId, { totalBytes });
      if (queueItemId) this.updateMod(queueItemId, { totalBytes });
      const target = createWriteStream(partPath, { flags: "w" });
      const reader = response.body.getReader();
      let received = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!target.write(value)) await once(target, "drain");
          received += value.byteLength;
          this.database.updateDownload(gameId, { bytesDownloaded: received });
          this.emit(gameId);
          if (queueItemId) this.updateMod(queueItemId, { bytesDownloaded: received });
        }
      } finally {
        await finishWriteStream(target);
        reader.releaseLock();
      }
      transfer.controller = undefined;
      if (!directFile && !await archiveHasSupportedSignature(partPath)) {
        throw new Error(`Downloaded mod "${mod.name}" is not a valid archive.`);
      }
      await rename(partPath, modArchive);
      return modArchive;
    } finally {
      if (transfer.controller === controller) transfer.controller = undefined;
    }
  }

  private downloadModInBrowser(
    gameId: number,
    url: URL,
    modArchive: string,
    partPath: string,
    transfer: Transfer,
    keepInstalledStatus: boolean,
    directFile: boolean,
    queueItemId?: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const browser = new BrowserWindow({
        width: 1000,
        height: 720,
        title: "Complete mod download in browser",
        webPreferences: downloadBrowserPreferences(),
      });
      const browserSession = browser.webContents.session;
      transfer.browser = browser;
      let downloadStarted = false;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (transfer.browser === browser) transfer.browser = undefined;
        transfer.item = undefined;
        browserSession.removeListener("will-download", handleDownload);
        if (!browser.isDestroyed()) browser.close();
        if (error) reject(error);
      };
      const handleDownload = (_event: Electron.Event, item: DownloadItem) => {
        if (downloadStarted) {
          item.cancel();
          return;
        }
        try {
          safeUrl(item.getURL());
        } catch (error) {
          item.cancel();
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        downloadStarted = true;
        transfer.item = item;
        item.setSavePath(partPath);
        item.on("updated", () => {
          this.database.updateDownload(gameId, {
            ...(keepInstalledStatus ? {} : {
              status: item.isPaused() ? "paused" as const : "downloading" as const,
            }),
            bytesDownloaded: item.getReceivedBytes(),
            totalBytes: item.getTotalBytes() || null,
            phase: "downloading-mod",
          });
          this.emit(gameId);
          if (queueItemId) this.updateMod(queueItemId, {
            status: item.isPaused() ? "paused" : "downloading",
            bytesDownloaded: item.getReceivedBytes(),
            totalBytes: item.getTotalBytes() || null,
          });
        });
        item.once("done", (_doneEvent, state) => {
          transfer.item = undefined;
          transfer.browser = undefined;
          if (state !== "completed") {
            void rm(partPath, { force: true });
            finish(new Error(`Mod "${path.basename(modArchive)}" download ended with status: ${state}.`));
            return;
          }
          void (async () => {
            if (!directFile && !await archiveHasSupportedSignature(partPath)) {
              throw new Error("Downloaded mod is not a valid archive.");
            }
            await rename(partPath, modArchive);
            finish();
            resolve(modArchive);
          })().catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
        });
        browser.close();
      };
      browserSession.on("will-download", handleDownload);
      browser.once("closed", () => {
        browserSession.removeListener("will-download", handleDownload);
        if (!settled && !downloadStarted) finish(new Error(`The browser was closed before "${path.basename(modArchive)}" downloaded.`));
      });
      void browser.loadURL(url.href).catch((error: unknown) =>
        finish(error instanceof Error ? error : new Error(String(error))),
      );
    });
  }

  private fail(gameId: number, error: unknown): void {
    const record = this.database.getDownload(gameId);
    if (!record || record.status === "cancelled" || record.status === "paused") return;
    this.transfers.delete(gameId);
    record.status = "failed";
    this.database.updateDownload(gameId, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      phase: null,
      phaseDetail: null,
    });
    this.emit(gameId);
  }

  isActive(gameId: number): boolean {
    return this.transfers.has(gameId);
  }
}
