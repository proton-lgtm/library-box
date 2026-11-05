// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthState, DesktopApi, Game, InstalledGame } from "./shared/types";
import App from "./App";

const game: Game = {
  id: 1,
  name: "Sample Game",
  thumbnail: "",
  downloadLinks: { direct_link: "https://downloads.example/game.zip" },
  mods: [],
  installDir: null,
};

let api: DesktopApi;
let installed: InstalledGame[];
let authState: AuthState;

beforeEach(() => {
  localStorage.clear();
  installed = [];
  authState = { status: "anonymous", email: null, message: null };
  api = {
    listGames: vi.fn().mockResolvedValue([game]),
    refreshCatalog: vi.fn().mockResolvedValue({
      games: [game],
      stale: false,
      lastSyncedAt: "2026-11-05T00:00:00.000Z",
      error: null,
    }),
    getAuthState: vi.fn().mockImplementation(async () => authState),
    signIn: vi.fn().mockImplementation(async ({ email }) => {
      authState = { status: "account", email, message: null };
      return authState;
    }),
    upgradeAnonymousAccount: vi.fn().mockImplementation(async ({ email }) => {
      authState = { status: "account", email, message: null };
      return authState;
    }),
    signOut: vi.fn().mockImplementation(async () => {
      authState = { status: "anonymous", email: null, message: null };
      return authState;
    }),
    openExternal: vi.fn().mockResolvedValue(undefined),
    listDownloads: vi.fn().mockResolvedValue([]),
    listLibrary: vi.fn().mockImplementation(async () => installed),
    chooseDestination: vi.fn().mockResolvedValue("C:\\Games"),
    startDownload: vi.fn().mockResolvedValue(undefined),
    pauseDownload: vi.fn().mockResolvedValue(undefined),
    resumeDownload: vi.fn().mockResolvedValue(undefined),
    cancelDownload: vi.fn().mockResolvedValue(undefined),
    launchGame: vi.fn().mockResolvedValue(undefined),
    stopGame: vi.fn().mockResolvedValue(undefined),
    deleteGame: vi.fn().mockResolvedValue(undefined),
    minimizeWindow: vi.fn().mockResolvedValue(undefined),
    toggleMaximizeWindow: vi.fn().mockResolvedValue(false),
    isWindowMaximized: vi.fn().mockResolvedValue(false),
    closeWindow: vi.fn().mockResolvedValue(undefined),
    onDownloadUpdate: vi.fn().mockReturnValue(vi.fn()),
    onWindowMaximized: vi.fn().mockReturnValue(vi.fn()),
  };
  Object.defineProperty(window, "library", { value: api, configurable: true });
});

afterEach(cleanup);

