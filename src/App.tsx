import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, ExternalLink, Minus, RefreshCw, Square, Trash2, UserRound, X } from "lucide-react";
import type { AuthState, Download, Game, InstalledGame } from "./shared/types";

type Page = "home" | "downloads" | "library";
const INSTALL_FOLDER_KEY = "game-library.install-folder";

function bestDownloadLink(game: Game): string | undefined {
  const priority = ["direct_link", "pixeldrain", "gofile", "workupload", "direct"];
  for (const key of priority) {
    if (game.downloadLinks[key]) return game.downloadLinks[key];
  }
  return Object.values(game.downloadLinks)[0];
}

function Cover({ game, className = "" }: { game: Game; className?: string }) {
  const [failed, setFailed] = useState(false);
  return failed || !game.thumbnail ? (
    <div className={`cover-fallback ${className}`} aria-label={`${game.name} cover`} />
  ) : (
    <img
      className={className}
      src={game.thumbnail}
      alt={`${game.name} cover`}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function displayLabel(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

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
  const [runAfter, setRunAfter] = useState(false);
  const [selectedModIds, setSelectedModIds] = useState<number[]>([]);
  const [downloadDialog, setDownloadDialog] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<InstalledGame | null>(null);
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
  const [profileOpen, setProfileOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"signup" | "signin">("signup");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");

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
      const snapshot = await window.library.refreshCatalog();
      setGames(snapshot.games);
      setSelected((current) =>
        current ? snapshot.games.find((game) => game.id === current.id) ?? null : null,
      );
      setCatalogStale(snapshot.stale);
      setCatalogError(snapshot.error ?? "");
      setCatalogLastSyncedAt(snapshot.lastSyncedAt);
    } catch (reason) {
      setCatalogStale(true);
      setCatalogError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCatalogRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void window.library.getAuthState().then(setAuthState).catch((reason: unknown) => {
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

  const beginDownload = async () => {
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
        runAfter,
        selectedModIds,
      });
      setDownloadDialog(false);
      setRunAfter(false);
      setSelectedModIds([]);
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

  const openProfile = () => {
    setAuthEmail(authState.email ?? "");
    setAuthPassword("");
    setAuthPasswordConfirm("");
    setAuthError("");
    setAuthMode(authState.status === "account" ? "signin" : "signup");
    setProfileOpen(true);
  };

  const submitAuth = async () => {
    if (authMode === "signup" && authPassword !== authPasswordConfirm) {
      setAuthError("The passwords do not match.");
      return;
    }
    setAuthBusy(true);
    setAuthError("");
    try {
      const nextState = authMode === "signin"
        ? await window.library.signIn({ email: authEmail, password: authPassword })
        : await window.library.upgradeAnonymousAccount({ email: authEmail, password: authPassword });
      setAuthState(nextState);
      setProfileOpen(false);
      setAuthPassword("");
      setAuthPasswordConfirm("");
    } catch (reason) {
      setAuthError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAuthBusy(false);
    }
  };

  const signOut = async () => {
    setAuthBusy(true);
    setAuthError("");
    try {
      const nextState = await window.library.signOut();
      setAuthState(nextState);
      setAuthMode("signup");
      setAuthEmail("");
      setAuthPassword("");
      setAuthPasswordConfirm("");
      if (nextState.status === "unavailable" && nextState.message) {
        setAuthError(nextState.message);
      }
    } catch (reason) {
      setAuthError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAuthBusy(false);
    }
  };

  const openExternal = (url: string) => {
    void runAction(() => window.library.openExternal(url));
  };

  const navigate = (next: Page) => {
    setSelected(null);
    setPage(next);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const gameId = deleteTarget.id;
    try {
      await window.library.deleteGame(gameId);
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

  const runWindowAction = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div className="app-shell">
      <header className="window-titlebar">
        <div className="window-drag-region" />
        <div className="window-controls">
          <button onClick={() => void runWindowAction(() => window.library.minimizeWindow())} aria-label="Minimize">
            <Minus size={16} />
          </button>
          <button onClick={() => void toggleMaximize()} aria-label={maximized ? "Restore" : "Maximize"}>
            {maximized ? <Copy size={13} /> : <Square size={13} />}
          </button>
          <button className="window-close" onClick={() => void runWindowAction(() => window.library.closeWindow())} aria-label="Close">
            <X size={17} />
          </button>
        </div>
      </header>

      <aside className="sidebar">
        <nav className="primary-nav" aria-label="Main navigation">
          <button className={!selected && page === "home" ? "nav-item active" : "nav-item"} onClick={() => navigate("home")}>
            Home
          </button>
          <button className={!selected && page === "downloads" ? "nav-item active" : "nav-item"} onClick={() => navigate("downloads")}>
            Downloads
          </button>
          <button className={!selected && page === "library" ? "nav-item active" : "nav-item"} onClick={() => navigate("library")}>
            Library
          </button>
        </nav>
      </aside>

      <main className="main-area">
        <header className="topbar">
          {page === "home" && !selected ? (
            <input
              aria-label="Search games"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search games"
            />
          ) : <div className="topbar-spacer" />}
          {page === "home" && !selected && <div className="topbar-spacer" />}
          <button className="profile-pill" onClick={openProfile} aria-label="Profile">
            <span className="profile-icon"><UserRound size={16} /></span>
            <span>
              <strong>{authState.status === "account" ? authState.email : authState.status === "anonymous" ? "Anonymous" : "Profile"}</strong>
              <small>{authState.status === "account" ? "Signed in" : authState.status === "anonymous" ? "Guest account" : "Account"}</small>
            </span>
          </button>
        </header>

        {catalogStale && (
          <div className="catalog-status" role="status">
            <span>{catalogError || "Showing the last cached catalog."}{catalogLastSyncedAt ? ` Last synced ${formatDate(catalogLastSyncedAt)}.` : ""}</span>
            <button onClick={() => void refreshCatalog()} disabled={catalogRefreshing} aria-label="Refresh catalog">
              <RefreshCw size={15} className={catalogRefreshing ? "spinning" : ""} />
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
          <section className="detail-page">
            <button className="back-link" onClick={() => setSelected(null)}>Back</button>
            <div className="detail-layout">
              <div className="detail-art"><Cover game={selected} /></div>
              <div className="detail-info">
                <h1>{selected.name}</h1>
                <div className="game-meta">
                  {selected.sizeBytes != null && <span>{formatBytes(selected.sizeBytes)}</span>}
                  {selected.version && <span>Version {selected.version}</span>}
                  {selected.lastUpdated && <span>Updated {formatDate(selected.lastUpdated)}</span>}
                  {selected.releaseDate && <span>Released {formatDate(selected.releaseDate)}</span>}
                  {selected.operatingSystems?.map((operatingSystem) => <span key={operatingSystem}>{operatingSystem}</span>)}
                </div>
                {selected.tags && selected.tags.length > 0 && (
                  <div className="game-tags">{selected.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
                )}
                {selected.description && <p className="detail-description">{selected.description}</p>}
                {selected.developerLinks && Object.keys(selected.developerLinks).length > 0 && (
                  <div className="developer-links" aria-label="Developer links">
                    {Object.entries(selected.developerLinks).map(([label, url]) => (
                      <button key={label} onClick={() => openExternal(url)}>
                        {displayLabel(label)} <ExternalLink size={13} />
                      </button>
                    ))}
                  </div>
                )}
                {Object.keys(selected.downloadLinks).length > 0 && (
                  <div className="developer-links" aria-label="Download links">
                    {Object.entries(selected.downloadLinks).map(([label, url]) => (
                      <button key={label} onClick={() => openExternal(url)}>
                        {displayLabel(label)} <ExternalLink size={13} />
                      </button>
                    ))}
                  </div>
                )}
                {selected.mods.length > 0 && (
                  <div className="game-tags" aria-label="Available mods">
                    {selected.mods.map((mod, index) => <span key={`${mod.name}-${index}`}>{mod.name}</span>)}
                  </div>
                )}
                {selected.detailsLastUpdated && (
                  <span className="details-updated">Details updated {formatDate(selected.detailsLastUpdated)}</span>
                )}
                {installedIds.has(selected.id) ? (
                  <button
                    className="button-primary"
                    onClick={() => void runAction(() => window.library.launchGame(selected.id))}
                  >
                    Play
                  </button>
                ) : (
                  <button
                    className="button-primary"
                    onClick={() => setDownloadDialog(true)}
                    disabled={!bestDownloadLink(selected)}
                  >
                    Download
                  </button>
                )}
              </div>
            </div>
          </section>
        ) : page === "home" ? (
          <section className="content-page">
            <h1 className="page-heading">Games</h1>
            {filteredGames.length ? (
              <div className="game-grid">
                {filteredGames.map((game) => (
                  <button className="game-card" key={game.id} onClick={() => setSelected(game)}>
                    <Cover game={game} className="card-cover" />
                    <span className="card-title">{game.name}</span>
                    {game.tags && game.tags.length > 0 && (
                      <span className="card-tags">{game.tags.slice(0, 3).join(" · ")}</span>
                    )}
                  </button>
                ))}
              </div>
            ) : <div className="empty-state">No games found</div>}
          </section>
        ) : page === "downloads" ? (
          <section className="list-page">
            <h1 className="page-heading">Downloads</h1>
            {downloads.length ? (
              <div className="download-list">{downloads.map((download) => (
                <article className="download-card" key={download.gameId}>
                  <Cover
                    game={{ id: download.gameId, name: download.gameName, thumbnail: download.thumbnail, downloadLinks: {}, mods: [], installDir: download.installDir }}
                    className="download-cover"
                  />
                  <div className="download-info">
                    <div className="download-info-heading">
                      <h2>{download.gameName}</h2>
                      <span className={`status-tag status-${download.status}`}>{download.status}</span>
                    </div>
                    <span>{download.error || `${formatBytes(download.bytesDownloaded)}${download.totalBytes ? ` / ${formatBytes(download.totalBytes)}` : ""}`}</span>
                    <div className="progress-track">
                      <i style={{
                        width: download.totalBytes
                          ? `${Math.min(100, download.bytesDownloaded / download.totalBytes * 100)}%`
                          : download.status === "downloading" ? "40%" : "0%",
                      }} />
                    </div>
                  </div>
                  <div className="download-actions">
                    {download.status === "downloading" ? (
                      <button onClick={() => void runAction(() => window.library.pauseDownload(download.gameId))}>Pause</button>
                    ) : download.status === "paused" || download.status === "failed" ? (
                      <button onClick={() => void runAction(() => window.library.resumeDownload(download.gameId))}>Resume</button>
                    ) : null}
                    {(download.status === "downloading" || download.status === "paused") && (
                      <button className="text-danger" onClick={() => void runAction(() => window.library.cancelDownload(download.gameId))}>Cancel</button>
                    )}
                  </div>
                </article>
              ))}</div>
            ) : <div className="empty-state">No downloads</div>}
          </section>
        ) : (
          <section className="list-page">
            <h1 className="page-heading">Library</h1>
            {library.length ? (
              <div className="library-grid">{library.map((game) => (
                <article className="library-card" key={game.id}>
                  <Cover game={game} className="library-cover" />
                  <div className="library-card-body">
                    <h2>{game.name}</h2>
                    <div className="library-actions">
                      {game.running ? (
                        <button className="button-stop" onClick={() => void runAction(() => window.library.stopGame(game.id))}>Stop</button>
                      ) : (
                        <button className="button-play" onClick={() => void runAction(() => window.library.launchGame(game.id))}>Play</button>
                      )}
                      <button
                        className="delete-game"
                        disabled={game.running}
                        onClick={() => setDeleteTarget(game)}
                      >
                        <Trash2 size={17} /> Delete
                      </button>
                    </div>
                  </div>
                </article>
              ))}</div>
            ) : <div className="empty-state">No installed games</div>}
          </section>
        )}
      </main>

      {profileOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setProfileOpen(false);
        }}>
          <section className="download-modal profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-title">
            <button className="modal-close" onClick={() => setProfileOpen(false)} aria-label="Close dialog"><X size={19} /></button>
            <h2 id="profile-title">Profile</h2>
            {authState.status === "account" ? (
              <>
                <p className="profile-email">{authState.email}</p>
                <button className="button-primary modal-submit" disabled={authBusy} onClick={() => void signOut()}>
                  {authBusy ? "Signing out…" : "Sign out"}
                </button>
              </>
            ) : (
              <>
                <div className="auth-mode-tabs" role="tablist" aria-label="Account action">
                  <button
                    role="tab"
                    aria-selected={authMode === "signup"}
                    className={authMode === "signup" ? "selected" : ""}
                    onClick={() => { setAuthMode("signup"); setAuthError(""); }}
                  >
                    Create account
                  </button>
                  <button
                    role="tab"
                    aria-selected={authMode === "signin"}
                    className={authMode === "signin" ? "selected" : ""}
                    onClick={() => { setAuthMode("signin"); setAuthError(""); }}
                  >
                    Sign in
                  </button>
                </div>
                <label className="field-label" htmlFor="account-email">Email</label>
                <input
                  id="account-email"
                  className="auth-input"
                  type="email"
                  autoComplete="email"
                  value={authEmail}
                  onChange={(event) => setAuthEmail(event.target.value)}
                />
                <label className="field-label" htmlFor="account-password">Password</label>
                <input
                  id="account-password"
                  className="auth-input"
                  type="password"
                  autoComplete={authMode === "signin" ? "current-password" : "new-password"}
                  value={authPassword}
                  onChange={(event) => setAuthPassword(event.target.value)}
                />
                {authMode === "signup" && (
                  <>
                    <label className="field-label" htmlFor="account-password-confirm">Confirm password</label>
                    <input
                      id="account-password-confirm"
                      className="auth-input"
                      type="password"
                      autoComplete="new-password"
                      value={authPasswordConfirm}
                      onChange={(event) => setAuthPasswordConfirm(event.target.value)}
                    />
                  </>
                )}
                {authState.status === "unavailable" && authState.message && (
                  <p className="profile-error">{authState.message}</p>
                )}
                {authError && <p className="profile-error" role="alert">{authError}</p>}
                <button
                  className="button-primary modal-submit"
                  disabled={authBusy || !authEmail.trim() || !authPassword}
                  onClick={() => void submitAuth()}
                >
                  {authBusy ? "Working…" : authMode === "signin" ? "Sign in" : "Create account"}
                </button>
              </>
            )}
            {authError && authState.status === "account" && <p className="profile-error" role="alert">{authError}</p>}
          </section>
        </div>
      )}

      {downloadDialog && selected && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setDownloadDialog(false);
        }}>
          <section className="download-modal" role="dialog" aria-modal="true" aria-labelledby="download-title">
            <button className="modal-close" onClick={() => setDownloadDialog(false)} aria-label="Close dialog"><X size={19} /></button>
            <h2 id="download-title">Download {selected.name}</h2>
            <label className="field-label" htmlFor="destination-folder">Install folder</label>
            <div className="folder-picker">
              <span id="destination-folder" title={destination}>{destination || "No folder selected"}</span>
              <button className="button-secondary" onClick={() => void chooseDestination()}>Browse</button>
            </div>
            {selected.mods.length > 0 && (
              <fieldset className="mod-picker">
                <legend>Mods</legend>
                <div className="mod-options">
                  {selected.mods.map((mod, index) => {
                    const modUrl = bestDownloadLink({ ...selected, downloadLinks: mod.download_links });
                    return (
                      <label className="mod-option" key={`${mod.name}-${index}`}>
                        <input
                          type="checkbox"
                          checked={selectedModIds.includes(index)}
                          disabled={!modUrl || starting}
                          onChange={(event) => {
                            setSelectedModIds((current) => event.target.checked
                              ? [...current, index]
                              : current.filter((id) => id !== index));
                          }}
                        />
                        <strong>{mod.name}</strong>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            )}
            <label className="checkbox-row">
              <input type="checkbox" checked={runAfter} onChange={(event) => setRunAfter(event.target.checked)} />
              <span>Run after install</span>
            </label>
            <button className="button-primary modal-submit" disabled={!destination || starting} onClick={() => void beginDownload()}>
              {starting ? "Starting…" : "Start download"}
            </button>
          </section>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setDeleteTarget(null);
        }}>
          <section className="download-modal delete-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title">
            <h2 id="delete-title">Delete {deleteTarget.name}?</h2>
            <p>The installed game files will be removed.</p>
            <div className="delete-actions">
              <button className="button-secondary" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="button-danger" onClick={() => void confirmDelete()}>Delete</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

export default App;
