import type { DownloadQueueItem } from "../shared/types";

export function QueueProgress({ download, label }: { download: DownloadQueueItem; label: string }) {
  const processing = download.status === "applying" || download.phase === "extracting" ||
    download.phase === "finalizing" || download.phase === "applying-mods";
  const total = download.totalBytes ?? (download.kind === "game" ? download.expectedBytes : null);
  const extraction = download.extractionProgress;
  const progress = download.status === "completed" ? 100
    : processing ? (typeof extraction === "number" && Number.isFinite(extraction)
      ? Math.max(0, Math.min(100, extraction)) : undefined)
      : total ? Math.max(0, Math.min(100, download.bytesDownloaded / total * 100))
        : download.status === "downloading" ? undefined : 0;
  return (
    <div className="queue-progress">
      {processing && progress !== undefined && (
        <span className="extraction-percentage">{Math.round(progress)}%</span>
      )}
      <div
        className={`progress-track${processing ? " progress-processing" : ""}${progress === undefined ? " progress-indeterminate" : ""}`}
        role="progressbar"
        aria-label={label}
        aria-valuenow={progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={progress === undefined ? "Progress unavailable" : undefined}
      >
        <i style={{ width: progress === undefined ? "35%" : `${progress}%` }} />
      </div>
    </div>
  );
}
