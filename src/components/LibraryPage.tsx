import { MoreVertical, Play, ShieldCheck, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import type { InstalledGame } from "../shared/types";
import { Cover } from "./Cover";

type LibraryTab = "installed" | "favorites";

interface LibraryPageProps {
  installed: InstalledGame[];
  search: string;
  onLaunch: (gameId: number) => void;
  onStop: (gameId: number) => void;
  onDelete: (game: InstalledGame) => void;
}

export function LibraryPage({
  installed,
  search,
  onLaunch,
  onStop,
  onDelete,
}: LibraryPageProps) {
  const [tab, setTab] = useState<LibraryTab>("installed");
  const query = search.trim().toLowerCase();
  const visibleGames = installed.filter((game) =>
    game.name.toLowerCase().includes(query),
  );

  return (
    <section className="list-page library-page">
      <h1 className="page-heading">Library</h1>
      <div className="library-filters" role="tablist" aria-label="Filter library">
        {([
          ["installed", "Installed"],
          ["favorites", "Favorites"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? "selected" : ""}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "favorites" ? (
        <div className="empty-state">No favorite games</div>
      ) : visibleGames.length ? (
        <div className="library-grid">
          {visibleGames.map((game) => {
            const installedGame = game;
            return (
              <article className="library-card" key={game.id}>
                <button
                  className="library-art"
                  onClick={() => installedGame.running ? onStop(game.id) : onLaunch(game.id)}
                  aria-label={`${installedGame.running ? "Stop" : "Play"} ${game.name}`}
                >
                  <Cover game={game} className="library-cover" />
                  <span className="library-art-overlay" aria-hidden="true">
                    {installedGame.running
                      ? <Square size={22} fill="currentColor" />
                      : <Play size={25} fill="currentColor" />}
                  </span>
                </button>
                <div className="library-card-info">
                  <span className="library-title" title={game.name}>{game.name}</span>
                  <div className="library-card-bottom">
                    <span className="installed-state">
                      <ShieldCheck size={16} aria-hidden="true" />
                      Installed
                    </span>
                    <details className="library-menu">
                      <summary aria-label={`More options for ${game.name}`}>
                        <MoreVertical size={18} />
                      </summary>
                      <div className="library-menu-popover" role="menu">
                        <button
                          role="menuitem"
                          disabled={installedGame.running}
                          onClick={(event) => {
                            event.currentTarget.closest("details")?.removeAttribute("open");
                            onDelete(installedGame);
                          }}
                        >
                          <Trash2 size={15} /> Delete
                        </button>
                      </div>
                    </details>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : <div className="empty-state">No installed games</div>}
    </section>
  );
}
