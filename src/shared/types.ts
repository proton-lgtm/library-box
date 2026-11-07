export type DownloadStatus =
  | "downloading"
  | "paused"
  | "cancelled"
  | "failed"
  | "installed";

export type DownloadQueueStatus =
  | "waiting"
  | "downloading"
  | "paused"
  | "applying"
  | "failed"
  | "cancelled"
  | "completed";

export type DownloadPhase =
  | "extracting"
  | "downloading-mod"
  | "applying-mods"
  | "finalizing";

export interface ModStep {
  type: "extract" | "move";
  target_folder?: string;
  target_path?: string;
  source_folder?: string;
}

export interface GameMod {
  name: string;
  asset_type?: "file" | "zip";
  download_links: Record<string, string>;
  steps_to_apply: ModStep[];
}

export interface Game {
  id: number;
  supabaseId?: string | null;
  name: string;
  thumbnail: string;
  sizeBytes?: number | null;
  lastUpdated?: string | null;
  tags?: string[];
  description?: string;
  releaseDate?: string | null;
  detailsLastUpdated?: string | null;
  developerLinks?: Record<string, string>;
  version?: string | null;
  operatingSystems?: string[];
  downloadLinks: Record<string, string>;
  mods: GameMod[];
  installDir: string | null;
}

export interface CatalogSnapshot {
  games: Game[];
  stale: boolean;
  lastSyncedAt: string | null;
  error: string | null;
}

export interface AuthState {
  status: "anonymous" | "account" | "unavailable";
  email: string | null;
  message: string | null;
}

export interface AuthCredentials {
  email: string;
  password: string;
}

export interface GameDownloadRecord {
  gameId: number;
  gameName: string;
  thumbnail: string;
  status: DownloadStatus;
  bytesDownloaded: number;
  totalBytes: number | null;
  expectedBytes?: number | null;
  error: string | null;
  installDir: string;
  phase?: DownloadPhase | null;
  phaseDetail?: string | null;
}

interface DownloadQueueItemBase {
  id: string;
  gameId: number;
  gameName: string;
  thumbnail: string;
  status: DownloadQueueStatus;
  bytesDownloaded: number;
  totalBytes: number | null;
  error: string | null;
  phase: DownloadPhase | null;
  detail: string | null;
  phaseDetail: string | null;
  installDir: string;
}

export interface GameDownloadQueueItem extends DownloadQueueItemBase {
  kind: "game";
  expectedBytes: number | null;
}

export interface ModDownloadQueueItem extends DownloadQueueItemBase {
  kind: "mod";
  modId: number;
  modName: string;
}

export type DownloadQueueItem = GameDownloadQueueItem | ModDownloadQueueItem;

/** @deprecated Renderer code should narrow DownloadQueueItem by kind. */
export interface Download {
  id?: string;
  kind?: "game" | "mod";
  gameId: number;
  gameName: string;
  thumbnail: string;
  modId?: number;
  modName?: string;
  status: DownloadQueueStatus | "installed";
  bytesDownloaded: number;
  totalBytes: number | null;
  expectedBytes?: number | null;
  error: string | null;
  installDir: string;
  phase?: DownloadPhase | null;
  detail?: string | null;
  phaseDetail?: string | null;
}

export interface InstalledGame extends Game {
  installDir: string;
  gameRoot: string;
  appliedModIds: number[];
  running: boolean;
}

export type DownloadUpdate = DownloadQueueItem;

export interface StartDownloadInput {
  gameId: number;
  url: string;
  destination: string;
  runAfter: boolean;
  selectedModIds: number[];
}

export interface DesktopApi {
  listGames(): Promise<Game[]>;
  refreshCatalog(): Promise<CatalogSnapshot>;
  getAuthState(): Promise<AuthState>;
  signIn(credentials: AuthCredentials): Promise<AuthState>;
  upgradeAnonymousAccount(credentials: AuthCredentials): Promise<AuthState>;
  signOut(): Promise<AuthState>;
  openExternal(url: string): Promise<void>;
  listDownloads(): Promise<DownloadQueueItem[]>;
  listLibrary(): Promise<InstalledGame[]>;
  chooseDestination(): Promise<string | null>;
  startDownload(input: StartDownloadInput): Promise<void>;
  pauseDownload(gameId: number): Promise<void>;
  resumeDownload(gameId: number): Promise<void>;
  manualDownload(gameId: number): Promise<void>;
  cancelDownload(gameId: number): Promise<void>;
  dismissTerminalDownload?(gameId: number): Promise<void>;
  clearTerminalDownloads?(): Promise<void>;
  cancelModDownload?(id: string): Promise<void>;
  retryModDownload?(id: string): Promise<void>;
  applyMods(gameId: number, modIds: number[]): Promise<void>;
  launchGame(gameId: number): Promise<void>;
  stopGame(gameId: number): Promise<void>;
  deleteGame(gameId: number): Promise<void>;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<boolean>;
  isWindowMaximized(): Promise<boolean>;
  closeWindow(): Promise<void>;
  onDownloadUpdate(callback: (update: DownloadUpdate) => void): () => void;
  onWindowMaximized(callback: (maximized: boolean) => void): () => void;
}
