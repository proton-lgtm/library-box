import type { Game } from "../shared/types";
import { Cover } from "./Cover";

interface HomePageProps {
  games: Game[];
  onSelect: (game: Game) => void;
}

export function HomePage({ games, onSelect }: HomePageProps) {
  return (
    <section className="content-page">
      <h1 className="page-heading">Games</h1>
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
