import { app, BrowserWindow } from "electron";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LibraryDatabase } from "./database";
import { DownloadManager } from "./download-manager";
import { registerIpc } from "./ipc";
import { Launcher } from "./launcher";

const currentDirectory = __dirname;
let mainWindow: BrowserWindow | undefined;
let database: LibraryDatabase;
let ipcInitialized = false;

function getCatalogPath(): string {
  const packagedPath = path.join(process.resourcesPath, "catalog", "games.json");
  return app.isPackaged
    ? packagedPath
    : path.resolve(currentDirectory, "../../py_box/games.json");
}

function createWindow(downloads: DownloadManager, launcher: Launcher): void {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL ??
    pathToFileURL(path.resolve(currentDirectory, "../renderer/index.html")).href;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1050,
    minHeight: 700,
    backgroundColor: "#0b0b0d",
    title: "Redline Library",
    webPreferences: {
      preload: path.join(currentDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  if (!ipcInitialized) {
    registerIpc(() => mainWindow, database, downloads, launcher, rendererUrl);
    ipcInitialized = true;
  }
  void mainWindow.loadURL(rendererUrl);
  mainWindow.on("closed", () => { mainWindow = undefined; });
}

app.whenReady().then(() => {
  const catalogPath = getCatalogPath();
  readFileSync(catalogPath, "utf8");
  database = new LibraryDatabase(path.join(app.getPath("userData"), "library.sqlite"), catalogPath);
  database.recoverInterruptedDownloads();
  const launcher = new Launcher(database);
  const downloads = new DownloadManager(database, launcher);
  createWindow(downloads, launcher);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(downloads, launcher);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => database?.close());
