import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Globe2, X } from "lucide-react";
import type { Game } from "../shared/types";
import { bestDownloadLink, bestDownloadProvider, displayLabel, downloadProviders } from "./format";

const DOWNLOAD_PROVIDER_KEY = "game-library.preferred-download-provider";

interface DownloadDialogProps {
  game: Game;
  destination: string;
  starting: boolean;
  onChooseDestination: () => Promise<void>;
  onStart: (options: { url: string; runAfter: boolean; selectedModIds: number[] }) => Promise<void>;
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
  const providers = downloadProviders(game);
  const [provider, setProvider] = useState(() => {
    const preferred = localStorage.getItem(DOWNLOAD_PROVIDER_KEY);
    return preferred && game.downloadLinks[preferred]
      ? preferred
      : bestDownloadProvider(game)?.[0] ?? "";
  });
  const selectedUrl = game.downloadLinks[provider];
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const providerMenu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!providerMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (!providerMenu.current?.contains(event.target as Node)) setProviderMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProviderMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [providerMenuOpen]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="download-title">
        <button className="modal-close" onClick={onClose} aria-label="Close dialog"><X size={19} /></button>
        <h2 id="download-title">Download {game.name}</h2>
        {providers.length > 1 && (
          <div className="dialog-select-field" ref={providerMenu}>
            <span id="download-provider-label">Download source</span>
            <button
              type="button"
              className="provider-select-trigger"
              aria-labelledby="download-provider-label download-provider-value"
              aria-haspopup="listbox"
              aria-expanded={providerMenuOpen}
              disabled={starting}
              onClick={() => setProviderMenuOpen((open) => !open)}
            >
              <ProviderFavicon url={selectedUrl} />
              <span id="download-provider-value">{displayLabel(provider)}</span>
              <ChevronDown size={16} aria-hidden="true" />
            </button>
            {providerMenuOpen && (
              <div className="provider-select-menu" role="listbox" aria-labelledby="download-provider-label">
                {providers.map(([key, url]) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={provider === key}
                    className={provider === key ? "selected" : ""}
                    key={key}
                    onClick={() => {
                      setProvider(key);
                      localStorage.setItem(DOWNLOAD_PROVIDER_KEY, key);
                      setProviderMenuOpen(false);
                    }}
                  >
                    <ProviderFavicon url={url} />
                    <span>{displayLabel(key)}</span>
                    {provider === key && <Check size={16} aria-hidden="true" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
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
          disabled={!destination || !selectedUrl || starting}
          onClick={() => void onStart({ url: selectedUrl, runAfter, selectedModIds })}
        >
          {starting ? "Starting…" : "Start download"}
        </button>
      </section>
    </div>
  );
}

function ProviderFavicon({ url }: { url: string }) {
  const providerOrigin = new URL(url).origin;
  const faviconUrl = `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(providerOrigin)}&sz=32`;
  return (
    <span className="provider-favicon" aria-hidden="true">
      <Globe2 size={16} />
      <img
        src={faviconUrl}
        alt=""
        onError={(event) => { event.currentTarget.hidden = true; }}
      />
    </span>
  );
}
