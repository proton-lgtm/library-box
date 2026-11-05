import { contextBridge, ipcRenderer } from "electron";
import type { AuthCredentials, DesktopApi, DownloadUpdate, StartDownloadInput } from "../../src/shared/types";

const api: DesktopApi = {
  listGames: () => ipcRenderer.invoke("library:list-games"),
  refreshCatalog: () => ipcRenderer.invoke("library:refresh-catalog"),
  getAuthState: () => ipcRenderer.invoke("library:get-auth-state"),
  signIn: (credentials: AuthCredentials) => ipcRenderer.invoke("library:sign-in", credentials),
  upgradeAnonymousAccount: (credentials: AuthCredentials) => ipcRenderer.invoke("library:upgrade-account", credentials),
  signOut: () => ipcRenderer.invoke("library:sign-out"),
  openExternal: (url: string) => ipcRenderer.invoke("library:open-external", url),
  listDownloads: () => ipcRenderer.invoke("library:list-downloads"),
  listLibrary: () => ipcRenderer.invoke("library:list-library"),
  chooseDestination: () => ipcRenderer.invoke("library:choose-destination"),
  startDownload: (input: StartDownloadInput) => ipcRenderer.invoke("library:start-download", input),
  pauseDownload: (gameId: number) => ipcRenderer.invoke("library:pause-download", gameId),
  resumeDownload: (gameId: number) => ipcRenderer.invoke("library:resume-download", gameId),
  cancelDownload: (gameId: number) => ipcRenderer.invoke("library:cancel-download", gameId),
  launchGame: (gameId: number) => ipcRenderer.invoke("library:launch-game", gameId),
  stopGame: (gameId: number) => ipcRenderer.invoke("library:stop-game", gameId),
  deleteGame: (gameId: number) => ipcRenderer.invoke("library:delete-game", gameId),
  minimizeWindow: () => ipcRenderer.invoke("library:minimize-window"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("library:toggle-maximize-window"),
  isWindowMaximized: () => ipcRenderer.invoke("library:is-window-maximized"),
  closeWindow: () => ipcRenderer.invoke("library:close-window"),
  onDownloadUpdate: (callback: (update: DownloadUpdate) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, update: DownloadUpdate) => callback(update);
    ipcRenderer.on("library:download-update", listener);
    return () => ipcRenderer.removeListener("library:download-update", listener);
  },
  onWindowMaximized: (callback: (maximized: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, maximized: boolean) => callback(maximized);
    ipcRenderer.on("library:window-maximized", listener);
    return () => ipcRenderer.removeListener("library:window-maximized", listener);
  },
};

contextBridge.exposeInMainWorld("library", api);
