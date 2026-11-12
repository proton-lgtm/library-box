"use client";

import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { DEMO_GAMES, createDemoState, demoReducer } from "@/lib/demo-state";

type DemoPage = "home" | "downloads" | "library";
type DemoGame = (typeof DEMO_GAMES)[number];
type IconName = "home" | "download" | "library" | "search" | "back" | "pause" | "play" | "close" | "mods" | "check";

function Icon({ name, size = 19 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    home: <><path d="m3 10 9-7 9 7v10H15v-7H9v7H3z" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M3 15v6h18v-6" /></>,
    library: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 9v12" /></>,
    search: <><circle cx="10.5" cy="10.5" r="7.5" /><path d="m16 16 5 5" /></>,
    back: <path d="m12 5-7 7 7 7M5 12h15" />,
    pause: <><path d="M8 5v14M16 5v14" /></>,
    play: <path d="m8 4 12 8-12 8z" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    mods: <><path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5" /></>,
    check: <path d="m5 12 4 4L19 6" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Artwork({ game, className = "" }: { game: DemoGame; className?: string }) {
  return <div className={`demo-artwork ${className}`} style={{ background: `linear-gradient(135deg, ${game.palette.join(", ")})` }} aria-hidden="true"><span className="artwork-shape" /><span className="artwork-index">{game.name.split(" ").map(word => word[0]).join("")}</span></div>;
}

function ModsDialog({ game, applied, onApply, onClose }: { game: DemoGame; applied: string[]; onApply: (ids: string[]) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.show();
    element?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { element?.close(); previous?.focus(); };
  }, []);
  return (
    <div className="demo-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><dialog ref={dialog} className="demo-modal" aria-modal="true" onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "Tab") {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'));
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onClose(); } }} aria-labelledby="demo-mod-title" aria-describedby="demo-mod-description">
      <div className="demo-modal-heading"><h3 id="demo-mod-title">Mods for {game.name}</h3><button type="button" className="demo-icon-button" aria-label="Close mod selection" onClick={onClose}><Icon name="close" /></button></div>
      <p id="demo-mod-description">Select mods to apply.</p>
      <fieldset className="demo-mod-options"><legend>Select mods to apply</legend>{game.mods.map(mod => {
        const isApplied = applied.includes(mod.id);
        return <label key={mod.id}><input type="checkbox" checked={isApplied || selected.includes(mod.id)} disabled={isApplied} onChange={(event) => setSelected(ids => event.target.checked ? [...ids, mod.id] : ids.filter(id => id !== mod.id))} /><span>{mod.name}</span>{isApplied && <small>Applied</small>}</label>;
      })}</fieldset>
      <div className="demo-modal-footer"><button type="button" className="demo-button primary" disabled={selected.length === 0} onClick={() => onApply(selected)}>Apply mods <Icon name="download" size={16} /></button></div>
    </dialog></div>
  );
}

