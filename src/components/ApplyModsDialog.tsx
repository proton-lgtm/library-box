import { useState } from "react";
import { X } from "lucide-react";
import type { DownloadQueueItem, InstalledGame } from "../shared/types";
import { bestDownloadLink } from "./format";
import { QueueProgress } from "./QueueProgress";

interface ApplyModsDialogProps {
  game: InstalledGame;
  applying: boolean;
  resetting?: boolean;
  resetProgress?: DownloadQueueItem;
  onRemoveAll?: () => Promise<void>;
  onApply: (modIds: number[]) => Promise<void>;
  onClose: () => void;
}

export function ApplyModsDialog({ game, applying, resetting = false, resetProgress, onRemoveAll, onApply, onClose }: ApplyModsDialogProps) {
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [error, setError] = useState("");
  const [resetStep, setResetStep] = useState<"select" | "confirm" | "working" | "success" | "error">("select");
  const blocked = applying || resetting || resetStep === "working";
  const availableIds = selectedIds.filter((id) => !game.appliedModIds.includes(id));

  const resetMods = async () => {
    if (!onRemoveAll || blocked) return;
    setError("");
    setResetStep("working");
    try {
      await onRemoveAll();
      setSelectedIds([]);
      setResetStep("success");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setResetStep("error");
    }
  };

  if (resetStep !== "select") {
    const extracting = resetting && resetProgress?.phase === "extracting";
    const title = resetStep === "confirm" ? "Remove all mods?"
      : resetStep === "success" ? "All mods removed"
        : resetStep === "error" ? "Unable to restore game"
          : extracting ? `Restoring ${game.name}` : "Preparing clean restore";
    return (
      <div className="modal-backdrop" role="presentation">
        <section className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="reset-mods-title" aria-busy={blocked}>
          <button className="modal-close" onClick={onClose} aria-label="Close dialog" disabled={blocked}><X size={19} /></button>
          <h2 id="reset-mods-title">{title}</h2>
          {resetStep === "confirm" && (
            <>
              <p>Restore {game.name} to its original archive contents.</p>
              <div className="reset-warning">
                <strong>Kept: the original game archive.</strong>
                <p>All other files in the installation folder are removed, including mods and any local saves. The original game is then re-extracted.</p>
              </div>
              <p>Close the game and back up local saves before continuing. The archive is checked before any files are removed.</p>
              <div className="dialog-actions">
                <button className="button-secondary" onClick={() => setResetStep("select")}>Keep mods</button>
                <button className="button-danger" onClick={() => void resetMods()}>Remove all mods</button>
              </div>
            </>
          )}
          {resetStep === "working" && (
            <div role="status" aria-live="polite">
              <p>{extracting ? resetProgress.phaseDetail || "Extracting the original game archive…" : "Checking the original archive before changing game files…"}</p>
              {extracting && resetProgress ? <QueueProgress download={resetProgress} label="Game restoration progress" /> : <div className="progress-track progress-indeterminate"><i style={{ width: "35%" }} /></div>}
              <p>Keep Playmart open until restoration finishes.</p>
            </div>
          )}
          {resetStep === "success" && (
            <>
              <p role="status">Original game files restored. The game archive was preserved and applied mod selections are cleared.</p>
              <button className="button-primary modal-submit" onClick={() => setResetStep("select")}>Back to mods</button>
            </>
          )}
          {resetStep === "error" && (
            <>
              <p className="dialog-error" role="alert">{error}</p>
              <p>Check the original archive and try again. No files are removed if archive verification fails.</p>
              <div className="dialog-actions">
                <button className="button-secondary" onClick={() => { setError(""); setResetStep("select"); }}>Back</button>
                <button className="button-primary" onClick={() => void resetMods()}>Try again</button>
              </div>
            </>
          )}
        </section>
      </div>
    );
  }

  const submit = async () => {
    setError("");
    try {
      await onApply(availableIds);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !blocked) onClose();
    }}>
      <section className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="apply-mods-title">
        <button className="modal-close" onClick={onClose} aria-label="Close dialog" disabled={blocked}>
          <X size={19} />
        </button>
        <h2 id="apply-mods-title">Mods for {game.name}</h2>
        <p>Applied mods are locked. Remove all mods to restore the original game from its saved archive.</p>
        {game.mods.length ? (
          <fieldset className="mod-picker apply-mod-picker">
            <legend>Select mods to apply</legend>
            <div className="mod-options">
              {game.mods.map((mod, index) => {
                const applied = game.appliedModIds.includes(index);
                const hasLink = Boolean(bestDownloadLink({
                  ...game,
                  downloadLinks: mod.download_links,
                }));
                return (
                  <label className="mod-option" key={`${mod.name}-${index}`}>
                    <input
                      type="checkbox"
                      checked={applied || selectedIds.includes(index)}
                      disabled={applied || blocked || !hasLink}
                      onChange={(event) => {
                        setSelectedIds((current) => event.target.checked
                          ? [...current, index]
                          : current.filter((id) => id !== index));
                      }}
                    />
                    <strong>{mod.name}</strong>
                    {applied && <span className="mod-applied-label">Applied</span>}
                    {!hasLink && !applied && <span className="mod-applied-label">Unavailable</span>}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ) : <div className="empty-state">No mods are available for this game</div>}
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          {onRemoveAll && (
            <button className="button-danger" disabled={blocked || game.running || game.appliedModIds.length === 0} onClick={() => { setError(""); setResetStep("confirm"); }}>
              Remove all mods
            </button>
          )}
          <button className="button-primary" disabled={blocked || availableIds.length === 0} onClick={() => void submit()}>
            {applying ? "Applying?" : "Apply mods"}
          </button>
        </div>
      </section>
    </div>
  );
}
