import { beforeEach, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../src/shared/types";
import type { LibraryDatabase } from "./database";
import type { DownloadManager } from "./downloads/download-manager";
import type { Launcher } from "./launcher";
import type { LibraryManager } from "./library-manager";
import type { SupabaseService } from "./supabase-service";

const bridge = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  api: undefined as DesktopApi | undefined,
}));
vi.mock("electron", () => ({
  BrowserWindow: vi.fn(), dialog: {}, shell: {},
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => bridge.handlers.set(channel, handler) },
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) => bridge.handlers.get(channel)!({ senderFrame: { url: "https://renderer.example/" } }, ...args),
    on: vi.fn(), removeListener: vi.fn(),
  },
  contextBridge: { exposeInMainWorld: (_name: string, api: DesktopApi) => { bridge.api = api; } },
}));
import { registerIpc } from "./ipc";
import "../preload/index";

const downloads = {
  reverifyLocalGames: vi.fn(async () => {}), removeAllMods: vi.fn(async (_gameId: number) => {}),
  activeGameIds: vi.fn(() => new Set([3])), onUpdate: vi.fn(), removeGameQueueHistory: vi.fn(),
  runExclusive: vi.fn(async (_gameId: number, operation: () => Promise<void>) => operation()),
};
const database = { listLibrary: vi.fn() };
const launcher = { runningIds: vi.fn(() => new Set([4])), launch: vi.fn(async () => {}) };
const library = { deleteGame: vi.fn(async () => {}) };
beforeEach(() => {
  vi.clearAllMocks();
  bridge.handlers.clear();
  registerIpc(() => undefined, database as unknown as LibraryDatabase, downloads as unknown as DownloadManager,
    launcher as unknown as Launcher, library as unknown as LibraryManager, {} as SupabaseService, "https://renderer.example/");
});

it("wires the approved reverify and remove-all-mods preload methods to IPC", async () => {
  await bridge.api!.reverifyLocalGames();
  await bridge.api!.removeAllMods(12);
  expect(downloads.reverifyLocalGames).toHaveBeenCalledOnce();
  expect(downloads.removeAllMods).toHaveBeenCalledWith(12);
});

it("validates reset IDs and rejects untrusted IPC senders", async () => {
  await expect(bridge.api!.removeAllMods(-1)).rejects.toThrow();
  expect(downloads.removeAllMods).not.toHaveBeenCalled();
  expect(() => bridge.handlers.get("library:reverify-local-games")!({ senderFrame: { url: "https://untrusted.example/" } })).toThrow(/Untrusted/);
  expect(downloads.reverifyLocalGames).not.toHaveBeenCalled();
});

it("protects active library records and serializes launch/delete against resets", async () => {
  await bridge.api!.listLibrary();
  expect(database.listLibrary).toHaveBeenCalledWith(new Set([4]), new Set([3]));
  await bridge.api!.launchGame(12);
  await bridge.api!.deleteGame(12);
  expect(downloads.runExclusive).toHaveBeenCalledTimes(2);
  expect(launcher.launch).toHaveBeenCalledWith(12);
  expect(library.deleteGame).toHaveBeenCalledWith(12);
});
