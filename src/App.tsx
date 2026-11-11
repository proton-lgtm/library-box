import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import type { AuthCredentials, AuthState, DownloadQueueItem, Game, InstalledGame } from "./shared/types";
import { AppShell, type Page } from "./components/AppShell";
import { ApplyModsDialog } from "./components/ApplyModsDialog";
import { DeleteDialog } from "./components/DeleteDialog";
import { DownloadDialog } from "./components/DownloadDialog";
import { DownloadsPage } from "./components/DownloadsPage";
import { GameDetailsPage } from "./components/GameDetailsPage";
import { HomePage } from "./components/HomePage";
import { LibraryPage } from "./components/LibraryPage";
import { ProfileDialog } from "./components/ProfileDialog";
import { formatDate } from "./components/format";

const INSTALL_FOLDER_KEY = "game-library.install-folder";

function App() {
  const [games, setGames] = useState<Game[]>([]);
  const [downloads, setDownloads] = useState<DownloadQueueItem[]>([]);
  const [library, setLibrary] = useState<InstalledGame[]>([]);
  const [page, setPage] = useState<Page>("home");
  const [selected, setSelected] = useState<Game | null>(null);
  const [search, setSearch] = useState("");
  const [destination, setDestination] = useState(
    () => localStorage.getItem(INSTALL_FOLDER_KEY) ?? "",
  );
  const [downloadDialog, setDownloadDialog] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<InstalledGame | null>(null);
  const [modsTarget, setModsTarget] = useState<InstalledGame | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [busy, setBusy] = useState(true);
  const [starting, setStarting] = useState(false);
  const [applyingMods, setApplyingMods] = useState(false);
  const [resettingMods, setResettingMods] = useState(false);
  const [localRefreshing, setLocalRefreshing] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState("");
  const [catalogStale, setCatalogStale] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [catalogLastSyncedAt, setCatalogLastSyncedAt] = useState<string | null>(null);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const [authState, setAuthState] = useState<AuthState>({
    status: "unavailable",
    email: null,
    message: null,
  });

  const refresh = useCallback(async () => {
    try {
      const [nextGames, nextDownloads, nextLibrary] = await Promise.all([
        window.library.listGames(),
        window.library.listDownloads(),
        window.library.listLibrary(),
      ]);
      setGames(nextGames);
      setDownloads(nextDownloads);
      setLibrary(nextLibrary);
      setSelected((current) =>
        current ? nextGames.find((game) => game.id === current.id) ?? null : null,
      );
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, []);

  const refreshCatalog = useCallback(async () => {
    setCatalogRefreshing(true);
    try {
      const snapshot = await window.library?.refreshCatalog();
      setGames(snapshot.games);
      setSelected((current) =>
        current ? snapshot.games.find((game) => game.id === current.id) ?? null : null,
      );
      setCatalogStale(snapshot.stale);
      setCatalogError(snapshot.error ?? "");
      setCatalogLastSyncedAt(snapshot.lastSyncedAt);
      setAuthState(await window.library?.getAuthState());
    } catch (reason) {
      setCatalogStale(true);
      setCatalogError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCatalogRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void window.library?.getAuthState().then(setAuthState).catch((reason: unknown) => {
      setAuthState({
        status: "unavailable",
        email: null,
        message: reason instanceof Error ? reason.message : String(reason),
      });
    });
    void refreshCatalog();
    const unsubscribeDownloads = window.library?.onDownloadUpdate(() => void refresh());
    const unsubscribeWindow = window.library?.onWindowMaximized(setMaximized);
    void window.library?.isWindowMaximized().then(setMaximized).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
    const timer = window.setInterval(() => void refresh(), 2500);
    const catalogTimer = window.setInterval(() => void refreshCatalog(), 300000);
    return () => {
      unsubscribeDownloads?.();
      unsubscribeWindow?.();
      window.clearInterval(timer);
      window.clearInterval(catalogTimer);
    };
  }, [refresh, refreshCatalog]);

  useEffect(() => {
    if (destination) localStorage.setItem(INSTALL_FOLDER_KEY, destination);
  }, [destination]);

  const filteredGames = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? games.filter((game) => game.name.toLowerCase().includes(query)) : games;
  }, [games, search]);
  const installedIds = useMemo(() => new Set(library.map((game) => game.id)), [library]);
  const selectedInstalledGame = selected
    ? library.find((game) => game.id === selected.id)
    : undefined;

  const chooseDestination = async () => {
    try {
      const result = await window.library.chooseDestination();
      if (result) setDestination(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const beginDownload = async (options: { url: string; runAfter: boolean; selectedModIds: number[] }) => {
    if (!selected || !destination) return;
    setStarting(true);
    try {
      await window.library.startDownload({
        gameId: selected.id,
        destination,
        ...options,
      });
      setDownloadDialog(false);
      setPage("downloads");
      setSelected(null);
      await refresh();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (message.toLowerCase().includes("download destination") ||
          message.toLowerCase().includes("destination folder")) {
        setDestination("");
        localStorage.removeItem(INSTALL_FOLDER_KEY);
      }
      setError(message);
    } finally {
      setStarting(false);
    }
  };

  const runAction = async (action: () => Promise<void>) => {
    try {
      await action();
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const submitAuth = async (mode: "signup" | "signin", credentials: AuthCredentials) => {
    const nextState = mode === "signin"
      ? await window.library.signIn(credentials)
      : await window.library.upgradeAnonymousAccount(credentials);
    setAuthState(nextState);
    return nextState;
  };

  const signOut = async () => {
    const nextState = await window.library.signOut();
    setAuthState(nextState);
    return nextState;
  };

  const navigate = (next: Page) => {
    setSelected(null);
    setPage(next);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await window.library.deleteGame(deleteTarget.id);
      setDeleteTarget(null);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const applyMods = async (modIds: number[]) => {
    if (!modsTarget || applyingMods) return;
    setApplyingMods(true);
    try {
      await window.library.applyMods(modsTarget.id, modIds);
      setPage("downloads");
      setModsTarget(null);
      await refresh();
    } finally {
      setApplyingMods(false);
    }
  };

  const reloadLocalGames = async () => {
    if (localRefreshing) return;
    setLocalRefreshing(true);
    try {
      await window.library.reverifyLocalGames();
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLocalRefreshing(false);
    }
  };

  const removeAllMods = async () => {
    if (!modsTarget || resettingMods || applyingMods) return;
    setResettingMods(true);
    try {
      await window.library.removeAllMods(modsTarget.id);
      const installed = await window.library.listLibrary();
      setModsTarget(installed.find((game) => game.id === modsTarget.id) ?? null);
      await refresh();
    } finally {
      setResettingMods(false);
    }
  };

  const toggleMaximize = async () => {
    try {
      setMaximized(await window.library.toggleMaximizeWindow());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const runWindowAction = (action: () => Promise<void>) => {
    void action().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };

  const openExternal = (url: string) => {
    void runAction(() => window.library.openExternal(url));
  };

  return (
    <AppShell
      page={selected ? "home" : page}
      search={search}
      showSearch={!selected && (page === "home" || page === "library")}
      authState={authState}
      maximized={maximized}
      onNavigate={navigate}
      onSearch={setSearch}
      onOpenProfile={() => setProfileOpen(true)}
      onMinimize={() => runWindowAction(() => window.library.minimizeWindow())}
      onToggleMaximize={() => void toggleMaximize()}
      onClose={() => runWindowAction(() => window.library.closeWindow())}
    >
      {catalogStale && (
        <div className="catalog-status" role="status">
          <span>
            {catalogError || "Showing the last cached catalog."}
            {catalogLastSyncedAt ? ` Last synced ${formatDate(catalogLastSyncedAt)}.` : ""}
          </span>
          <button onClick={() => void refreshCatalog()} disabled={catalogRefreshing} aria-label="Refresh catalog">
            <RefreshCw size={17} className={catalogRefreshing ? "spinning" : ""} />
          </button>
        </div>
      )}
      {error && (
        <div className="toast-error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")} aria-label="Dismiss error"><X size={18} /></button>
        </div>
      )}

      {busy ? (
        <div className="loading-state"><span className="loading-ring" /></div>
      ) : selected ? (
        <GameDetailsPage
          game={selected}
          installed={installedIds.has(selected.id)}
          downloading={downloads.some((download) => download.kind === "game" && download.gameId === selected.id && !["cancelled", "completed"].includes(download.status))}
          onBack={() => setSelected(null)}
          onDownload={() => setDownloadDialog(true)}
          onViewDownloads={() => {
            setSelected(null);
            setPage("downloads");
          }}
          onLaunch={() => void runAction(() => window.library.launchGame(selected.id))}
          onApplyMods={() => {
            if (selectedInstalledGame) setModsTarget(selectedInstalledGame);
          }}
          onOpenExternal={openExternal}
          onReload={() => void refreshCatalog()}
          reloading={catalogRefreshing}
        />
      ) : page === "home" ? (
        <HomePage games={filteredGames} onSelect={setSelected} onReload={() => void refreshCatalog()} reloading={catalogRefreshing} />
      ) : page === "downloads" ? (
        <DownloadsPage
          downloads={downloads}
          onReload={() => void reloadLocalGames()}
          reloading={localRefreshing}
          onPause={(gameId) => void runAction(() => window.library.pauseDownload(gameId))}
          onResume={(gameId) => void runAction(() => window.library.resumeDownload(gameId))}
          onManual={(gameId) => void runAction(() => window.library.manualDownload(gameId))}
          onCancel={(gameId) => void runAction(() => window.library.cancelDownload(gameId))}
          onCancelMod={(id) => void runAction(async () => {
            if (!window.library.cancelModDownload) throw new Error("Mod cancellation is unavailable.");
            await window.library.cancelModDownload(id);
          })}
          onRetryMod={(id) => void runAction(async () => {
            if (!window.library.retryModDownload) throw new Error("Mod retry is unavailable.");
            await window.library.retryModDownload(id);
          })}
          onGoToLibrary={() => setPage("library")}
          onDismiss={(gameId) => void runAction(async () => {
            if (!window.library.dismissTerminalDownload) throw new Error("Queue cleanup is unavailable.");
            await window.library.dismissTerminalDownload(gameId);
          })}
          onClearFinished={() => void runAction(async () => {
            if (!window.library.clearTerminalDownloads) throw new Error("Queue cleanup is unavailable.");
            await window.library.clearTerminalDownloads();
          })}
        />
      ) : (
        <LibraryPage
          installed={library}
          onReload={() => void reloadLocalGames()}
          reloading={localRefreshing}
          search={search}
          onLaunch={(gameId) => void runAction(() => window.library.launchGame(gameId))}
          onStop={(gameId) => void runAction(() => window.library.stopGame(gameId))}
          onDelete={setDeleteTarget}
          onApplyMods={setModsTarget}
          onViewDetails={(game) => {
            setSelected(games.find((candidate) => candidate.id === game.id) ?? game);
          }}
        />
      )}

      {profileOpen && (
        <ProfileDialog
          authState={authState}
          onClose={() => setProfileOpen(false)}
          onSubmit={submitAuth}
          onSignOut={signOut}
        />
      )}
      {downloadDialog && selected && (
        <DownloadDialog
          game={selected}
          destination={destination}
          starting={starting}
          onChooseDestination={chooseDestination}
          onStart={beginDownload}
          onClose={() => setDownloadDialog(false)}
        />
      )}
      {deleteTarget && (
        <DeleteDialog
          game={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
      {modsTarget && (
        <ApplyModsDialog
          key={modsTarget.id}
          game={modsTarget}
          applying={applyingMods}
          resetting={resettingMods}
          resetProgress={downloads.find((item) => item.kind === "game" && item.gameId === modsTarget.id)}
          onRemoveAll={removeAllMods}
          onApply={applyMods}
          onClose={() => {
            if (!applyingMods && !resettingMods) setModsTarget(null);
          }}
        />
      )}
    </AppShell>
  );
}

export default App;
