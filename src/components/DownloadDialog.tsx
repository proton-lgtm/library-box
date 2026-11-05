import { useState } from "react";
import { X } from "lucide-react";
import type { Game } from "../shared/types";
import { bestDownloadLink } from "./format";

interface DownloadDialogProps {
  game: Game;
  destination: string;
  starting: boolean;
  onChooseDestination: () => Promise<void>;
  onStart: (options: { runAfter: boolean; selectedModIds: number[] }) => Promise<void>;
  onClose: () => void;
}

export function DownloadDialog({
  game,
  destination,
  starting,
  onChooseDestination,
  onStart,
  onClose,
}: DownloadDialogProps) {
  const [runAfter, setRunAfter] = useState(false);
  const [selectedModIds, setSelectedModIds] = useState<number[]>([]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="download-title">
        <button className="modal-close" onClick={onClose} aria-label="Close dialog"><X size={19} /></button>
        <h2 id="download-title">Download {game.name}</h2>
        <label className="field-label" htmlFor="destination-folder">Install folder</label>
        <div className="folder-picker">
          <span id="destination-folder" title={destination}>{destination || "No folder selected"}</span>
          <button className="button-secondary" onClick={() => void onChooseDestination()}>Browse</button>
        </div>
        {game.mods.length > 0 && (
          <fieldset className="mod-picker">
            <legend>Mods</legend>
            <div className="mod-options">
              {game.mods.map((mod, index) => {
                const modUrl = bestDownloadLink({ ...game, downloadLinks: mod.download_links });
                return (
                  <label className="mod-option" key={`${mod.name}-${index}`}>
                    <input
                      type="checkbox"
                      checked={selectedModIds.includes(index)}
                      disabled={!modUrl || starting}
                      onChange={(event) => {
                        setSelectedModIds((current) => event.target.checked
                          ? [...current, index]
                          : current.filter((id) => id !== index));
                      }}
                    />
                    <strong>{mod.name}</strong>
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}
        <label className="checkbox-row">
          <input type="checkbox" checked={runAfter} onChange={(event) => setRunAfter(event.target.checked)} />
          <span>Run after install</span>
        </label>
        <button
          className="button-primary modal-submit"
          disabled={!destination || starting}
          onClick={() => void onStart({ runAfter, selectedModIds })}
        >
          {starting ? "Starting…" : "Start download"}
        </button>
      </section>
    </div>
  );
}
