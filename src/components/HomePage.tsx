import type { Game } from "../shared/types";
import { Cover } from "./Cover";
import { ReloadButton, type ReloadProps } from "./ReloadButton";

interface HomePageProps extends ReloadProps {
  games: Game[];
  onSelect: (game: Game) => void;
}

export function HomePage({ games, onSelect, onReload, reloading }: HomePageProps) {
  return (
    <section className="content-page">
      <div className="page-heading-row">
        <h1 className="page-heading">Games</h1>
        <ReloadButton onReload={onReload} reloading={reloading} />
      </div>
      {games.length ? (
        <div className="game-grid">
          {games.map((game) => (
            <button className="game-card" key={game.id} onClick={() => onSelect(game)}>
              <Cover game={game} className="card-cover" />
              <span className="card-title">{game.name}</span>
              {game.tags && game.tags.length > 0 && (
                <span className="card-tags">{game.tags.slice(0, 3).join(" · ")}</span>
              )}
            </button>
          ))}
        </div>
      ) : <div className="empty-state">No games found</div>}
    </section>
  );
}
