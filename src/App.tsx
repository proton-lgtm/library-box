import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import type { AuthCredentials, AuthState, Download, Game, InstalledGame } from "./shared/types";
import { AppShell, type Page } from "./components/AppShell";
import { DeleteDialog } from "./components/DeleteDialog";
import { DownloadDialog } from "./components/DownloadDialog";
import { DownloadsPage } from "./components/DownloadsPage";
import { GameDetailsPage } from "./components/GameDetailsPage";
import { HomePage } from "./components/HomePage";
import { LibraryPage } from "./components/LibraryPage";
import { ProfileDialog } from "./components/ProfileDialog";
import { bestDownloadLink, formatDate } from "./components/format";

const INSTALL_FOLDER_KEY = "game-library.install-folder";

function App() {
  const [games, setGames] = useState<Game[]>([]);
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [library, setLibrary] = useState<InstalledGame[]>([]);
  const [page, setPage] = useState<Page>("home");
  const [selected, setSelected] = useState<Game | null>(null);
  const [search, setSearch] = useState("");
  const [destination, setDestination] = useState(
    () => localStorage.getItem(INSTALL_FOLDER_KEY) ?? "",
  );
  const [downloadDialog, setDownloadDialog] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<InstalledGame | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [busy, setBusy] = useState(true);
  const [starting, setStarting] = useState(false);
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

  const chooseDestination = async () => {
    try {
      const result = await window.library.chooseDestination();
      if (result) setDestination(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const beginDownload = async (options: { runAfter: boolean; selectedModIds: number[] }) => {
    if (!selected || !destination) return;
    const url = bestDownloadLink(selected);
    if (!url) {
      setError("No download link is configured.");
      return;
    }
    setStarting(true);
    try {
      await window.library.startDownload({
        gameId: selected.id,
        url,
        destination,
        ...options,
      });
      setDownloadDialog(false);
      setPage("downloads");
      setSelected(null);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
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
          onBack={() => setSelected(null)}
          onDownload={() => setDownloadDialog(true)}
          onLaunch={() => void runAction(() => window.library.launchGame(selected.id))}
          onOpenExternal={openExternal}
        />
      ) : page === "home" ? (
        <HomePage games={filteredGames} onSelect={setSelected} />
      ) : page === "downloads" ? (
        <DownloadsPage
          downloads={downloads}
          onPause={(gameId) => void runAction(() => window.library.pauseDownload(gameId))}
          onResume={(gameId) => void runAction(() => window.library.resumeDownload(gameId))}
          onCancel={(gameId) => void runAction(() => window.library.cancelDownload(gameId))}
        />
      ) : (
        <LibraryPage
          installed={library}
          search={search}
          onLaunch={(gameId) => void runAction(() => window.library.launchGame(gameId))}
          onStop={(gameId) => void runAction(() => window.library.stopGame(gameId))}
          onDelete={setDeleteTarget}
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
    </AppShell>
  );
}

export default App;
