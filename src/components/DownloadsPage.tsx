import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Pause, Play, Trash2, X } from "lucide-react";
import type { DownloadQueueItem, GameDownloadQueueItem, ModDownloadQueueItem } from "../shared/types";
import { Cover } from "./Cover";
import { QueueProgress } from "./QueueProgress";
import { ReloadButton, type ReloadProps } from "./ReloadButton";
import { asGameCover, formatBytes } from "./format";

interface DownloadSample {
  bytes: number;
  at: number;
  phase: DownloadQueueItem["phase"];
}

interface DownloadsPageProps extends ReloadProps {
  downloads: DownloadQueueItem[];
  onPause: (gameId: number) => void;
  onResume: (gameId: number) => void;
  onManual?: (gameId: number) => void;
  onCancel: (gameId: number) => void;
  onCancelMod?: (id: string) => void;
  onRetryMod?: (id: string) => void;
  onGoToLibrary?: () => void;
  onDismiss?: (gameId: number) => void;
  onClearFinished?: () => void;
}

export function DownloadsPage({
  downloads,
  onPause,
  onResume,
  onManual,
  onCancel,
  onCancelMod,
  onRetryMod,
  onGoToLibrary,
  onDismiss,
  onClearFinished,
  onReload,
  reloading,
}: DownloadsPageProps) {
  const samples = useRef(new Map<string, DownloadSample>());
  const [remainingSeconds, setRemainingSeconds] = useState<Record<string, number>>({});
  const groups = useMemo(() => groupQueueItems(downloads), [downloads]);
  const [expandedGames, setExpandedGames] = useState<Set<number>>(new Set());
  const previousModActivity = useRef(new Map<number, boolean>());
  const finishedCount = groups.filter(({ game, mods }) => isDismissibleGroup(game, mods)).length;

  useEffect(() => {
    setExpandedGames((current) => {
      const next = new Set(current);
      const liveGameIds = new Set(groups.map(({ game }) => game.gameId));
      for (const gameId of next) {
        if (!liveGameIds.has(gameId)) next.delete(gameId);
      }
      for (const { game, mods } of groups) {
        const hasActiveMods = mods.some((mod) => !["completed", "cancelled"].includes(mod.status));
        const previous = previousModActivity.current.get(game.gameId);
        if (previous === undefined || previous !== hasActiveMods) {
          if (hasActiveMods) next.add(game.gameId);
          else next.delete(game.gameId);
        }
        previousModActivity.current.set(game.gameId, hasActiveMods);
      }
      return next;
    });
  }, [groups]);

  useEffect(() => {
    const now = Date.now();
    const estimates: Record<string, number> = {};
    const keepPreviousEstimates = new Set<string>();
    const activeIds = new Set<string>();
    for (const download of downloads) {
      if (download.status !== "downloading") {
        samples.current.delete(download.id);
        continue;
      }

      activeIds.add(download.id);
      const previous = samples.current.get(download.id);
      const totalBytes = download.totalBytes ??
        (download.kind === "game" ? download.expectedBytes : null);
      const remainingBytes = (totalBytes ?? 0) - download.bytesDownloaded;
      if (previous && previous.phase === download.phase) {
        keepPreviousEstimates.add(download.id);
        const elapsed = now - previous.at;
        if (elapsed >= 1000 && previous.bytes < download.bytesDownloaded && remainingBytes > 0) {
          const seconds = (remainingBytes * elapsed) /
            ((download.bytesDownloaded - previous.bytes) * 1000);
          if (Number.isFinite(seconds)) estimates[download.id] = Math.ceil(seconds);
        }
        if (elapsed >= 1000) {
          samples.current.set(download.id, {
            bytes: download.bytesDownloaded,
            at: now,
            phase: download.phase,
          });
        }
      } else {
        samples.current.set(download.id, {
          bytes: download.bytesDownloaded,
          at: now,
          phase: download.phase,
        });
      }
    }
    for (const id of samples.current.keys()) {
      if (!activeIds.has(id)) samples.current.delete(id);
    }
    setRemainingSeconds((previous) => {
      for (const id of keepPreviousEstimates) {
        if (estimates[id] === undefined && previous[id] !== undefined) {
          estimates[id] = previous[id];
        }
      }
      return estimates;
    });
  }, [downloads]);

  return (
    <section className="list-page downloads-page">
      <div className="page-heading-row">
        <h1 className="page-heading">Downloads</h1>
        <ReloadButton onReload={onReload} reloading={reloading} />
      </div>

      <section className="download-section">
        <div className="section-heading">
          <h2>Download Queue</h2>
          <span>{groups.length}</span>
          {finishedCount > 0 && (
            <button className="queue-clear-button" onClick={onClearFinished}>Clear all</button>
          )}
        </div>
        {groups.length ? (
          <div className="download-list">
            {groups.map(({ game, mods }) => {
              const totalBytes = game.totalBytes ?? game.expectedBytes;
              const isProcessing = game.status === "applying" ||
                game.phase === "extracting" || game.phase === "finalizing";
              const eta = remainingSeconds[game.id];
              const expanded = expandedGames.has(game.gameId);
              const dismissible = isDismissibleGroup(game, mods);
              return (
                <article className="download-card download-card-game" key={game.id}>
                  <div className="download-card-main">
                    <Cover game={asGameCover(game)} className="download-cover" />
                    <div className="download-info">
                      <div className="download-info-heading">
                        <h3>{game.gameName}</h3>
                        <span className={`status-tag status-${game.status}`}>{queueStatusLabel(game)}</span>
                      </div>
                      <span className="download-measure">
                        {queueDetail(game, totalBytes, false)}
                        {!game.error && game.status === "downloading" && !isProcessing && (
                          <span className="download-eta">
                            {eta
                              ? `${formatRemainingTime(eta)} remaining`
                              : totalBytes ? "Estimating time remaining…" : "Time remaining unavailable"}
                          </span>
                        )}
                      </span>
                      <QueueProgress download={game} label={`${game.gameName} progress`} />
                    </div>
                    <div className="download-actions">
                      {mods.length > 0 && (
                        <button
                          className="icon-button mod-accordion-toggle"
                          onClick={() => setExpandedGames((current) => {
                            const next = new Set(current);
                            if (next.has(game.gameId)) next.delete(game.gameId);
                            else next.add(game.gameId);
                            return next;
                          })}
                          aria-label={`${expanded ? "Collapse" : "Expand"} mods for ${game.gameName}`}
                          aria-expanded={expanded}
                          aria-controls={`mods-${game.gameId}`}
                        >
                          <ChevronDown size={17} />
                        </button>
                      )}
                      {game.status === "downloading" && !isProcessing ? (
                        <button className="icon-button" onClick={() => onPause(game.gameId)} aria-label="Pause"><Pause size={17} /></button>
                      ) : game.status === "failed" && onManual ? (
                        <button className="action-button" onClick={() => onManual(game.gameId)}>Try Manually</button>
                      ) : game.status === "paused" ? (
                        <button className="action-button" onClick={() => onResume(game.gameId)} aria-label={`Resume ${game.gameName}`}><Play size={16} /></button>
                      ) : game.status === "completed" ? (
                        <button className="action-button" onClick={onGoToLibrary}>Go to Library</button>
                      ) : null}
                      {["downloading", "paused", "failed"].includes(game.status) && !isProcessing && (
                        <button className="icon-button cancel-button" onClick={() => onCancel(game.gameId)} aria-label={`Cancel ${game.gameName}`}><X size={18} /></button>
                      )}
                      {dismissible && (
                        <button className="icon-button queue-delete-button" onClick={() => onDismiss?.(game.gameId)} aria-label={`Remove ${game.gameName} from downloads`}><Trash2 size={17} /></button>
                      )}
                    </div>
                  </div>
                  {mods.length > 0 && expanded && (
                    <div className="mod-queue-list" id={`mods-${game.gameId}`}>
                      {mods.map((mod) => {
                        const modTotal = mod.totalBytes;
                        const waitingForGame = mod.status === "waiting" && game.status !== "completed";
                        const modEta = remainingSeconds[mod.id];
                        return (
                          <div className="mod-queue-row" key={mod.id}>
                            <div className="download-info">
                              <div className="download-info-heading">
                                <h3>{mod.modName}</h3>
                                <span className={`status-tag status-${mod.status}`}>{queueStatusLabel(mod)}</span>
                              </div>
                              <span className="download-measure">
                                {queueDetail(mod, modTotal, waitingForGame)}
                                {!mod.error && mod.status === "downloading" && (
                                  <span className="download-eta">
                                    {modEta ? `${formatRemainingTime(modEta)} remaining` : modTotal ? "Estimating time remaining…" : "Time remaining unavailable"}
                                  </span>
                                )}
                              </span>
                              <QueueProgress download={mod} label={`${mod.modName} progress`} />
                            </div>
                            <div className="download-actions">
                              {mod.status === "failed" && (
                                <button className="action-button" onClick={() => onRetryMod?.(mod.id)}>Try Manually</button>
                              )}
                              {["waiting", "downloading", "failed"].includes(mod.status) && (
                                <button className="icon-button cancel-button" onClick={() => onCancelMod?.(mod.id)} aria-label={`Cancel ${mod.modName}`}><X size={18} /></button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : <div className="empty-state">No downloads in this session</div>}
      </section>
    </section>
  );
}

function isDismissibleGroup(game: GameDownloadQueueItem, mods: ModDownloadQueueItem[]): boolean {
  return ["completed", "cancelled"].includes(game.status) &&
    mods.every((mod) => ["completed", "failed", "cancelled"].includes(mod.status));
}

function groupQueueItems(downloads: DownloadQueueItem[]): Array<{
  game: GameDownloadQueueItem;
  mods: ModDownloadQueueItem[];
}> {
  const groups = new Map<number, { game?: GameDownloadQueueItem; mods: ModDownloadQueueItem[] }>();
  for (const item of downloads) {
    const group = groups.get(item.gameId) ?? { mods: [] };
    if (item.kind === "game") group.game = item;
    else group.mods.push(item);
    groups.set(item.gameId, group);
  }
  return Array.from(groups.values(), (group) => {
    const firstMod = group.mods[0];
    const game = group.game ?? {
      id: `game:${firstMod.gameId}`,
      kind: "game" as const,
      gameId: firstMod.gameId,
      gameName: firstMod.gameName,
      thumbnail: firstMod.thumbnail,
      status: "completed" as const,
      bytesDownloaded: 0,
      totalBytes: null,
      expectedBytes: null,
      error: null,
      phase: null,
      detail: null,
      phaseDetail: null,
      installDir: firstMod.installDir,
    };
    return {
      game,
      mods: group.mods.sort((left, right) => left.modId - right.modId),
    };
  }).sort((left, right) => left.game.gameId - right.game.gameId);
}

function queueStatusLabel(download: DownloadQueueItem): string {
  if (download.status === "completed") return download.kind === "mod" ? "Applied" : "Downloaded";
  if (download.phase === "extracting" && ["applying", "downloading"].includes(download.status)) return "Extracting";
  if (download.status === "applying") return "Applying";
  if (download.phase === "finalizing" && download.status === "downloading") return "Finishing up";
  return download.status[0].toUpperCase() + download.status.slice(1);
}

function queueDetail(
  download: DownloadQueueItem,
  totalBytes: number | null,
  waitingForGame: boolean,
): string {
  if (download.error) return download.error;
  if (waitingForGame) return "Waiting for the game download and extraction to finish…";
  if (download.status === "waiting") return "Waiting to start…";
  if (download.status === "completed") {
    return download.kind === "mod" ? "Mod applied successfully" : "Download and installation complete";
  }
  if (download.status === "cancelled") return "Cancelled";
  if (download.phase === "extracting") return "Extracting game archive…";
  if (download.status === "applying" || download.phase === "applying-mods") return "Applying mod…";
  if (download.phase === "finalizing") return "Verifying the installed game…";
  return totalBytes
    ? `${formatBytes(download.bytesDownloaded)} / ${formatBytes(totalBytes)}`
    : `${formatBytes(download.bytesDownloaded)} downloaded`;
}

function formatRemainingTime(seconds: number): string {
  if (seconds < 60) return "Less than a minute";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `About ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `About ${hours} hr ${remainingMinutes} min` : `About ${hours} hr`;
}
