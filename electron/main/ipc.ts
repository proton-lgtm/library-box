import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from "electron";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { DownloadManager } from "./download-manager";
import type { LibraryDatabase } from "./database";
import type { Launcher } from "./launcher";

const gameIdSchema = z.number().int().positive();
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
  handle("library:list-downloads", () => database.listDownloads());
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
  handle("library:cancel-download", (gameId) => downloads.cancel(gameIdSchema.parse(gameId)));
  handle("library:launch-game", (gameId) => launcher.launch(gameIdSchema.parse(gameId)));
  handle("library:stop-game", (gameId) => launcher.stop(gameIdSchema.parse(gameId)));

  downloads.onUpdate((update) => {
    const currentWindow = getWindow();
    if (currentWindow && !currentWindow.isDestroyed()) {
      currentWindow.webContents.send("library:download-update", update);
    }
  });
}
