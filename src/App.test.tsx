// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthState, DesktopApi, Game, InstalledGame } from "./shared/types";
import { DownloadsPage } from "./components/DownloadsPage";
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
    manualDownload: vi.fn().mockResolvedValue(undefined),
    cancelDownload: vi.fn().mockResolvedValue(undefined),
    applyMods: vi.fn().mockResolvedValue(undefined),
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

  it("allows cancelling a failed download", async () => {
    api.listDownloads = vi.fn()
      .mockResolvedValueOnce([{
      gameId: 1,
      gameName: "Sample Game",
      thumbnail: "",
      status: "failed",
      bytesDownloaded: 50,
      totalBytes: 100,
      error: "Connection interrupted.",
      installDir: "C:\\Games\\Sample Game",
      }])
      .mockResolvedValue([]);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Downloads" }));
    await user.click(screen.getByRole("button", { name: "Cancel Sample Game" }));
    await waitFor(() => expect(api.cancelDownload).toHaveBeenCalledWith(1));
    expect(await screen.findByText("No active downloads")).toBeTruthy();
  });

  it("launches and stops installed games from the library", async () => {
    installed = [{
      ...game,
      installDir: "C:\\Games\\Sample Game",
      gameRoot: "C:\\Games\\Sample Game",
      appliedModIds: [],
      running: false,
    }];
    const user = userEvent.setup();
    const { rerender } = render(<App />);
    await user.click(await screen.findByRole("button", { name: "Library" }));
    await user.click(await screen.findByRole("button", { name: "Play Sample Game" }));
    await waitFor(() => expect(api.launchGame).toHaveBeenCalledWith(1));
    installed[0].running = true;
    rerender(<App key="updated-library" />);
    await user.click(await screen.findByRole("button", { name: "Library" }));
    await user.click(await screen.findByRole("button", { name: "Stop Sample Game" }));
    await waitFor(() => expect(api.stopGame).toHaveBeenCalledWith(1));
  });

  it("confirms and deletes an installed game from the library", async () => {
    installed = [{
      ...game,
      installDir: "C:\\Games\\Sample Game",
      gameRoot: "C:\\Games\\Sample Game",
      appliedModIds: [],
      running: false,
    }];
    api.deleteGame = vi.fn().mockImplementation(async () => { installed = []; });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Library" }));
    await user.click(await screen.findByLabelText("More options for Sample Game"));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const deleteButtons = screen.getAllByRole("button", { name: /^Delete$/ });
    await user.click(deleteButtons[deleteButtons.length - 1]);
    await waitFor(() => expect(api.deleteGame).toHaveBeenCalledWith(1));
    await user.click(screen.getByRole("tab", { name: "Installed" }));
    expect(await screen.findByText("No installed games")).toBeTruthy();
  });

  it("opens installed mod choices and only submits newly selected mods", async () => {
    const gameWithMods: Game = {
      ...game,
      mods: [
        {
          name: "Applied Patch",
          download_links: { direct_link: "https://downloads.example/applied.zip" },
          steps_to_apply: [],
        },
        {
          name: "Optional Patch",
          download_links: { direct_link: "https://downloads.example/optional.zip" },
          steps_to_apply: [],
        },
      ],
    };
    installed = [{
      ...gameWithMods,
      installDir: "C:\\Games\\Sample Game",
      gameRoot: "C:\\Games\\Sample Game",
      appliedModIds: [0],
      running: false,
    }];
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Library" }));
    await user.click(await screen.findByLabelText("More options for Sample Game"));
    await user.click(screen.getByRole("menuitem", { name: "Mods" }));
    const appliedCheckbox = screen.getByRole("checkbox", { name: /Applied Patch/ });
    expect((appliedCheckbox as HTMLInputElement).checked).toBe(true);
    expect((appliedCheckbox as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Apply mods" })).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: /Optional Patch/ }));
    await user.click(screen.getByRole("button", { name: "Apply mods" }));
    await waitFor(() => expect(api.applyMods).toHaveBeenCalledWith(1, [1]));
  });

  it("shows only the Installed and Favorites library tabs", async () => {
    const user = userEvent.setup();
    installed = [{
      ...game,
      installDir: "C:\\Games\\Sample Game",
      gameRoot: "C:\\Games\\Sample Game",
      appliedModIds: [],
      running: false,
    }];
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Library" }));
    expect((await screen.findByRole("tab", { name: "Installed" })).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Sample Game")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "All Games" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Not Installed" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Favorites" }));
    expect(await screen.findByText("No favorite games")).toBeTruthy();
  });

  it("shows extraction and mod-application progress instead of download status", () => {
    const download: import("./shared/types").Download = {
      gameId: 1,
      gameName: "Sample Game",
      thumbnail: "",
      status: "downloading",
      bytesDownloaded: 100,
      totalBytes: 100,
      error: null,
      installDir: "C:\\Games\\Sample Game",
      phase: "applying-mods",
      phaseDetail: "Community Patch",
    };
    const { rerender } = render(
      <DownloadsPage downloads={[download]} onPause={vi.fn()} onResume={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText("Applying mods")).toBeTruthy();
    expect(screen.getByText("Applying Community Patch…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();

    rerender(
      <DownloadsPage
        downloads={[{ ...download, phase: "extracting", phaseDetail: null }]}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Extracting")).toBeTruthy();
    expect(screen.getByText("Extracting game archive…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel Sample Game" })).toBeNull();
  });

  it("estimates remaining download time from transfer progress", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(1000).mockReturnValueOnce(3000);
    const download: import("./shared/types").Download = {
      gameId: 1,
      gameName: "Sample Game",
      thumbnail: "",
      status: "downloading",
      bytesDownloaded: 50,
      totalBytes: 100,
      error: null,
      installDir: "C:\\Games\\Sample Game",
    };
    const { rerender } = render(
      <DownloadsPage downloads={[download]} onPause={vi.fn()} onResume={vi.fn()} onCancel={vi.fn()} />,
    );
    rerender(
      <DownloadsPage
        downloads={[{ ...download, bytesDownloaded: 60 }]}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Less than a minute remaining")).toBeTruthy();
    now.mockRestore();
  });
});
