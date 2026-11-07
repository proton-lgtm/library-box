import { BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from "electron";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { DownloadManager } from "./downloads/download-manager";
import type { LibraryDatabase } from "./database";
import type { LibraryManager } from "./library-manager";
import type { Launcher } from "./launcher";
import type { SupabaseService } from "./supabase-service";
import { authCredentialsSchema, externalUrlSchema } from "./ipc-validation";

const gameIdSchema = z.number().int().positive();
const applyModsSchema = z.object({
  gameId: gameIdSchema,
  modIds: z.array(z.number().int().nonnegative()).max(100),
}).strict();
const startDownloadSchema = z.object({
  gameId: gameIdSchema,
  url: z.string().url().max(4096),
  destination: z.string().min(1).max(4096),
  runAfter: z.boolean(),
  selectedModIds: z.array(z.number().int().nonnegative()).max(100),
}).strict();
function assertTrustedSender(senderUrl: string, trustedUrl: string): void {
  if (new URL(senderUrl).href === new URL(trustedUrl).href) return;
  throw new Error("Untrusted IPC sender.");
}

export function registerIpc(
  getWindow: () => BrowserWindow | undefined,
  database: LibraryDatabase,
  downloads: DownloadManager,
  launcher: Launcher,
  library: LibraryManager,
  supabase: SupabaseService,
  trustedRendererUrl: string,
): void {
  const handle = (channel: string, handler: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      const senderUrl = event.senderFrame?.url;
      if (!senderUrl) throw new Error("IPC sender frame is unavailable.");
      assertTrustedSender(senderUrl, trustedRendererUrl);
      return handler(...args);
    });
  };
  handle("library:list-games", () => database.listGames());
  handle("library:refresh-catalog", () => supabase.refreshCatalog());
  handle("library:get-auth-state", () => supabase.getAuthState());
  handle("library:sign-in", (input) => supabase.signIn(authCredentialsSchema.parse(input)));
  handle("library:upgrade-account", (input) => supabase.upgradeAnonymousAccount(authCredentialsSchema.parse(input)));
  handle("library:sign-out", () => supabase.signOut());
  handle("library:open-external", async (input) => {
    const url = externalUrlSchema.parse(input);
    await shell.openExternal(url);
  });
  handle("library:list-downloads", () => downloads.listQueue());
  handle("library:list-library", () => database.listLibrary(launcher.runningIds()));
  handle("library:choose-destination", async () => {
    const window = getWindow();
    const options: OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"],
      title: "Choose game install folder",
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0];
  });
  handle("library:start-download", async (input) => {
    const parsed = startDownloadSchema.parse(input);
    const destination = path.resolve(parsed.destination);
    if (!path.isAbsolute(parsed.destination) || !existsSync(destination) ||
        !statSync(destination).isDirectory()) {
      throw new Error("The selected download destination is not a folder.");
    }
    return downloads.start({ ...parsed, destination });
  });
  handle("library:pause-download", (gameId) => downloads.pause(gameIdSchema.parse(gameId)));
  handle("library:resume-download", (gameId) => downloads.resume(gameIdSchema.parse(gameId)));
  handle("library:manual-download", (gameId) => downloads.manualDownload(gameIdSchema.parse(gameId)));
  handle("library:cancel-download", (gameId) => downloads.cancel(gameIdSchema.parse(gameId)));
  handle("library:dismiss-terminal-download", (gameId) =>
    downloads.dismissTerminalDownload(gameIdSchema.parse(gameId)));
  handle("library:clear-terminal-downloads", () => downloads.clearTerminalDownloads());
  handle("library:cancel-mod-download", (id) => downloads.cancelModDownload(z.string().min(1).max(128).parse(id)));
  handle("library:retry-mod-download", (id) => downloads.retryModDownload(z.string().min(1).max(128).parse(id)));
  handle("library:apply-mods", (gameId, modIds) => {
    const parsed = applyModsSchema.parse({ gameId, modIds });
    return downloads.applyMods(parsed.gameId, parsed.modIds);
  });
  handle("library:launch-game", (gameId) => launcher.launch(gameIdSchema.parse(gameId)));
  handle("library:stop-game", (gameId) => launcher.stop(gameIdSchema.parse(gameId)));
  handle("library:delete-game", async (gameId) => {
    const parsed = gameIdSchema.parse(gameId);
    await library.deleteGame(parsed);
    downloads.removeGameQueueHistory(parsed);
  });
  handle("library:minimize-window", () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) throw new Error("The app window is unavailable.");
    window.minimize();
  });
  handle("library:toggle-maximize-window", () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) throw new Error("The app window is unavailable.");
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return window.isMaximized();
  });
  handle("library:is-window-maximized", () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) throw new Error("The app window is unavailable.");
    return window.isMaximized();
  });
  handle("library:close-window", () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) throw new Error("The app window is unavailable.");
    window.close();
  });

  downloads.onUpdate((update) => {
    const currentWindow = getWindow();
    if (currentWindow && !currentWindow.isDestroyed()) {
      currentWindow.webContents.send("library:download-update", update);
    }
  });
}
