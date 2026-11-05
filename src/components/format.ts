import type { Game } from "../shared/types";

export function bestDownloadLink(game: Game): string | undefined {
  const priority = ["direct_link", "pixeldrain", "gofile", "workupload", "direct"];
  for (const key of priority) {
    if (game.downloadLinks[key]) return game.downloadLinks[key];
  }
  return Object.values(game.downloadLinks)[0];
}

export function displayLabel(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

export function asGameCover(game: {
  gameId: number;
  gameName: string;
  thumbnail: string;
}): Pick<Game, "name" | "thumbnail"> {
  return { name: game.gameName, thumbnail: game.thumbnail };
}
