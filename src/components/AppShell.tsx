import type { ReactNode } from "react";
import {
  Download,
  House,
  Minus,
  PanelsTopLeft,
  Search,
  Square,
  UserRound,
  X,
  Copy,
  ChevronDown,
} from "lucide-react";
import type { AuthState } from "../shared/types";

export type Page = "home" | "downloads" | "library";

interface AppShellProps {
  page: Page;
  search: string;
  showSearch: boolean;
  authState: AuthState;
  maximized: boolean;
  children: ReactNode;
  onNavigate: (page: Page) => void;
  onSearch: (value: string) => void;
  onOpenProfile: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}

const navigation: Array<{ page: Page; label: string; icon: typeof House }> = [
  { page: "home", label: "Home", icon: House },
  { page: "downloads", label: "Downloads", icon: Download },
  { page: "library", label: "Library", icon: PanelsTopLeft },
];

export function AppShell({
  page,
  search,
  showSearch,
  authState,
  maximized,
  children,
  onNavigate,
  onSearch,
  onOpenProfile,
  onMinimize,
  onToggleMaximize,
  onClose,
}: AppShellProps) {
  return (
    <div className="app-shell">
      <header className="window-titlebar">
        <div className="window-drag-region" />
        <div className="window-controls">
          <button onClick={onMinimize} aria-label="Minimize"><Minus size={16} /></button>
          <button onClick={onToggleMaximize} aria-label={maximized ? "Restore" : "Maximize"}>
            {maximized ? <Copy size={13} /> : <Square size={13} />}
          </button>
          <button className="window-close" onClick={onClose} aria-label="Close"><X size={17} /></button>
        </div>
      </header>

      <aside className="sidebar">
        <nav className="primary-nav" aria-label="Main navigation">
          {navigation.map(({ page: target, label, icon: Icon }) => (
            <button
              key={target}
              className={page === target ? "nav-item active" : "nav-item"}
              onClick={() => onNavigate(target)}
              aria-current={page === target ? "page" : undefined}
            >
              <Icon size={20} strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="main-area">
        <header className="topbar">
          {showSearch ? (
            <label className="search-box">
              <Search size={19} />
              <input
                aria-label="Search games"
                value={search}
                onChange={(event) => onSearch(event.target.value)}
                placeholder="Search games..."
              />
            </label>
          ) : <div className="topbar-spacer" />}
          <button className="profile-pill" onClick={onOpenProfile} aria-label="Profile">
            <span className="profile-icon"><UserRound size={19} /></span>
            <span>
              <strong>{authState.status === "account" ? authState.email : authState.status === "anonymous" ? "Anonymous" : "Profile"}</strong>
              <small>{authState.status === "account" ? "Signed in" : authState.status === "anonymous" ? "Guest account" : "Account"}</small>
            </span>
            <ChevronDown size={16} />
          </button>
        </header>
        {children}
      </main>
    </div>
  );
}
