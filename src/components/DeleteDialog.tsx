import type { InstalledGame } from "../shared/types";

interface DeleteDialogProps {
  game: InstalledGame;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteDialog({ game, onCancel, onConfirm }: DeleteDialogProps) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <section className="dialog-card delete-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title">
        <h2 id="delete-title">Delete {game.name}?</h2>
        <p>The installed game files will be removed.</p>
        <div className="delete-actions">
          <button className="button-secondary" onClick={onCancel}>Cancel</button>
          <button className="button-danger" onClick={onConfirm}>Delete</button>
        </div>
      </section>
    </div>
  );
}
