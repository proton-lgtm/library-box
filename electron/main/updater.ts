import { app, dialog, net, shell } from "electron";
import { autoUpdater } from "electron-updater";

export const RELEASE_PAGE = "https://github.com/proton-lgtm/library-box/releases";
const RELEASE_API = "https://api.github.com/repos/proton-lgtm/library-box/releases/latest";
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

export function isNewerStableRelease(tag: string, current: string): boolean {
  const release = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  const installed = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/.exec(current);
  if (!release || !installed) return false;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(release[index]) - Number(installed[index]);
    if (difference !== 0) return difference > 0;
  }
  return Boolean(installed[4]);
}

export function supportsAutomaticUpdates(platform: string, environment: NodeJS.ProcessEnv): boolean {
  return (platform === "win32" && !environment.PORTABLE_EXECUTABLE_DIR) ||
    platform === "darwin" || (platform === "linux" && Boolean(environment.APPIMAGE));
}

export function startAutoUpdates(): () => void {
  if (!app.isPackaged) return () => {};
  let stopped = false;
  let checking = false;
  let offeredVersion: string | undefined;
  const automatic = supportsAutomaticUpdates(process.platform, process.env);
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  const onError = () => {
    // Offline access must remain usable when GitHub or the updater is unavailable.
    console.warn("Playmart update check/download failed; it will retry later.");
  };
  const onDownloaded = async (info: { version: string }) => {
    if (stopped || offeredVersion === info.version) return;
    offeredVersion = info.version;
    try {
      const choice = await dialog.showMessageBox({
        type: "info",
        title: "Playmart update ready",
        message: `Playmart ${info.version} has been downloaded.`,
        detail: "Restart to install the update. Finish any downloads and close running games first. Choosing Later will not install on exit.",
        buttons: ["Restart and install", "Later"],
        defaultId: 1,
        cancelId: 1,
      });
      if (!stopped && choice.response === 0) autoUpdater.quitAndInstall();
    } catch {
      onError();
    }
  };
  if (automatic) {
    autoUpdater.on("error", onError);
    autoUpdater.on("update-downloaded", onDownloaded);
  }

  async function check(): Promise<void> {
    if (stopped || checking) return;
    checking = true;
    try {
      if (automatic) {
        await autoUpdater.checkForUpdates();
      } else {
        const response = await net.fetch(RELEASE_API, {
          headers: { Accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error("Release lookup failed.");
        const release: unknown = await response.json();
        if (typeof release !== "object" || !release) return;
        const { tag_name: tag, draft, prerelease } = release as Record<string, unknown>;
        if (typeof tag !== "string" || draft || prerelease ||
            !isNewerStableRelease(tag, app.getVersion()) || offeredVersion === tag || stopped) return;
        offeredVersion = tag;
        const choice = await dialog.showMessageBox({
          type: "info",
          title: "Playmart update available",
          message: `Playmart ${tag} is available.`,
          detail: "This package requires a manual update. Download the matching package from GitHub Releases; your library stays in its existing data folder.",
          buttons: ["Open downloads", "Later"],
          defaultId: 1,
          cancelId: 1,
        });
        if (!stopped && choice.response === 0) await shell.openExternal(`${RELEASE_PAGE}/tag/${tag}`);
      }
    } catch {
      onError();
    } finally {
      checking = false;
    }
  }

  void check();
  const timer = setInterval(() => { void check(); }, CHECK_INTERVAL);
  timer.unref();
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    autoUpdater.removeListener("error", onError);
    autoUpdater.removeListener("update-downloaded", onDownloaded);
    app.removeListener("before-quit", stop);
  };
  app.once("before-quit", stop);
  return stop;
}
