import { Check, Download, MoreVertical, Play, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { Game, InstalledGame } from "../shared/types";
import { Cover } from "./Cover";

type LibraryFilter = "all" | "installed" | "not-installed";

interface LibraryPageProps {
  games: Game[];
  installed: InstalledGame[];
  search: string;
  onOpenGame: (game: Game) => void;
  onLaunch: (gameId: number) => void;
  onStop: (gameId: number) => void;
  onDelete: (game: InstalledGame) => void;
}

export function LibraryPage({
  games,
  installed,
  search,
  onOpenGame,
  onLaunch,
  onStop,
  onDelete,
}: LibraryPageProps) {
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const installedById = useMemo(() => new Map(installed.map((game) => [game.id, game])), [installed]);
  const visibleGames = games.filter((game) => {
    const isInstalled = installedById.has(game.id);
    const matchesFilter = filter === "all" || (filter === "installed" ? isInstalled : !isInstalled);
    return matchesFilter && game.name.toLowerCase().includes(search.trim().toLowerCase());
  });

  return (
    <section className="list-page library-page">
      <h1 className="page-heading">Library</h1>
      <div className="library-filters" role="tablist" aria-label="Filter library">
        {([
          ["all", "All Games"],
          ["installed", "Installed"],
          ["not-installed", "Not Installed"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={filter === value}
            className={filter === value ? "selected" : ""}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {visibleGames.length ? (
        <div className="library-grid">
          {visibleGames.map((game) => {
            const installedGame = installedById.get(game.id);
            return (
              <article className="library-card" key={game.id}>
                <button className="library-card-open" onClick={() => onOpenGame(game)} aria-label={`Open ${game.name} details`}>
                  <span className="library-art"><Cover game={game} className="library-cover" /></span>
                  <span className="library-title">{game.name}</span>
                </button>
                <div className="library-card-foot">
                  {installedGame ? (
                    <span className="installed-state"><Check size={14} /> Installed</span>
                  ) : <span className="not-installed-state"><Download size={14} /> Not Installed</span>}
                  <div className="library-actions">
                    {installedGame ? (
                      <>
                        <button className="library-play" onClick={() => installedGame.running ? onStop(game.id) : onLaunch(game.id)}>
                          <Play size={14} /> {installedGame.running ? "Stop" : "Play"}
                        </button>
                        <button className="library-more" disabled={installedGame.running} onClick={() => onDelete(installedGame)} aria-label={`Delete ${game.name}`}><Trash2 size={16} /></button>
                      </>
                    ) : (
                      <button className="library-more" onClick={() => onOpenGame(game)} aria-label={`View ${game.name}`}><MoreVertical size={17} /></button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : <div className="empty-state">No games in this view</div>}
    </section>
  );
}
