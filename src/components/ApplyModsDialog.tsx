import { useState } from "react";
import { X } from "lucide-react";
import type { InstalledGame } from "../shared/types";
import { bestDownloadLink } from "./format";

interface ApplyModsDialogProps {
  game: InstalledGame;
  applying: boolean;
  onApply: (modIds: number[]) => Promise<void>;
  onClose: () => void;
}

export function ApplyModsDialog({ game, applying, onApply, onClose }: ApplyModsDialogProps) {
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [error, setError] = useState("");
  const availableIds = selectedIds.filter((id) => !game.appliedModIds.includes(id));

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
      if (event.target === event.currentTarget && !applying) onClose();
    }}>
      <section className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="apply-mods-title">
        <button className="modal-close" onClick={onClose} aria-label="Close dialog" disabled={applying}>
          <X size={19} />
        </button>
        <h2 id="apply-mods-title">Mods for {game.name}</h2>
        <p>Applied mods are locked. To reset them, delete and reinstall the game.</p>
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
                      disabled={applied || applying || !hasLink}
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
        {availableIds.length > 0 && (
          <button
            className="button-primary modal-submit"
            disabled={applying}
            onClick={() => void submit()}
          >
            {applying ? "Applying…" : "Apply mods"}
          </button>
        )}
      </section>
    </div>
  );
}