describe("Electron game library UI", () => {
  it("shows imported games and opens their detail page", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: "Games" });
    await user.click(container.querySelector(".game-card") as HTMLButtonElement);
    expect(await screen.findByRole("heading", { name: "Sample Game" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  });

  it("upgrades the anonymous account using the entered email and password", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Profile" }));
    await user.type(screen.getByLabelText("Email"), "player@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.type(screen.getByLabelText("Confirm password"), "password123");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => {
      expect(api.upgradeAnonymousAccount).toHaveBeenCalledWith({
        email: "player@example.com",
        password: "password123",
      });
    });
    expect(await screen.findByText("player@example.com")).toBeTruthy();
  });

  it("shows cached catalog state and lets the user retry a refresh", async () => {
    api.refreshCatalog = vi.fn()
      .mockResolvedValueOnce({
        games: [game],
        stale: true,
        lastSyncedAt: "2026-11-04T00:00:00.000Z",
        error: "Network unavailable.",
      })
      .mockResolvedValueOnce({
        games: [game],
        stale: false,
        lastSyncedAt: "2026-11-05T00:00:00.000Z",
        error: null,
      });
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText(/Network unavailable/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Refresh catalog" }));
    await waitFor(() => expect(api.refreshCatalog).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("asks for an install folder and passes the auto-run preference", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: "Games" });
    await user.click(container.querySelector(".game-card") as HTMLButtonElement);
    await user.click(await screen.findByRole("button", { name: "Download" }));
    await user.click(screen.getByRole("button", { name: "Browse" }));
    expect(await screen.findByText("C:\\Games")).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: "Run after install" }));
    await user.click(screen.getByRole("button", { name: "Start download" }));
    await waitFor(() => {
      expect(api.startDownload).toHaveBeenCalledWith({
        gameId: 1,
        url: "https://downloads.example/game.zip",
        destination: "C:\\Games",
        runAfter: true,
        selectedModIds: [],
      });
    });
    expect(localStorage.getItem("game-library.install-folder")).toBe("C:\\Games");
  });

  it("allows choosing optional mods for installation", async () => {
    const gameWithMods: Game = {
      ...game,
      mods: [
        {
          name: "Gallery Unlocker",
          download_links: { direct_link: "https://downloads.example/gallery.zip" },
          steps_to_apply: [{ type: "move", source_folder: "game", target_folder: "%GAME_ROOT%/game" }],
        },
        {
          name: "Optional Patch",
          download_links: { gofile: "https://gofile.io/d/example" },
          steps_to_apply: [],
        },
      ],
    };
    api.listGames = vi.fn().mockResolvedValue([gameWithMods]);
    const user = userEvent.setup();
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: "Games" });
    await user.click(container.querySelector(".game-card") as HTMLButtonElement);
    await user.click(await screen.findByRole("button", { name: "Download" }));
    await user.click(screen.getByRole("button", { name: "Browse" }));
    await screen.findByRole("checkbox", { name: /Gallery Unlocker/ });
    await user.click(screen.getByRole("checkbox", { name: /Gallery Unlocker/ }));
    await user.click(screen.getByRole("button", { name: "Start download" }));
    await waitFor(() => {
      expect(api.startDownload).toHaveBeenCalledWith(expect.objectContaining({
        gameId: 1,
        selectedModIds: [0],
      }));
    });
  });

  it("exposes active downloads from navigation and allows pause", async () => {
    const user = userEvent.setup();
    const active: import("./shared/types").Download = {
      gameId: 1,
      gameName: "Sample Game",
      thumbnail: "",
      status: "downloading",
      bytesDownloaded: 50,
      totalBytes: 100,
      error: null,
      installDir: "C:\\Games\\Sample Game",
    };
    api.listDownloads = vi.fn().mockResolvedValue([active]);
    const { container } = render(<App />);
    await user.click(await screen.findByRole("button", { name: "Downloads" }));
    await user.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(api.pauseDownload).toHaveBeenCalledWith(1));
    expect(container.querySelector(".progress-track")).toBeTruthy();
  });

  it("launches and stops installed games from the library", async () => {
    installed = [{
      ...game,
      installDir: "C:\\Games\\Sample Game",
      running: false,
    }];
    const user = userEvent.setup();
    const { rerender } = render(<App />);
    await user.click(await screen.findByRole("button", { name: "Library" }));
    await user.click(await screen.findByRole("button", { name: "Play" }));
    await waitFor(() => expect(api.launchGame).toHaveBeenCalledWith(1));
    installed[0].running = true;
    rerender(<App key="updated-library" />);
    await user.click(await screen.findByRole("button", { name: "Library" }));
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(api.stopGame).toHaveBeenCalledWith(1));
  });

  it("confirms and deletes an installed game from the library", async () => {
    installed = [{
      ...game,
      installDir: "C:\\Games\\Sample Game",
      running: false,
    }];
    api.deleteGame = vi.fn().mockImplementation(async () => { installed = []; });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Library" }));
    await user.click(await screen.findByRole("button", { name: /^Delete$/ }));
    const deleteButtons = screen.getAllByRole("button", { name: /^Delete$/ });
    await user.click(deleteButtons[deleteButtons.length - 1]);
    await waitFor(() => expect(api.deleteGame).toHaveBeenCalledWith(1));
    await waitFor(() => expect(screen.getByText("No installed games")).toBeTruthy());
  });
});
