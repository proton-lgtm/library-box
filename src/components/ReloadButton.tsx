import { RefreshCw } from "lucide-react";

export interface ReloadProps {
  onReload?: () => void;
  reloading?: boolean;
}

export function ReloadButton({ onReload, reloading = false }: ReloadProps) {
  if (!onReload) return null;
  return (
    <button
      className="icon-button reload-button"
      onClick={onReload}
      disabled={reloading}
      aria-label="Reload page"
      title="Reload page"
      aria-busy={reloading}
    >
      <RefreshCw size={18} className={reloading ? "spinning" : ""} />
    </button>
  );
}
