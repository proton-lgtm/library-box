import { useState } from "react";
import type { Game } from "../shared/types";

export function Cover({ game, className = "" }: { game: Pick<Game, "name" | "thumbnail">; className?: string }) {
  const [failed, setFailed] = useState(false);

  if (!game.thumbnail || failed) {
    return <div className={`cover-fallback ${className}`} role="img" aria-label={`${game.name} cover`} />;
  }

  return (
    <img
      className={className}
      src={game.thumbnail}
      alt={`${game.name} cover`}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
