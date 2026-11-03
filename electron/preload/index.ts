import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, DownloadUpdate, StartDownloadInput } from "../../src/shared/types";

const api: DesktopApi = {
  listGames: () => ipcRenderer.invoke("library:list-games"),
  listDownloads: () => ipcRenderer.invoke("library:list-downloads"),
  listLibrary: () => ipcRenderer.invoke("library:list-library"),
  chooseDestination: () => ipcRenderer.invoke("library:choose-destination"),
  startDownload: (input: StartDownloadInput) => ipcRenderer.invoke("library:start-download", input),
  pauseDownload: (gameId: number) => ipcRenderer.invoke("library:pause-download", gameId),
  resumeDownload: (gameId: number) => ipcRenderer.invoke("library:resume-download", gameId),
  cancelDownload: (gameId: number) => ipcRenderer.invoke("library:cancel-download", gameId),
  launchGame: (gameId: number) => ipcRenderer.invoke("library:launch-game", gameId),
  stopGame: (gameId: number) => ipcRenderer.invoke("library:stop-game", gameId),
  onDownloadUpdate: (callback: (update: DownloadUpdate) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, update: DownloadUpdate) => callback(update);
    ipcRenderer.on("library:download-update", listener);
    return () => ipcRenderer.removeListener("library:download-update", listener);
  },
};

contextBridge.exposeInMainWorld("library", api);
