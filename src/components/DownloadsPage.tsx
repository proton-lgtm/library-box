import { Check, Clock3, Download, Pause, Play, X } from "lucide-react";
import type { Download as DownloadRecord } from "../shared/types";
import { Cover } from "./Cover";
import { asGameCover, formatBytes } from "./format";

interface DownloadsPageProps {
  downloads: DownloadRecord[];
  onPause: (gameId: number) => void;
  onResume: (gameId: number) => void;
  onCancel: (gameId: number) => void;
}

export function DownloadsPage({ downloads, onPause, onResume, onCancel }: DownloadsPageProps) {
  const active = downloads.filter((item) => item.status === "downloading" || item.status === "paused" || item.status === "failed");
  const cancelled = downloads.filter((item) => item.status === "cancelled");
  const failedCount = downloads.filter((item) => item.status === "failed").length;
  const pausedCount = downloads.filter((item) => item.status === "paused").length;
  const activeCount = downloads.filter((item) => item.status === "downloading").length;

  return (
    <section className="list-page downloads-page">
      <h1 className="page-heading">Downloads</h1>
      <div className="download-summary-grid">
        <div className="summary-tile"><span className="summary-icon"><Download size={21} /></span><span><strong>{activeCount}</strong><small>Active downloads</small></span></div>
        <div className="summary-tile"><span className="summary-icon summary-icon-green"><Check size={21} /></span><span><strong>{pausedCount}</strong><small>Paused</small></span></div>
        <div className="summary-tile"><span className="summary-icon summary-icon-violet"><Clock3 size={21} /></span><span><strong>{failedCount}</strong><small>Failed</small></span></div>
      </div>

      <section className="download-section">
        <div className="section-heading"><h2>Active Downloads</h2><span>{active.length}</span></div>
        {active.length ? (
          <div className="download-list">
            {active.map((download) => {
              const progress = download.totalBytes
                ? Math.min(100, download.bytesDownloaded / download.totalBytes * 100)
                : download.status === "downloading" ? 40 : 0;
              return (
                <article className="download-card" key={download.gameId}>
                  <Cover game={asGameCover(download)} className="download-cover" />
                  <div className="download-info">
                    <div className="download-info-heading">
                      <h3>{download.gameName}</h3>
                      <span className={`status-tag status-${download.status}`}>{download.status}</span>
                    </div>
                    <span className="download-measure">{download.error || `${formatBytes(download.bytesDownloaded)}${download.totalBytes ? ` / ${formatBytes(download.totalBytes)}` : ""}`}</span>
                    <div className="progress-track" role="progressbar" aria-label={`${download.gameName} download progress`} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
                      <i style={{ width: `${progress}%` }} />
                    </div>
                  </div>
                  <div className="download-actions">
                    {download.status === "downloading" ? (
                      <button className="icon-button" onClick={() => onPause(download.gameId)} aria-label="Pause"><Pause size={17} /></button>
                    ) : (
                      <button className="action-button" onClick={() => onResume(download.gameId)}><Play size={16} /> Resume</button>
                    )}
                    <button className="icon-button cancel-button" onClick={() => onCancel(download.gameId)} aria-label={`Cancel ${download.gameName}`}><X size={18} /></button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : <div className="empty-state">No active downloads</div>}
      </section>

      {cancelled.length > 0 && (
        <section className="download-section cancelled-section">
          <div className="section-heading"><h2>Cancelled</h2><span>{cancelled.length}</span></div>
          <div className="download-list">
            {cancelled.map((download) => (
              <article className="download-card cancelled-card" key={download.gameId}>
                <Cover game={asGameCover(download)} className="download-cover" />
                <div className="download-info">
                  <div className="download-info-heading"><h3>{download.gameName}</h3><span className="status-tag status-cancelled">Cancelled</span></div>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
