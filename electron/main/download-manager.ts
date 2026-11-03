import { BrowserWindow, type DownloadItem } from "electron";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DownloadUpdate, GameMod, StartDownloadInput } from "../../src/shared/types";
import { extractArchive, isSupportedArchive } from "./archive";
import type { LibraryDatabase } from "./database";
import { findGameLauncher, type Launcher } from "./launcher";
import { applyModArchive } from "./mod-installer";

interface Transfer {
  controller?: AbortController;
  browser?: BrowserWindow;
  item?: DownloadItem;
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

function isBrowserHost(url: URL): boolean {
  return url.hostname === "gofile.io" || url.hostname.endsWith(".gofile.io") ||
    url.hostname === "workupload.com" || url.hostname.endsWith(".workupload.com");
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
  if (resolved === root || !existsSync(resolved)) {
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
  return mod.steps_to_apply.length === 1 &&
    mod.steps_to_apply[0].type === "move" &&
    !mod.steps_to_apply[0].source_folder;
}

function isArchiveSignature(bytes: Uint8Array): boolean {
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const sevenZip = bytes.length >= 6 &&
    [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c].every((byte, index) => bytes[index] === byte);
  const rar4 = bytes.length >= 7 &&
    [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00].every((byte, index) => bytes[index] === byte);
  const rar5 = bytes.length >= 8 &&
    [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00].every((byte, index) => bytes[index] === byte);
  return zip || sevenZip || rar4 || rar5;
}

function safeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").trim() || "mod";
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

export class DownloadManager {
  private readonly transfers = new Map<number, Transfer>();
  private readonly listeners = new Set<(update: DownloadUpdate) => void>();

  constructor(
    private readonly database: LibraryDatabase,
    private readonly launcher: Launcher,
  ) {}

  onUpdate(listener: (update: DownloadUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    const installDir = path.resolve(destination, safeFolderName(game.name));
    if (!installDir.startsWith(`${destination}${path.sep}`)) {
      throw new Error("The installation path is outside the selected destination.");
    }
    if (existsSync(installDir)) throw new Error("The game already exists in this destination.");

    const archiveDir = path.join(destination, ".redline-downloads");
    await mkdir(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, `${game.id}.archive`);
    this.database.saveDownload({
      gameId: game.id,
      status: "downloading",
      url: url.href,
      archivePath,
      installDir,
      runAfter: input.runAfter,
      selectedModIds,
    });
    const transfer: Transfer = {};
    this.transfers.set(game.id, transfer);
    this.emit(game.id);
    if (isBrowserHost(url)) {
      this.startBrowserTransfer(game.id, url, archivePath, transfer);
    } else {
      void this.downloadDirect(game.id, resolveDirectUrl(url), archivePath, transfer);
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
      this.database.updateDownload(gameId, { status: "paused", error: null });
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
    const validatedUrl = safeUrl(record.url);
    this.database.updateDownload(gameId, { status: "downloading", error: null });
    this.emit(gameId);
    if (isBrowserHost(validatedUrl)) {
      this.startBrowserTransfer(gameId, validatedUrl, record.archivePath, transfer);
    } else {
      void this.downloadDirect(gameId, resolveDirectUrl(validatedUrl), record.archivePath, transfer);
    }
  }

  cancel(gameId: number): void {
    const transfer = this.requireTransfer(gameId);
    transfer.controller?.abort();
    transfer.item?.cancel();
    transfer.browser?.close();
    this.transfers.delete(gameId);
    const record = this.database.getDownload(gameId);
    if (record) void rm(`${record.archivePath}.part`, { force: true });
    this.database.updateDownload(gameId, { status: "cancelled", error: null });
    this.emit(gameId);
  }

  private requireTransfer(gameId: number): Transfer {
    const transfer = this.transfers.get(gameId);
    if (!transfer) throw new Error("No active download exists for this game.");
    return transfer;
  }

  private emit(gameId: number): void {
    const record = this.database.getDownload(gameId);
    if (!record) return;
    const update: DownloadUpdate = {
      gameId,
      bytesDownloaded: record.bytesDownloaded,
      totalBytes: record.totalBytes,
      status: record.status,
      error: record.error,
    };
    for (const listener of this.listeners) listener(update);
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
          headers: {
            "User-Agent": "RedlineLibrary/1.0",
            ...(existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {}),
          },
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
      if (response.status === 206 && !range?.startsWith(`bytes ${existingBytes}-`)) {
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
      const signature = new Uint8Array(8);
      const fileHandle = await open(partPath, "r");
      try {
        await fileHandle.read(signature, 0, signature.length, 0);
      } finally {
        await fileHandle.close();
      }
      if (!isArchiveSignature(signature)) throw new Error("Downloaded file is not a ZIP, 7z, or RAR archive.");
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
  ): void {
    const browser = new BrowserWindow({
      width: 1000,
      height: 720,
      title: "Complete download in browser",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    transfer.browser = browser;
    let downloadStarted = false;
    const handleDownload = (
      _event: Electron.Event,
      item: DownloadItem,
    ): void => {
      if (downloadStarted) {
        item.cancel();
        return;
      }
      let downloadUrl: URL;
      try {
        downloadUrl = safeUrl(item.getURL());
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
        const status = item.isPaused() ? "paused" : "downloading";
        const received = item.getReceivedBytes();
        this.database.updateDownload(gameId, {
          status,
          bytesDownloaded: received,
          totalBytes: item.getTotalBytes() || null,
        });
        this.emit(gameId);
      });
      item.once("done", (_doneEvent, state) => {
        browser.close();
        transfer.item = undefined;
        transfer.browser = undefined;
        if (state !== "completed") {
          this.transfers.delete(gameId);
          if (state === "cancelled") void rm(`${archivePath}.part`, { force: true });
          if (state === "cancelled") {
            this.database.updateDownload(gameId, { status: "cancelled" });
            this.emit(gameId);
          } else {
            this.fail(gameId, new Error(`Browser download ended with status: ${state}.`));
          }
          return;
        }
        void rename(`${archivePath}.part`, archivePath)
          .then(() => this.finishInstall(gameId, archivePath, transfer))
          .catch((error: unknown) => this.fail(gameId, error));
      });
      if (!downloadUrl) return;
    };
    browser.webContents.session.on("will-download", handleDownload);
    browser.once("closed", () => {
      if (transfer.browser === browser) transfer.browser = undefined;
      browser.webContents.session.removeListener("will-download", handleDownload);
      if (!downloadStarted && this.transfers.has(gameId)) {
        this.transfers.delete(gameId);
        this.database.updateDownload(gameId, {
          status: "cancelled",
          error: "The download browser was closed before a download started.",
        });
        this.emit(gameId);
      }
    });
    void browser.loadURL(url.href).catch((error: unknown) => this.fail(gameId, error));
  }

  private async finishInstall(gameId: number, archivePath: string, transfer: Transfer): Promise<void> {
    const record = this.database.getDownload(gameId);
    const game = this.database.getGame(gameId);
    if (!record || !game) throw new Error("Game disappeared while installing.");
    const staging = `${record.installDir}.extracting-${randomUUID()}`;
    await mkdir(staging, { recursive: true });
    try {
      await extractArchive(archivePath, staging);
      for (const modId of record.selectedModIds) {
        const downloadState = this.database.getDownload(gameId);
        if (!downloadState || downloadState.status === "cancelled") {
          throw new Error("Installation was cancelled.");
        }
        const mod = game.mods[modId];
        if (!mod) throw new Error(`Selected mod ${modId + 1} is no longer in the catalog.`);
        const url = preferredModUrl(mod);
        if (!url) throw new Error(`No download link is configured for mod "${mod.name}".`);
        const modArchive = await this.downloadMod(
          gameId,
          mod,
          safeUrl(url),
          path.dirname(record.archivePath),
          transfer,
        );
        await applyModArchive(modArchive, mod, staging, isDirectFileMod(mod));
      }
      const launcher = await findGameLauncher(staging);
      if (!launcher) throw new Error("No compatible game launcher was found in the archive.");
      const current = this.database.getDownload(gameId);
      if (!current || current.status === "cancelled") {
        throw new Error("Installation was cancelled.");
      }
      if (existsSync(record.installDir)) throw new Error("The installation destination already exists.");
      await rename(staging, record.installDir);
      this.database.updateDownload(gameId, { status: "installed", error: null });
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

    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private async downloadMod(
    gameId: number,
    mod: GameMod,
    initialUrl: URL,
    archiveDirectory: string,
    transfer: Transfer,
  ): Promise<string> {
    const extension = path.extname(initialUrl.pathname).toLowerCase();
    const directFile = isDirectFileMod(mod);
    const fileExtension = extension || (directFile ? ".bin" : ".zip");
    const modDirectory = path.join(archiveDirectory, "mods");
    await mkdir(modDirectory, { recursive: true });
    const modArchive = path.join(modDirectory, `${safeFileName(mod.name)}${fileExtension}`);
    const partPath = `${modArchive}.part`;
    await rm(partPath, { force: true });
    this.database.updateDownload(gameId, {
      status: "downloading",
      bytesDownloaded: 0,
      totalBytes: null,
      error: null,
    });
    this.emit(gameId);

    if (isBrowserHost(initialUrl)) {
      return this.downloadModInBrowser(gameId, initialUrl, modArchive, partPath, transfer);
    }

    const controller = new AbortController();
    transfer.controller = controller;
    try {
      let url = resolveDirectUrl(initialUrl);
      let response: Response | undefined;
      for (let redirects = 0; redirects <= 8; redirects += 1) {
        response = await fetch(url, {
          signal: controller.signal,
          redirect: "manual",
          headers: { "User-Agent": "RedlineLibrary/1.0" },
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
        }
      } finally {
        await finishWriteStream(target);
        reader.releaseLock();
      }
      transfer.controller = undefined;
      if (!directFile && isSupportedArchive(modArchive)) {
        const signature = new Uint8Array(8);
        const fileHandle = await open(partPath, "r");
        try {
          await fileHandle.read(signature, 0, signature.length, 0);
        } finally {
          await fileHandle.close();
        }
        if (!isArchiveSignature(signature)) {
          throw new Error(`Downloaded mod "${mod.name}" is not a valid archive.`);
        }
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
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const browser = new BrowserWindow({
        width: 1000,
        height: 720,
        title: "Complete mod download in browser",
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      transfer.browser = browser;
      let downloadStarted = false;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (transfer.browser === browser) transfer.browser = undefined;
        transfer.item = undefined;
        browser.webContents.session.removeListener("will-download", handleDownload);
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
            status: item.isPaused() ? "paused" : "downloading",
            bytesDownloaded: item.getReceivedBytes(),
            totalBytes: item.getTotalBytes() || null,
          });
          this.emit(gameId);
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
            if (isSupportedArchive(modArchive)) {
              const signature = new Uint8Array(8);
              const fileHandle = await open(partPath, "r");
              try {
                await fileHandle.read(signature, 0, signature.length, 0);
              } finally {
                await fileHandle.close();
              }
              if (!isArchiveSignature(signature)) throw new Error("Downloaded mod is not a valid archive.");
            }
            await rename(partPath, modArchive);
            finish();
            resolve(modArchive);
          })().catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
        });
      };
      browser.webContents.session.on("will-download", handleDownload);
      browser.once("closed", () => {
        browser.webContents.session.removeListener("will-download", handleDownload);
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
    });
    this.emit(gameId);
  }

  isActive(gameId: number): boolean {
    return this.transfers.has(gameId);
  }
}
