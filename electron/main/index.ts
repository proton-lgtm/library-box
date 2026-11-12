import { app, BrowserWindow, dialog, Menu, safeStorage } from "electron";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LibraryDatabase } from "./database";
import { configureDownloadBrowserSession, DownloadManager } from "./downloads/download-manager";
import { registerIpc } from "./ipc";
import { Launcher } from "./launcher";
import { LibraryManager } from "./library-manager";
import { desktopUserDataPath, portableUserDataPath } from "./portable-path";
import { createEncryptedSessionStorage, type AuthSessionStorage } from "./secure-session-storage";
import { SupabaseService } from "./supabase-service";

declare const __SUPABASE_URL__: string;
declare const __SUPABASE_PUBLISHABLE_KEY__: string;

app.setName("Playmart");
app.setPath("userData", desktopUserDataPath(app.getPath("appData")));

const currentDirectory = __dirname;
const portableDataDirectory = portableUserDataPath(process.env.PORTABLE_EXECUTABLE_DIR);
let portableDataError: Error | undefined;
if (portableDataDirectory) {
  try {
    mkdirSync(portableDataDirectory, { recursive: true });
    app.setPath("userData", portableDataDirectory);
  } catch (error) {
    portableDataError = error instanceof Error ? error : new Error(String(error));
  }
}

let mainWindow: BrowserWindow | undefined;
let database: LibraryDatabase;
let ipcInitialized = false;

function createWindow(downloads: DownloadManager, launcher: Launcher, supabase: SupabaseService): void {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL ??
    pathToFileURL(path.resolve(currentDirectory, "../renderer/index.html")).href;
  mainWindow = new BrowserWindow({
    width: 1440,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, "logo.png")
      : path.resolve(currentDirectory, "../../assets/logo.png"),
    height: 920,
    minWidth: 1050,
    minHeight: 700,
    backgroundColor: "#0b0b0d",
    title: "Playmart",
    frame: false,
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
    const library = new LibraryManager(database, launcher);
    registerIpc(() => mainWindow, database, downloads, launcher, library, supabase, rendererUrl);
    ipcInitialized = true;
  }
  mainWindow.on("maximize", () => mainWindow?.webContents.send("library:window-maximized", true));
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send("library:window-maximized", false));
  void mainWindow.loadURL(rendererUrl);
  if (process.env.OPEN_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
  mainWindow.on("closed", () => { mainWindow = undefined; });
}

void app.whenReady().then(async () => {
  if (portableDataError) {
    dialog.showErrorBox(
      "Portable data folder unavailable",
      `Playmart could not create its data folder beside the executable.\n\n${portableDataError.message}`,
    );
    app.quit();
    return;
  }
  Menu.setApplicationMenu(null);
  const userDataDirectory = app.getPath("userData");
  configureDownloadBrowserSession();
  database = new LibraryDatabase(path.join(userDataDirectory, "library.sqlite"));
  database.recoverInterruptedDownloads();
  const launcher = new Launcher(database);
  const downloads = new DownloadManager(database, launcher);
  let sessionStorage: AuthSessionStorage | undefined;
  try {
    sessionStorage = await createEncryptedSessionStorage(userDataDirectory, safeStorage);
  } catch (error) {
    console.error("Could not initialize encrypted Supabase session storage.", error);
    dialog.showErrorBox(
      "Secure sign-in unavailable",
      "The OS secure-storage service could not be initialized. Catalog browsing will remain available, but sign-in is disabled.",
    );
  }
  const supabase = new SupabaseService(
    database,
    __SUPABASE_URL__,
    __SUPABASE_PUBLISHABLE_KEY__,
    sessionStorage,
  );
  void supabase.initializeAuth().catch((error: unknown) => {
    console.error("Could not initialize Supabase authentication.", error);
  });
  createWindow(downloads, launcher, supabase);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(downloads, launcher, supabase);
  });
}).catch((error: unknown) => {
  console.error("Could not start the application.", error);
  dialog.showErrorBox(
    "Application startup failed",
    error instanceof Error ? error.message : String(error),
  );
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => database?.close());
