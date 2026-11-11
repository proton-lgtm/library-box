import { ArrowDownToLine, ArrowLeft, CalendarDays, ExternalLink, Globe2, Layers3, Play, Puzzle, RefreshCw, ShieldCheck } from "lucide-react";
import type { Game } from "../shared/types";
import { Cover } from "./Cover";
import { ReloadButton, type ReloadProps } from "./ReloadButton";
import { bestDownloadLink, displayLabel, formatBytes, formatDate } from "./format";

interface GameDetailsPageProps extends ReloadProps {
  game: Game;
  installed: boolean;
  downloading: boolean;
  onBack: () => void;
  onDownload: () => void;
  onViewDownloads: () => void;
  onLaunch: () => void;
  onApplyMods: () => void;
  onOpenExternal: (url: string) => void;
}

export function GameDetailsPage({
  game,
  installed,
  downloading,
  onBack,
  onDownload,
  onViewDownloads,
  onLaunch,
  onApplyMods,
  onOpenExternal,
  onReload,
  reloading,
}: GameDetailsPageProps) {
  const mainDownload = bestDownloadLink(game);

  return (
    <section className="detail-page">
      <div className="detail-navigation-row">
        <button className="back-link" onClick={onBack}><ArrowLeft size={18} /> Back</button>
        <ReloadButton onReload={onReload} reloading={reloading} />
      </div>
      <div className="detail-layout">
        <div className="detail-art"><Cover game={game} /></div>
        <div className="detail-info">
          <h1>{game.name}</h1>
          {game.description && <p className="detail-description">{game.description}</p>}
          <div className="game-meta">
            {game.version && <span><Layers3 size={16} /> Version {game.version}</span>}
            {game.operatingSystems?.map((operatingSystem) => <span key={operatingSystem}><Globe2 size={16} /> {operatingSystem}</span>)}
            {game.releaseDate && <span><CalendarDays size={16} /> Release date: {formatDate(game.releaseDate)}</span>}
            {game.lastUpdated && <span><RefreshCw size={16} /> Last updated: {formatDate(game.lastUpdated)}</span>}
            {game.sizeBytes != null && <span><Layers3 size={16} /> {formatBytes(game.sizeBytes)}</span>}
          </div>
          {game.tags && game.tags.length > 0 && (
            <div className="game-tags">{game.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
          )}

          <div className="detail-panels">
            <section className="detail-panel download-panel">
              <h2><ArrowDownToLine size={21} /> Download</h2>
              <div className="download-panel-body">
                <div className="provider-detail">
                  <span className="panel-icon"><Layers3 size={25} /></span>
                  <span><small>Host</small><strong>{mainDownload ? displayLabel(Object.keys(game.downloadLinks).find((key) => game.downloadLinks[key] === mainDownload) ?? "Download") : "Unavailable"}</strong></span>
                </div>
                <div className="provider-detail">
                  <span className="panel-icon"><Layers3 size={25} /></span>
                  <span><small>File size</small><strong>{game.sizeBytes == null ? "—" : formatBytes(game.sizeBytes)}</strong></span>
                </div>
                <button
                  className="button-primary"
                  disabled={!installed && !downloading && !mainDownload}
                  onClick={installed ? onLaunch : downloading ? onViewDownloads : onDownload}
                >
                  {installed ? <Play size={18} /> : <ArrowDownToLine size={18} />}
                  {installed ? "Play" : downloading ? "Downloading" : "Download"}
                </button>
              </div>
              <p className="safe-note"><ShieldCheck size={16} /> Secure &amp; safe download · External link</p>
            </section>

            {game.mods.length > 0 && (
              <section className="detail-panel mods-panel">
                <h2><Puzzle size={21} /> Mods &amp; extras</h2>
                <div className="mods-list">
                  {game.mods.map((mod, index) => {
                    return (
                      <article className="mod-card" key={`${mod.name}-${index}`}>
                        <span className="mod-icon"><Puzzle size={27} /></span>
                        <span className="mod-description"><strong>{mod.name}</strong><small>Optional content for {game.name}.</small></span>
                      </article>
                    );
                  })}
                </div>
                {installed && (
                  <button className="button-outline apply-mods-button" onClick={onApplyMods}>
                    <Puzzle size={16} /> Apply mods
                  </button>
                )}
              </section>
            )}

            {game.developerLinks && Object.keys(game.developerLinks).length > 0 && (
              <section className="detail-panel developer-panel">
                <h2><ExternalLink size={20} /> Developer links</h2>
                <div className="developer-links">
                  {Object.entries(game.developerLinks).map(([label, url]) => (
                    <button key={label} onClick={() => onOpenExternal(url)}>
                      <Globe2 size={16} /> {displayLabel(label)} <ExternalLink size={14} />
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
          {game.detailsLastUpdated && <span className="details-updated">Details updated {formatDate(game.detailsLastUpdated)}</span>}
        </div>
      </div>
    </section>
  );
}
