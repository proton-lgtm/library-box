import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleAlert,
  CirclePlay,
  Download,
  Gamepad2,
  HardDriveDownload,
  Home,
  Library,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  Search,
  ShieldCheck,
  StopCircle,
  X,
} from "lucide-react";
import type { Download as DownloadItem, DownloadProgress as ProgressEvent, Game, InstalledGame } from "./types";
import { formatBytes as prettySize } from "./utils";

type Page = "home" | "library" | "downloads";

function Cover({
  src,
  title,
  className = "",
}: {
  src: string;
  title: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  return failed || !src ? (
    <div className={`cover-fallback ${className}`}>
      <Gamepad2 size={34} />
      <span>{title}</span>
    </div>
  ) : (
    <img
      className={className}
      src={src}
      alt={`${title} cover`}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function App() {
  const [games, setGames] = useState<Game[]>([]);
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [library, setLibrary] = useState<InstalledGame[]>([]);
  const [page, setPage] = useState<Page>("home");
  const [selected, setSelected] = useState<Game | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [modalGame, setModalGame] = useState<Game | null>(null);
  const [folder, setFolder] = useState("");
  const [runAfter, setRunAfter] = useState(false);
  const [starting, setStarting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [nextGames, nextDownloads, nextLibrary] = await Promise.all([
        invoke<Game[]>("list_games"),
        invoke<DownloadItem[]>("list_downloads"),
        invoke<InstalledGame[]>("list_library"),
      ]);
      setGames(nextGames);
      setDownloads(nextDownloads);
      setLibrary(nextLibrary);
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<ProgressEvent>("download-progress", (event) => {
      const update = event.payload;
      setDownloads((items) =>
        items.map((item) =>
          item.gameId === update.gameId
            ? {
                ...item,
                status: update.status,
                bytesDownloaded: update.bytesDownloaded,
                totalBytes: update.totalBytes,
                error: update.error,
              }
            : item,
        ),
      );
      void refresh();
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });
    return () => {
      active = false;
      window.clearInterval(timer);
      unlisten?.();
    };
  }, [refresh]);

  const filteredGames = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return games;
    return games.filter((game) =>
      `${game.title} ${game.creator} ${game.genre}`.toLowerCase().includes(normalized),
    );
  }, [games, query]);

  const topGame = selected ?? games[0];
  const activeCount = downloads.filter((item) =>
    ["downloading", "paused", "failed"].includes(item.status),
  ).length;

  const report = (operation: Promise<unknown>) =>
    operation
      .then(() => {
        setActionError("");
        return refresh();
      })
      .catch((e: unknown) => setActionError(String(e)));

  const beginDownload = async () => {
    if (!modalGame || !folder) return;
    setStarting(true);
    try {
      await invoke("start_download", {
        gameId: modalGame.id,
        destination: folder,
        runAfter,
      });
      setModalGame(null);
      setFolder("");
      setRunAfter(false);
      setSelected(null);
      setPage("downloads");
      setActionError("");
      await refresh();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setStarting(false);
    }
  };

  const chooseFolder = async () => {
    try {
      const choice = await open({ directory: true, multiple: false, title: "Choose game install folder" });
      if (typeof choice === "string") setFolder(choice);
    } catch (e) {
      setActionError(`Could not open folder picker: ${String(e)}`);
    }
  };

  const openGame = (game: Game) => {
    setSelected(game);
    setPage("home");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const goBack = () => {
    setSelected(null);
    setActionError("");
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => { setPage("home"); goBack(); }} aria-label="Redline home">
          <span className="brand-mark"><Gamepad2 size={21} /></span>
          <span>RED<span className="brand-red">LINE</span><small>GAME HUB</small></span>
        </button>

        <div className="nav-label">YOUR SPACE</div>
        <nav className="primary-nav" aria-label="Main navigation">
          <button className={page === "home" && !selected ? "nav-item active" : "nav-item"} onClick={() => { setPage("home"); goBack(); }}>
            <Home size={18} /> Discover
          </button>
          <button className={page === "library" ? "nav-item active" : "nav-item"} onClick={() => { setPage("library"); goBack(); }}>
            <Library size={18} /> My Library <span className="nav-count">{library.length}</span>
          </button>
          <button className={page === "downloads" ? "nav-item active" : "nav-item"} onClick={() => { setPage("downloads"); goBack(); }}>
            <ArrowDownToLine size={18} /> Downloads
            {activeCount > 0 && <span className="nav-count nav-alert">{activeCount}</span>}
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="status-card">
            <ShieldCheck size={17} />
            <span><strong>Local first</strong><small>Your library stays on this device</small></span>
          </div>
          <div className="sidebar-foot"><span className="online-dot" /> REDLINE DESKTOP <span>v0.1.0</span></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>REDLINE</span><ChevronRight size={14} /><strong>{selected ? "GAME DETAILS" : page.toUpperCase()}</strong></div>
          <label className="search-box">
            <Search size={17} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search games..." />
            <kbd>⌘ K</kbd>
          </label>
          <button className="avatar" title="Local profile">R</button>
        </header>

        {error && <div className="error-banner"><CircleAlert size={17} /> {error}</div>}
        {actionError && <div className="toast-error"><CircleAlert size={17} /> <span>{actionError}</span><button onClick={() => setActionError("")} aria-label="Dismiss"><X size={15} /></button></div>}

        {busy ? (
          <div className="loading-state"><LoaderCircle className="spin" size={28} /><span>Loading your game hub…</span></div>
        ) : selected ? (
          <section className="detail-page">
            <button className="back-link" onClick={goBack}><ArrowLeft size={17} /> BACK TO DISCOVER</button>
            <div className="detail-layout">
              <div className="detail-art"><Cover src={selected.coverUrl} title={selected.title} /></div>
              <div className="detail-info">
                <div className="eyebrow"><span className="live-pip" /> FEATURED FROM ITCH.IO</div>
                <h1>{selected.title}</h1>
                <p className="creator-line">A game by <strong>{selected.creator}</strong></p>
                <div className="meta-row"><span>{selected.genre || "Visual Novel"}</span><span>{selected.published || "itch.io"}</span><span>REN’PY</span></div>
                <p className="detail-description">{selected.description || "A story-driven game made with Ren'Py. Visit its itch.io page for full details, screenshots, and creator information."}</p>
                <div className="detail-actions">
                  <button className="button-primary" onClick={() => {
                    setActionError("");
                    if (selected.downloadUrl && !selected.browserOnly) {
                      setModalGame(selected);
                    } else {
                      void openUrl(selected.gameUrl).catch((e: unknown) => setActionError(String(e)));
                    }
                  }}>
                    <Download size={18} /> {selected.downloadStatus === "installed" ? "INSTALL ANOTHER COPY" : selected.downloadUrl && !selected.browserOnly ? "DOWNLOAD GAME" : "OPEN ON ITCH.IO"}
                  </button>
                  <button className="button-secondary" onClick={() => void openUrl(selected.gameUrl).catch((e: unknown) => setActionError(String(e)))}>VIEW ON ITCH.IO <ArrowUpRight size={16} /></button>
                </div>
                {!selected.downloadUrl && <p className="hint-text">{selected.browserOnly ? "This entry is browser-only and has no desktop archive. Open itch.io to play it in your browser." : "No verified public desktop archive is available to Redline yet. Open itch.io to check the creator’s available versions."}</p>}
                {selected.downloadStatus === "installed" && <div className="installed-note"><Check size={16} /> In your library</div>}
              </div>
            </div>
            <div className="detail-source"><span>LISTING SOURCE</span><button onClick={() => void openUrl(selected.gameUrl).catch((e: unknown) => setActionError(String(e)))}>{selected.gameUrl} <ArrowUpRight size={14} /></button></div>
          </section>
        ) : page === "home" ? (
          <div className="content-page">
            {topGame && !query && (
              <section className="hero">
                <Cover src={topGame.coverUrl} title={topGame.title} className="hero-image" />
                <div className="hero-shade" />
                <div className="hero-content">
                  <div className="eyebrow"><span className="live-pip" /> TRENDING ON ITCH.IO <span className="hero-separator">/</span> MADE WITH REN’PY</div>
                  <h1>{topGame.title}</h1>
                  <p>Discover indie stories, unforgettable characters, and worlds worth getting lost in.</p>
                  <div className="hero-actions">
                    <button className="button-primary" onClick={() => openGame(topGame)}><Play size={17} fill="currentColor" /> EXPLORE GAME</button>
                    <button onClick={() => void openUrl(topGame.gameUrl).catch((e: unknown) => setActionError(String(e)))} className="hero-link">OPEN ON ITCH.IO <ArrowUpRight size={15} /></button>
                  </div>
                </div>
                <div className="hero-index"><b>01</b><span>/</span>{String(games.length).padStart(2, "0")}</div>
                <div className="hero-caption">POPULAR PICKS <span>•</span> UPDATED FROM ITCH.IO</div>
              </section>
            )}
            <section className="game-section">
              <div className="section-heading">
                <div><div className="eyebrow muted">THE ITCH.IO COLLECTION</div><h2>{query ? "Search results" : "Pick your next story"} <span className="section-count">{filteredGames.length}</span></h2></div>
                <div className="section-tools"><span className="sort-dot" /> POPULAR ON ITCH.IO</div>
              </div>
              {filteredGames.length ? (
                <div className="game-grid">
                  {filteredGames.map((game, i) => (
                    <button className="game-card" key={game.id} onClick={() => openGame(game)}>
                      <div className="card-cover-wrap">
                        <Cover src={game.coverUrl} title={game.title} className="card-cover" />
                        <span className="rank-tag">{String(i + 1).padStart(2, "0")}</span>
                        {game.downloadStatus === "installed" && <span className="owned-tag"><Check size={12} /> IN LIBRARY</span>}
                        <span className="card-open"><ChevronRight size={19} /></span>
                      </div>
                      <div className="card-meta"><div className="card-title">{game.title}</div><div className="card-creator">{game.creator} <span>•</span> {game.genre || "Visual Novel"}</div></div>
                    </button>
                  ))}
                </div>
              ) : <div className="empty-state"><Search size={25} /><strong>No games found</strong><span>Try another title or creator name.</span></div>}
            </section>
            <footer className="page-foot">GAME LIST ORDERED BY ITCH.IO POPULARITY <span>•</span> COVERS AND DOWNLOADS SERVED BY CREATORS’ ITCH.IO PAGES</footer>
          </div>
        ) : page === "library" ? (
          <section className="list-page">
            <div className="page-title-row"><div><div className="eyebrow muted">YOUR COLLECTION</div><h1>My Library <span className="section-count">{library.length}</span></h1><p>Games installed on this device. Select one to launch it.</p></div><div className="page-title-icon"><Library size={24} /></div></div>
            {library.length ? (
              <div className="library-grid">{library.map((game) => (
                <article className="library-card" key={game.gameId}>
                  <Cover src={game.coverUrl} title={game.title} className="library-cover" />
                  <div className="library-card-body"><div><h3>{game.title}</h3><span>{game.creator}</span></div><div className="library-actions">
                    {game.running ? <button className="button-stop" onClick={() => void report(invoke("stop_game", { gameId: game.gameId }))}><StopCircle size={16} /> STOP</button> : <button className="button-play" onClick={() => void report(invoke("launch_game", { gameId: game.gameId }))}><Play size={15} fill="currentColor" /> PLAY</button>}
                    <span className={game.running ? "run-state running" : "run-state"}><i /> {game.running ? "RUNNING" : "READY"}</span>
                  </div><div className="install-path" title={game.installDir}><HardDriveDownload size={13} /> {game.installDir}</div></div>
                </article>
              ))}</div>
            ) : <div className="empty-state large"><Gamepad2 size={32} /><strong>Your library is waiting</strong><span>Browse the collection and install a game to get started.</span><button className="button-primary" onClick={() => setPage("home")}>EXPLORE GAMES <ChevronRight size={16} /></button></div>}
          </section>
        ) : (
          <section className="list-page">
            <div className="page-title-row"><div><div className="eyebrow muted">TRANSFER CENTER</div><h1>Downloads <span className="section-count">{downloads.length}</span></h1><p>Manage installs in progress and retry failed downloads.</p></div><div className="page-title-icon"><ArrowDownToLine size={24} /></div></div>
            {downloads.length ? (
              <div className="download-list">{downloads.map((item) => {
                const pct = item.totalBytes && item.totalBytes > 0 ? Math.min(100, Math.round(item.bytesDownloaded / item.totalBytes * 100)) : null;
                const game = games.find((entry) => entry.id === item.gameId);
                return <article className="download-card" key={item.gameId}>
                  <Cover src={item.coverUrl} title={item.title} className="download-cover" />
                  <div className="download-main"><div className="download-heading"><div><h3>{item.title}</h3><span className={`download-status status-${item.status}`}>{item.status === "downloading" ? "DOWNLOADING" : item.status.toUpperCase()}</span></div><span className="download-size">{prettySize(item.bytesDownloaded)}{item.totalBytes ? ` / ${prettySize(item.totalBytes)}` : ""}</span></div>
                    <div className="progress-track"><div className={`progress-fill ${item.status}`} style={{ width: `${pct ?? (item.status === "downloading" ? 18 : 100)}%` }} /></div>
                    <div className="download-foot"><span>{item.error || (pct !== null ? `${pct}% complete` : item.status === "downloading" ? "Receiving data…" : item.status === "installed" ? "Installed successfully" : item.installDir)}</span><div className="download-controls">
                      {item.status === "downloading" && <button title="Pause download" onClick={() => void report(invoke("pause_download", { gameId: item.gameId }))}><Pause size={16} /></button>}
                      {item.status === "paused" && <button title="Resume download" onClick={() => void report(invoke("resume_download", { gameId: item.gameId }))}><CirclePlay size={17} /></button>}
                      {item.status === "failed" && <button title="Retry download" onClick={() => {if(game){setFolder(item.installDir.replace(/[\\/][^\\/]+$/, ""));setModalGame(game);}}}><CirclePlay size={17} /></button>}
                      {item.status !== "installed" && <button title="Cancel download" onClick={() => void report(invoke("cancel_download", { gameId: item.gameId }))}><X size={16} /></button>}
                      {item.status === "installed" && <span className="completed-mark"><Check size={16} /> READY</span>}
                    </div></div>
                  </div>
                </article>;
              })}</div>
            ) : <div className="empty-state large"><ArrowDownToLine size={30} /><strong>No downloads yet</strong><span>Choose a game from Discover and start an install.</span><button className="button-primary" onClick={() => setPage("home")}>BROWSE GAMES <ChevronRight size={16} /></button></div>}
          </section>
        )}
      </main>

      {modalGame && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModalGame(null); }}>
          <section className="download-modal" role="dialog" aria-modal="true" aria-labelledby="download-title">
            <button className="modal-close" onClick={() => setModalGame(null)} aria-label="Close"><X size={18} /></button>
            <div className="modal-icon"><Download size={21} /></div>
            <div className="eyebrow muted">NEW INSTALL</div>
            <h2 id="download-title">Download {modalGame.title}</h2>
            <p className="modal-copy">Choose where Redline should install this game. The download runs in the background and can be managed from Downloads.</p>
            <label className="field-label">INSTALL LOCATION</label>
            <div className="folder-picker"><span title={folder}>{folder || "Choose a folder on this device"}</span><button onClick={() => void chooseFolder()}><Plus size={15} /> BROWSE</button></div>
            <label className="check-row">
              <input type="checkbox" checked={runAfter} onChange={(event) => setRunAfter(event.target.checked)} />
              <span className="custom-check"><Check size={13} /></span>
              <span><strong>Launch when installation finishes</strong><small>Start the game automatically after it is installed.</small></span>
            </label>
            <div className="modal-actions"><button className="button-secondary" onClick={() => setModalGame(null)}>CANCEL</button><button className="button-primary" disabled={!folder || starting} onClick={() => void beginDownload()}>{starting ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />} START DOWNLOAD</button></div>
            <div className="modal-safety"><ShieldCheck size={14} /> Downloads come directly from a verified public itch.io archive.</div>
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
