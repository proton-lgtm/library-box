import type { Game } from "../shared/types";

const DOWNLOAD_PROVIDER_PRIORITY = ["direct_link", "pixeldrain", "gofile", "workupload", "direct"];

export function downloadProviders(game: Pick<Game, "downloadLinks">): Array<[string, string]> {
  return Object.entries(game.downloadLinks).filter((entry): entry is [string, string] => Boolean(entry[1]));
}

export function bestDownloadProvider(game: Pick<Game, "downloadLinks">): [string, string] | undefined {
  for (const key of DOWNLOAD_PROVIDER_PRIORITY) {
    if (game.downloadLinks[key]) return [key, game.downloadLinks[key]];
  }
  return downloadProviders(game)[0];
}

export function bestDownloadLink(game: Pick<Game, "downloadLinks">): string | undefined {
  return bestDownloadProvider(game)?.[1];
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