export function DesktopDemo() {
  const [state, dispatch] = useReducer(demoReducer, undefined, createDemoState);
  const [page, setPage] = useState<DemoPage>("home");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [modsId, setModsId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const focusNext = useRef(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const selected = DEMO_GAMES.find(game => game.id === selectedId);
  const modsGame = DEMO_GAMES.find(game => game.id === modsId);
  const active = state.jobs.filter(job => job.status === "downloading" || job.status === "paused");
  const progressing = state.jobs.some(job => job.status === "downloading");

  useEffect(() => {
    if (!progressing) return;
    const interval = setInterval(() => dispatch({ type: "tick" }), 700);
    return () => clearInterval(interval);
  }, [progressing]);

  useEffect(() => {
    if (!focusNext.current) return;
    heading.current?.focus({ preventScroll: true });
    focusNext.current = false;
  }, [page, selectedId]);

  function navigate(next: DemoPage) {
    focusNext.current = true;
    setSelectedId(null);
    setPage(next);

  }
  function details(game: DemoGame) {
    focusNext.current = true;
    setSelectedId(game.id);
  }
  function download(game: DemoGame) {
    dispatch({ type: "download", gameId: game.id });
    setNotice(`Demo download started for ${game.name}.`);
    navigate("downloads");
  }
  function applyMods(ids: string[]) {
    if (!modsGame) return;
    dispatch({ type: "apply-mods", gameId: modsGame.id, modIds: ids });
    setNotice(`Demo mod installation started for ${modsGame.name}.`);
    setModsId(null);
    navigate("downloads");
  }
  const busyGame = (id: string) => active.some(job => job.gameId === id);
  const title = selected ? selected.name : page === "home" ? "Games" : page === "downloads" ? "Downloads" : "Library";
  const visibleGames = DEMO_GAMES.filter(game => game.name.toLowerCase().includes(search.trim().toLowerCase()));
  const installedGames = visibleGames.filter(game => state.installed[game.id]);
  const completed = state.jobs.filter(job => job.status === "completed").length;

  return (
    <section className="demo-section" id="demo" aria-label="Interactive Playmart preview">
      <div className="desktop-demo">
        <div className="demo-titlebar"><span className="demo-window-dots" aria-hidden="true"><i /><i /><i /></span><span>Playmart</span></div>
        <div className="demo-shell" inert={Boolean(modsGame)}>
          <aside className="demo-sidebar"><span className="demo-brand">playmart<span>.</span></span><nav aria-label="Demo navigation">{(["home", "downloads", "library"] as const).map(item => <button type="button" key={item} onClick={() => navigate(item)} aria-current={!selected && page === item ? "page" : undefined} className={!selected && page === item ? "active" : ""}><Icon name={item === "downloads" ? "download" : item} /><span>{item[0].toUpperCase() + item.slice(1)}</span>{item === "downloads" && active.length > 0 && <small>{active.length}</small>}</button>)}</nav></aside>
          <div className="demo-main">
            <header className="demo-topbar">{!selected && page !== "downloads" ? <label className="demo-search"><Icon name="search" size={17} /><input type="search" aria-label="Search demo games" value={search} onChange={(event) => { setSearch(event.target.value); }} /></label> : <span />}<span className="demo-account"><span>P</span><span>Player</span></span></header>
            <div className="demo-page">
              {selected && <button type="button" className="demo-back" onClick={() => navigate(page)}><Icon name="back" size={16} /> Back</button>}
              <div className="demo-page-heading"><h2 ref={heading} tabIndex={-1}>{title}</h2></div>
              {selected ? (
                <div className="demo-details"><Artwork game={selected} className="detail-art" /><div className="demo-details-copy"><span className="demo-tag">Adventure</span><p>{selected.description}</p><div className="demo-metadata"><span><small>FILE SIZE</small>{selected.sizeLabel}</span><span><small>PLATFORM</small>Windows / macOS / Linux</span></div><div className="demo-detail-actions">{state.installed[selected.id] ? <><span className="demo-installed"><Icon name="check" size={16} /> Installed</span><button type="button" className="demo-button primary" disabled={busyGame(selected.id)} onClick={() => setModsId(selected.id)}><Icon name="mods" size={17} /> Apply mods</button></> : <button type="button" className="demo-button primary" onClick={() => busyGame(selected.id) ? navigate("downloads") : download(selected)}><Icon name="download" size={17} />{busyGame(selected.id) ? "View download" : "Download"}</button>}</div><div className="demo-mod-summary"><h3><Icon name="mods" size={17} /> Mods & extras</h3>{selected.mods.map(mod => <span key={mod.id}>{mod.name}{state.installed[selected.id]?.appliedModIds.includes(mod.id) && <small>Applied</small>}</span>)}</div></div></div>
              ) : page === "home" ? (
                <div className="demo-game-grid">{visibleGames.map(game => <button type="button" className="demo-game-card" key={game.id} onClick={() => details(game)} aria-label={`View ${game.name}`}><Artwork game={game} /><span className="demo-card-name">{game.name}</span></button>)}{!visibleGames.length && <p className="demo-empty">No games match your search.</p>}</div>
              ) : page === "library" ? (
                <><div className="demo-library-filter">Installed <span>{Object.keys(state.installed).length}</span></div><div className="demo-library-grid">{installedGames.map(game => <article className="demo-library-card" key={game.id}><button type="button" className="demo-library-art" onClick={() => { setPlayingId(playingId === game.id ? null : game.id); setNotice(playingId === game.id ? `${game.name} stopped.` : `${game.name} is running in the preview.`); }} aria-label={`${playingId === game.id ? "Stop" : "Play"} ${game.name}`}><Artwork game={game} /><span>{playingId === game.id ? "Stop" : "Play"} <Icon name={playingId === game.id ? "pause" : "play"} size={20} /></span></button><div className="demo-library-info"><h3>{game.name}</h3><span className="demo-installed"><Icon name="check" size={13} />Installed</span></div></article>)}{!installedGames.length && <p className="demo-empty">{search ? "No installed games match your search." : "Your installed games will appear here."}</p>}</div></>
              ) : (
                <><div className="demo-queue-title"><h3>Download queue</h3><span>{state.jobs.length}</span></div><div className="demo-download-list">{state.jobs.map(job => {
                  const game = DEMO_GAMES.find(game => game.id === job.gameId)!;
                  const isMod = job.kind === "mod";
                  const label = isMod ? "Applying mods" : "Downloading";
                  return <article className="demo-download-card" key={job.id}><Artwork game={game} /><div className="demo-job-info"><div className="demo-job-heading"><h3>{game.name}{isMod && <span> · Mods</span>}</h3><span className={`demo-job-status ${job.status}`}>{job.status === "downloading" ? label : job.status === "completed" ? (isMod ? "Mods applied" : "Installed") : job.status === "paused" ? "Paused" : "Cancelled"}</span></div><div className="demo-job-stats"><span>{isMod ? job.modIds.map(id => game.mods.find(mod => mod.id === id)?.name).join(", ") : game.sizeLabel}</span><span>{job.progress}%</span></div><div className="demo-progress" role="progressbar" aria-label={`${game.name}${isMod ? " mod" : " download"} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress}><span style={{ width: `${job.progress}%` }} /></div></div><div className="demo-job-actions">{job.status === "downloading" && <button type="button" className="demo-icon-button" aria-label={`Pause ${game.name}${isMod ? " mods" : ""}`} onClick={() => dispatch({ type: "pause", jobId: job.id })}><Icon name="pause" size={16} /></button>}{job.status === "paused" && <button type="button" className="demo-icon-button" aria-label={`Resume ${game.name}${isMod ? " mods" : ""}`} onClick={() => dispatch({ type: "resume", jobId: job.id })}><Icon name="play" size={16} /></button>}{["paused", "downloading"].includes(job.status) && <button type="button" className="demo-icon-button cancel" aria-label={`Cancel ${game.name}${isMod ? " mods" : ""}`} onClick={() => dispatch({ type: "cancel", jobId: job.id })}><Icon name="close" size={17} /></button>}{job.status === "completed" && <button type="button" className="demo-button secondary" onClick={() => navigate("library")}>View in Library</button>}</div></article>;
                })}</div></>
              )}
            </div>
          </div>
        </div>
        {modsGame && <ModsDialog key={modsGame.id} game={modsGame} applied={state.installed[modsGame.id]?.appliedModIds ?? []} onApply={applyMods} onClose={() => setModsId(null)} />}
      </div>
      <p className="sr-only" role="status" aria-live="polite">{notice} {completed > 0 ? `${completed} demo ${completed === 1 ? "job" : "jobs"} completed.` : ""}</p>

    </section>
  );
}
