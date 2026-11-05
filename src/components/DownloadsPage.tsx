import { useEffect, useRef, useState } from "react";
import { Pause, Play, X } from "lucide-react";
import type { Download as DownloadRecord } from "../shared/types";
import { Cover } from "./Cover";
import { asGameCover, formatBytes } from "./format";

interface DownloadSample {
  bytes: number;
  at: number;
  phase: DownloadRecord["phase"];
}

interface DownloadsPageProps {
  downloads: DownloadRecord[];
  onPause: (gameId: number) => void;
  onResume: (gameId: number) => void;
  onCancel: (gameId: number) => void;
}

export function DownloadsPage({ downloads, onPause, onResume, onCancel }: DownloadsPageProps) {
  const active = downloads.filter((item) => item.status === "downloading" || item.status === "paused" || item.status === "failed");
  const samples = useRef(new Map<number, DownloadSample>());
  const [remainingSeconds, setRemainingSeconds] = useState<Record<number, number>>({});

  useEffect(() => {
    const now = Date.now();
    const estimates: Record<number, number> = {};
    const keepPreviousEstimates = new Set<number>();
    const activeIds = new Set<number>();
    for (const download of downloads) {
      const isTransferring = download.status === "downloading" &&
        (!download.phase || download.phase === "downloading-mod");
      if (!isTransferring) {
        samples.current.delete(download.gameId);
        continue;
      }

      activeIds.add(download.gameId);
      const previous = samples.current.get(download.gameId);
      const totalBytes = download.totalBytes ??
        (download.phase === "downloading-mod" ? null : download.expectedBytes ?? null);
      const remainingBytes = (totalBytes ?? 0) - download.bytesDownloaded;
      if (previous && previous.phase === download.phase) {
        keepPreviousEstimates.add(download.gameId);
        const elapsed = now - previous.at;
        if (elapsed >= 1000 && previous.bytes < download.bytesDownloaded && remainingBytes > 0) {
          const seconds = (remainingBytes * elapsed) /
            ((download.bytesDownloaded - previous.bytes) * 1000);
          if (Number.isFinite(seconds)) estimates[download.gameId] = Math.ceil(seconds);
        }
        if (elapsed >= 1000) {
          samples.current.set(download.gameId, {
            bytes: download.bytesDownloaded,
            at: now,
            phase: download.phase,
          });
        }
      } else {
        samples.current.set(download.gameId, {
          bytes: download.bytesDownloaded,
          at: now,
          phase: download.phase,
        });
      }
    }
    for (const gameId of samples.current.keys()) {
      if (!activeIds.has(gameId)) samples.current.delete(gameId);
    }
    setRemainingSeconds((previous) => {
      for (const gameId of keepPreviousEstimates) {
        if (estimates[gameId] === undefined && previous[gameId] !== undefined) {
          estimates[gameId] = previous[gameId];
        }
      }
      return estimates;
    });
  }, [downloads]);

  return (
    <section className="list-page downloads-page">
      <h1 className="page-heading">Downloads</h1>

      <section className="download-section">
        <div className="section-heading"><h2>Active Downloads</h2><span>{active.length}</span></div>
        {active.length ? (
          <div className="download-list">
            {active.map((download) => {
              const totalBytes = download.totalBytes ??
                (download.phase === "downloading-mod" ? null : download.expectedBytes ?? null);
              const progress = totalBytes
                ? Math.min(100, download.bytesDownloaded / totalBytes * 100)
                : download.status === "downloading" ? 40 : 0;
              const isProcessing = Boolean(download.phase && download.phase !== "downloading-mod");
              const statusLabel = download.status === "failed" || download.status === "paused"
                ? download.status
                : download.phase === "extracting"
                  ? "Extracting"
                  : download.phase === "downloading-mod"
                    ? "Downloading mod"
                    : download.phase === "applying-mods"
                      ? "Applying mods"
                      : download.phase === "finalizing"
                        ? "Finishing up"
                        : "Downloading";
              const detail = download.error ||
                (download.phase === "extracting"
                  ? "Extracting game archive…"
                  : download.phase === "downloading-mod"
                    ? `Downloading ${download.phaseDetail || "mod"}…`
                    : download.phase === "applying-mods"
                      ? `Applying ${download.phaseDetail || "selected mods"}…`
                      : download.phase === "finalizing"
                        ? "Verifying the installed game…"
                        : totalBytes
                          ? `${formatBytes(download.bytesDownloaded)} / ${formatBytes(totalBytes)}`
                          : `${formatBytes(download.bytesDownloaded)} downloaded`);
              const eta = remainingSeconds[download.gameId];
              return (
                <article className="download-card" key={download.gameId}>
                  <Cover game={asGameCover(download)} className="download-cover" />
                  <div className="download-info">
                    <div className="download-info-heading">
                      <h3>{download.gameName}</h3>
                      <span className={`status-tag status-${download.status}`}>{statusLabel}</span>
                    </div>
                    <span className="download-measure">
                      {detail}
                      {!download.error && !isProcessing && download.status === "downloading" && (
                        <span className="download-eta">
                          {eta
                            ? `${formatRemainingTime(eta)} remaining`
                            : totalBytes ? "Estimating time remaining…" : "Time remaining unavailable"}
                        </span>
                      )}
                    </span>
                    <div className={`progress-track${isProcessing ? " progress-processing" : ""}`} role="progressbar" aria-label={`${download.gameName} download progress`} aria-valuenow={isProcessing ? 100 : progress} aria-valuemin={0} aria-valuemax={100}>
                      <i style={{ width: `${isProcessing ? 100 : progress}%` }} />
                    </div>
                  </div>
                  <div className="download-actions">
                    {download.status === "downloading" && !isProcessing ? (
                      <button className="icon-button" onClick={() => onPause(download.gameId)} aria-label="Pause"><Pause size={17} /></button>
                    ) : download.status !== "downloading" ? (
                      <button className="action-button" onClick={() => onResume(download.gameId)}><Play size={16} /> Resume</button>
                    ) : null}
                    <button className="icon-button cancel-button" onClick={() => onCancel(download.gameId)} aria-label={`Cancel ${download.gameName}`}><X size={18} /></button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : <div className="empty-state">No active downloads</div>}
      </section>
    </section>
  );
}

function formatRemainingTime(seconds: number): string {
  if (seconds < 60) return "Less than a minute";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `About ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `About ${hours} hr ${remainingMinutes} min` : `About ${hours} hr`;
}
