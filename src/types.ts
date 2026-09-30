export type DownloadStatus = "downloading" | "paused" | "cancelled" | "failed" | "installed";

export interface Game {
  id: number;
  slug: string;
  title: string;
  creator: string;
  description: string;
  coverUrl: string;
  gameUrl: string;
  downloadUrl: string | null;
  genre: string;
  published: string;
  downloadStatus: DownloadStatus | null;
  browserOnly: boolean;
}

export interface Download {
  gameId: number;
  title: string;
  coverUrl: string;
  status: DownloadStatus;
  bytesDownloaded: number;
  totalBytes: number | null;
  error: string | null;
  installDir: string;
}

export interface InstalledGame {
  gameId: number;
  title: string;
  creator: string;
  coverUrl: string;
  installDir: string;
  running: boolean;
}

export interface DownloadProgress {
  gameId: number;
  status: DownloadStatus;
  bytesDownloaded: number;
  totalBytes: number | null;
  error: string | null;
}

export type Screen = "home" | "downloads" | "library";
