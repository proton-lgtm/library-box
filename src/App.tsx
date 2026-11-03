import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Download as DownloadIcon,
  Gamepad2,
  HardDriveDownload,
  Home,
  Library,
  Pause,
  Play,
  Search,
  ShoppingBag,
  Square,
  X,
} from "lucide-react";
import type { Download, Game, InstalledGame } from "./shared/types";

type Page = "home" | "downloads" | "library";
const INSTALL_FOLDER_KEY = "redline.install-folder";

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
    <div className={`cover-fallback ${className}`} aria-label={`${game.name} cover`}>
      <Gamepad2 size={30} />
      <span>{game.name}</span>
    </div>
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

function App() {
  const [games, setGames] = useState<Game[]>([]);
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [library, setLibrary] = useState<InstalledGame[]>([]);
  const [page, setPage] = useState<Page>("home");
  const [storeFocused, setStoreFocused] = useState(false);
  const [selected, setSelected] = useState<Game | null>(null);
  const [search, setSearch] = useState("");
  const [destination, setDestination] = useState(
    () => localStorage.getItem(INSTALL_FOLDER_KEY) ?? "",
  );
  const [runAfter, setRunAfter] = useState(false);
  const [selectedModIds, setSelectedModIds] = useState<number[]>([]);
  const [downloadDialog, setDownloadDialog] = useState(false);
  const [busy, setBusy] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

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

  useEffect(() => {
    void refresh();
    const unsubscribe = window.library.onDownloadUpdate(() => void refresh());
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (destination) localStorage.setItem(INSTALL_FOLDER_KEY, destination);
  }, [destination]);

  useEffect(() => {
    if (page === "home" && storeFocused) {
      document.getElementById("store-section")?.scrollIntoView({ behavior: "smooth" });
    }
  }, [page, storeFocused]);

  const filteredGames = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query
      ? games.filter((game) => game.name.toLowerCase().includes(query))
      : games;
  }, [games, search]);
  const installedIds = useMemo(() => new Set(library.map((game) => game.id)), [library]);
  const activeDownloads = downloads.filter((item) =>
    item.status === "downloading" || item.status === "paused",
  );
  const totalDownloadBytes = activeDownloads.reduce(
    (total, item) => total + item.bytesDownloaded,
    0,
  );
  const totalKnownDownloadBytes = activeDownloads.reduce(
    (total, item) => total + (item.totalBytes ?? 0),
    0,
  );
  const downloadProgress = totalKnownDownloadBytes
    ? Math.min(100, totalDownloadBytes / totalKnownDownloadBytes * 100)
    : 0;

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
      setError("This game has no configured download link.");
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

  const navigate = (next: Page) => {
    setSelected(null);
    setPage(next);
    setStoreFocused(false);
  };

  const openStore = () => {
    setSelected(null);
    setPage("home");
    setStoreFocused(true);
  };

  const featuredGame = filteredGames[0];
  const featuredInstalled = featuredGame ? installedIds.has(featuredGame.id) : false;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate("home")} aria-label="Redline home">
          <span className="brand-mark"><i /></span>
          <span className="brand-wordmark">REDLINE<small>GAME LIBRARY</small></span>
        </button>

        <nav className="primary-nav" aria-label="Main navigation">
          <div className="nav-section-label">DISCOVER</div>
          <button
            className={!selected && page === "home" && !storeFocused ? "nav-item active" : "nav-item"}
            onClick={() => navigate("home")}
          >
            <Home size={17} /> Home
          </button>
          <button
            className={!selected && page === "home" && storeFocused ? "nav-item nav-store active" : "nav-item nav-store"}
            onClick={openStore}
          >
            <ShoppingBag size={17} /> Store <ChevronDown className="nav-chevron" size={14} />
          </button>
          <button
            className={!selected && page === "downloads" ? "nav-item active" : "nav-item"}
            onClick={() => navigate("downloads")}
          >
            <ArrowDownToLine size={17} /> Downloads
            {activeDownloads.length > 0 && (
              <span className="nav-count">{activeDownloads.length}</span>
            )}
          </button>

          <div className="nav-section-label nav-section-library">COLLECTION</div>
          <button
            className={!selected && page === "library" ? "nav-item active" : "nav-item"}
            onClick={() => navigate("library")}
          >
            <Library size={17} /> Library <ChevronDown className="nav-chevron" size={14} />
            <span className="nav-count">{library.length}</span>
          </button>
        </nav>

        <div className="sidebar-bottom">
          <button
            className="download-summary"
            onClick={() => navigate("downloads")}
            aria-label="Open download queue"
          >
            <span className="download-summary-heading">
              <span>Downloads</span>
              <span>{activeDownloads.length} active</span>
            </span>
            <span className="sidebar-progress">
              <i style={{ width: `${downloadProgress}%` }} />
            </span>
            <span className="download-summary-foot">
              {activeDownloads.length
                ? `${formatBytes(totalDownloadBytes)} transferred`
                : "Your queue is clear"}
              <ChevronRight size={13} />
            </span>
          </button>
          <div className="sidebar-foot">
            <span className="brand-mark brand-mark-small"><i /></span>
            <span><strong>Redline Library</strong><small>LOCAL COLLECTION</small></span>
            <span className="online-dot" />
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <label className="search-box">
            <Search size={17} />
            <input
              aria-label="Search games"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search for games..."
            />
            <kbd>⌕</kbd>
          </label>
          <div className="topbar-spacer" />
          <div className="local-pill"><span className="online-dot" /> LOCAL LIBRARY</div>
          <div className="profile-pill">
            <span className="profile-icon">L</span>
            <span><strong>Local profile</strong><small>On this device</small></span>
            <ChevronDown size={14} />
          </div>
        </header>

        {error && (
          <div className="toast-error" role="alert">
            <CircleAlert size={17} />
            <span>{error}</span>
            <button onClick={() => setError("")} aria-label="Dismiss error"><X size={15} /></button>
          </div>
        )}

        {busy ? (
          <div className="loading-state"><span className="loading-ring" />Loading your library…</div>
        ) : selected ? (
          <section className="detail-page">
            <button className="back-link" onClick={() => setSelected(null)}>
              <ArrowLeft size={16} /> BACK TO STORE
            </button>
            <div className="detail-layout">
              <div className="detail-art"><Cover game={selected} /></div>
              <div className="detail-info">
                <div className="eyebrow"><span className="live-pip" /> GAME DETAILS</div>
                <h1>{selected.name}</h1>
                <p className="detail-description">
                  Discover {selected.name}, manage its downloads, and keep it ready to play in your local library.
                </p>
                <div className="meta-row">
                  <span>{Object.keys(selected.downloadLinks).join(" · ") || "No download configured"}</span>
                  {selected.mods.length > 0 && (
                    <span>{selected.mods.length} MOD{selected.mods.length === 1 ? "" : "S"}</span>
                  )}
                  {installedIds.has(selected.id) && <span className="installed-badge"><Check size={12} /> IN LIBRARY</span>}
                </div>
                <div className="detail-actions">
                  {installedIds.has(selected.id) ? (
                    <button
                      className="button-primary"
                      onClick={() => void runAction(() => window.library.launchGame(selected.id))}
                    >
                      <Play size={16} fill="currentColor" /> PLAY GAME
                    </button>
                  ) : (
                    <button
                      className="button-primary"
                      onClick={() => setDownloadDialog(true)}
                      disabled={!bestDownloadLink(selected)}
                    >
                      <DownloadIcon size={16} /> DOWNLOAD GAME
                    </button>
                  )}
                  <span className="detail-caption">Your games stay on this device.</span>
                </div>
                <div className="detail-source">
                  <span>DOWNLOAD SOURCE</span>
                  <strong>{Object.keys(selected.downloadLinks).join(", ") || "Not configured"}</strong>
                </div>
              </div>
            </div>
          </section>
        ) : page === "home" ? (
          <div className="content-page">
            {featuredGame && !search && (
              <section className="hero">
                <Cover game={featuredGame} className="hero-image" />
                <div className="hero-shade" />
                <div className="hero-content">
                  <div className="eyebrow"><span className="live-pip" /> FEATURED GAME</div>
                  <h1>{featuredGame.name}</h1>
                  <p>
                    A new adventure is waiting. Explore your collection, get it installed, and pick up where you left off.
                  </p>
                  <div className="hero-actions">
                    <button
                      className="button-primary"
                      onClick={() => featuredInstalled
                        ? void runAction(() => window.library.launchGame(featuredGame.id))
                        : setSelected(featuredGame)}
                    >
                      {featuredInstalled
                        ? <><Play size={16} fill="currentColor" /> PLAY NOW</>
                        : <>VIEW GAME <ChevronRight size={16} /></>}
                    </button>
                    <button className="hero-link" onClick={() => navigate("library")}>
                      MY LIBRARY <ChevronRight size={15} />
                    </button>
                  </div>
                </div>
                <div className="hero-caption">REDLINE <span>•</span> YOUR GAME COLLECTION</div>
                <div className="hero-index"><b>01</b><span>/</span>{String(games.length).padStart(2, "0")}</div>
              </section>
            )}
            <section className="game-section" id="store-section">
              <div className="section-heading">
                <div>
                  <div className="eyebrow muted">{search ? "FIND YOUR NEXT GAME" : "PICK UP SOMETHING NEW"}</div>
                  <h2>{search ? "Search results" : "Your games"} <span className="section-count">{filteredGames.length}</span></h2>
                </div>
                <button className="section-link" onClick={() => setSearch("")}>
                  {library.length} IN LIBRARY <ChevronRight size={15} />
                </button>
              </div>
              {filteredGames.length ? (
                <div className="game-grid">
                  {filteredGames.map((game, index) => (
                    <button className="game-card" key={game.id} onClick={() => setSelected(game)}>
                      <div className="card-cover-wrap">
                        <Cover game={game} className="card-cover" />
                        {installedIds.has(game.id) ? (
                          <span className="owned-tag"><Check size={11} /> IN LIBRARY</span>
                        ) : (
                          <span className="card-index">{String(index + 1).padStart(2, "0")}</span>
                        )}
                        <span className="card-open"><ChevronRight size={17} /></span>
                      </div>
                      <div className="card-meta">
                        <div className="card-title">{game.name}</div>
                        <div className="card-creator">
                          {Object.keys(game.downloadLinks).join(" · ") || "No download link"}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty-state"><Search size={25} /><strong>No games found</strong><span>Try another title.</span></div>
              )}
            </section>
            <footer className="page-foot">YOUR COLLECTION <span>•</span> STORED LOCALLY ON THIS DEVICE</footer>
          </div>
        ) : page === "downloads" ? (
          <section className="list-page">
            <div className="page-title-row">
              <div>
                <div className="eyebrow muted">YOUR DOWNLOAD QUEUE</div>
                <h1>Downloads <span className="section-count">{downloads.length}</span></h1>
                <p>Track installs and manage active downloads.</p>
              </div>
              <div className="page-title-icon"><DownloadIcon size={22} /></div>
            </div>
            {downloads.length ? (
              <div className="download-list">{downloads.map((download) => (
                <article className="download-card" key={download.gameId}>
                  <img src={download.thumbnail} alt="" />
                  <div className="download-info">
                    <div className="download-info-heading">
                      <h3>{download.gameName}</h3>
                      <span className={`status-tag status-${download.status}`}>{download.status}</span>
                    </div>
                    <span>
                      {download.error || `${formatBytes(download.bytesDownloaded)}${download.totalBytes ? ` / ${formatBytes(download.totalBytes)}` : ""}`}
                    </span>
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
                      <button className="icon-button" onClick={() => void runAction(() => window.library.pauseDownload(download.gameId))} aria-label={`Pause ${download.gameName}`}><Pause size={16} /></button>
                    ) : download.status === "paused" || download.status === "failed" ? (
                      <button className="icon-button" onClick={() => void runAction(() => window.library.resumeDownload(download.gameId))} aria-label={`Resume ${download.gameName}`}><Play size={16} /></button>
                    ) : null}
                    {(download.status === "downloading" || download.status === "paused") && (
                      <button className="icon-button danger" onClick={() => void runAction(() => window.library.cancelDownload(download.gameId))} aria-label={`Cancel ${download.gameName}`}><X size={16} /></button>
                    )}
                    {download.status === "installed" && <Check size={16} />}
                  </div>
                </article>
              ))}</div>
            ) : (
              <div className="empty-state large"><DownloadIcon size={30} /><strong>No downloads yet</strong><span>Choose a game from Home to start an install.</span></div>
            )}
          </section>
        ) : (
          <section className="list-page">
            <div className="page-title-row">
              <div>
                <div className="eyebrow muted">INSTALLED ON THIS DEVICE</div>
                <h1>My Library <span className="section-count">{library.length}</span></h1>
                <p>All your installed games, ready when you are.</p>
              </div>
              <div className="page-title-icon"><Library size={22} /></div>
            </div>
            {library.length ? (
              <div className="library-grid">{library.map((game) => (
                <article className="library-card" key={game.id}>
                  <Cover game={game} className="library-cover" />
                  <div className="library-card-body">
                    <h3>{game.name}</h3>
                    <div className="library-actions">
                      {game.running ? (
                        <button className="button-stop" onClick={() => void runAction(() => window.library.stopGame(game.id))}><Square size={14} /> STOP</button>
                      ) : (
                        <button className="button-play" onClick={() => void runAction(() => window.library.launchGame(game.id))}><Play size={14} fill="currentColor" /> PLAY</button>
                      )}
                      <span className={game.running ? "run-state running" : "run-state"}><i /> {game.running ? "RUNNING" : "READY"}</span>
                    </div>
                    <div className="install-path" title={game.installDir}><HardDriveDownload size={13} /> {game.installDir}</div>
                  </div>
                </article>
              ))}</div>
            ) : (
              <div className="empty-state large"><Gamepad2 size={32} /><strong>Your library is waiting</strong><span>Download a game and it will appear here.</span></div>
            )}
          </section>
        )}
      </main>

      {downloadDialog && selected && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setDownloadDialog(false);
        }}>
          <section className="download-modal" role="dialog" aria-modal="true" aria-labelledby="download-title">
            <button className="modal-close" onClick={() => setDownloadDialog(false)} aria-label="Close dialog"><X size={18} /></button>
            <div className="eyebrow"><span className="live-pip" /> INSTALL GAME</div>
            <h2 id="download-title">Download {selected.name}</h2>
            <p>Choose where to install the game. Your archive and installed files will stay in this folder.</p>
            <span className="field-label">DESTINATION FOLDER</span>
            <div className="folder-picker">
              <span title={destination}>{destination || "No folder selected"}</span>
              <button className="button-secondary" onClick={() => void chooseDestination()}>BROWSE</button>
            </div>
            {selected.mods.length > 0 && (
              <fieldset className="mod-picker">
                <legend>OPTIONAL MODS</legend>
                <p>Select any mods to download and apply during installation.</p>
                <div className="mod-options">
                  {selected.mods.map((mod, index) => {
                    const modUrl = bestDownloadLink({
                      ...selected,
                      downloadLinks: mod.download_links,
                    });
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
                        <span className="mod-option-copy">
                          <strong>{mod.name}</strong>
                          <small>{modUrl ? Object.keys(mod.download_links).join(" · ") : "No download link configured"}</small>
                        </span>
                        <span className="mod-option-state">{modUrl ? "OPTIONAL" : "UNAVAILABLE"}</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            )}
            <label className="checkbox-row">
              <input type="checkbox" checked={runAfter} onChange={(event) => setRunAfter(event.target.checked)} />
              <span>Auto-run after download</span>
            </label>
            <button className="button-primary modal-submit" disabled={!destination || starting} onClick={() => void beginDownload()}>
              {starting ? "STARTING…" : <><DownloadIcon size={16} /> START DOWNLOAD</>}
            </button>
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
