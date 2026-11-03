export type DownloadStatus =
  | "downloading"
  | "paused"
  | "cancelled"
  | "failed"
  | "installed";

export interface ModStep {
  type: "extract" | "move";
  target_folder: string;
  source_folder?: string;
}

export interface GameMod {
  name: string;
  download_links: Record<string, string>;
  steps_to_apply: ModStep[];
}

export interface Game {
  id: number;
  name: string;
  thumbnail: string;
  downloadLinks: Record<string, string>;
  mods: GameMod[];
  installDir: string | null;
}

export interface Download {
  gameId: number;
  gameName: string;
  thumbnail: string;
  status: DownloadStatus;
  bytesDownloaded: number;
  totalBytes: number | null;
  error: string | null;
  installDir: string;
}

export interface InstalledGame extends Game {
  installDir: string;
  running: boolean;
}

export interface DownloadUpdate {
  gameId: number;
  bytesDownloaded: number;
  totalBytes: number | null;
  status: DownloadStatus;
  error: string | null;
}

export interface StartDownloadInput {
  gameId: number;
  url: string;
  destination: string;
  runAfter: boolean;
  selectedModIds: number[];
}

export interface DesktopApi {
  listGames(): Promise<Game[]>;
  listDownloads(): Promise<Download[]>;
  listLibrary(): Promise<InstalledGame[]>;
  chooseDestination(): Promise<string | null>;
  startDownload(input: StartDownloadInput): Promise<void>;
  pauseDownload(gameId: number): Promise<void>;
  resumeDownload(gameId: number): Promise<void>;
  cancelDownload(gameId: number): Promise<void>;
  launchGame(gameId: number): Promise<void>;
  stopGame(gameId: number): Promise<void>;
  onDownloadUpdate(callback: (update: DownloadUpdate) => void): () => void;
}
