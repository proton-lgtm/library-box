// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, Game, InstalledGame } from "./shared/types";
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

beforeEach(() => {
  localStorage.clear();
  installed = [];
  api = {
    listGames: vi.fn().mockResolvedValue([game]),
    listDownloads: vi.fn().mockResolvedValue([]),
    listLibrary: vi.fn().mockImplementation(async () => installed),
    chooseDestination: vi.fn().mockResolvedValue("C:\\Games"),
    startDownload: vi.fn().mockResolvedValue(undefined),
    pauseDownload: vi.fn().mockResolvedValue(undefined),
    resumeDownload: vi.fn().mockResolvedValue(undefined),
    cancelDownload: vi.fn().mockResolvedValue(undefined),
    launchGame: vi.fn().mockResolvedValue(undefined),
    stopGame: vi.fn().mockResolvedValue(undefined),
    onDownloadUpdate: vi.fn().mockReturnValue(vi.fn()),
  };
  Object.defineProperty(window, "library", { value: api, configurable: true });
});

afterEach(cleanup);

describe("Electron game library UI", () => {
  it("shows imported games and opens their detail page", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: /Your games/ });
    await user.click(container.querySelector(".game-card") as HTMLButtonElement);
    expect(await screen.findByRole("heading", { name: "Sample Game" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "DOWNLOAD GAME" })).toBeTruthy();
  });

  it("asks for an install folder and passes the auto-run preference", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: /Your games/ });
    await user.click(container.querySelector(".game-card") as HTMLButtonElement);
    await user.click(await screen.findByRole("button", { name: "DOWNLOAD GAME" }));
    await user.click(screen.getByRole("button", { name: "BROWSE" }));
    expect(await screen.findByText("C:\\Games")).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: "Auto-run after download" }));
    await user.click(screen.getByRole("button", { name: "START DOWNLOAD" }));
    await waitFor(() => {
      expect(api.startDownload).toHaveBeenCalledWith({
        gameId: 1,
        url: "https://downloads.example/game.zip",
        destination: "C:\\Games",
        runAfter: true,
        selectedModIds: [],
      });
    });
    expect(localStorage.getItem("redline.install-folder")).toBe("C:\\Games");
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
    await screen.findByRole("heading", { name: /Your games/ });
    await user.click(container.querySelector(".game-card") as HTMLButtonElement);
    await user.click(await screen.findByRole("button", { name: "DOWNLOAD GAME" }));
    await user.click(screen.getByRole("button", { name: "BROWSE" }));
    await screen.findByText("Gallery Unlocker");
    await user.click(screen.getByRole("checkbox", { name: /Gallery Unlocker/ }));
    await user.click(screen.getByRole("button", { name: "START DOWNLOAD" }));
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
    await user.click(await screen.findByRole("button", { name: /Downloads/ }));
    await user.click(screen.getByRole("button", { name: "Pause Sample Game" }));
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
    await user.click(await screen.findByRole("button", { name: /Library/ }));
    await user.click(await screen.findByRole("button", { name: /PLAY/ }));
    await waitFor(() => expect(api.launchGame).toHaveBeenCalledWith(1));
    installed[0].running = true;
    rerender(<App key="updated-library" />);
    await user.click(await screen.findByRole("button", { name: /Library/ }));
    await user.click(await screen.findByRole("button", { name: /STOP/ }));
    await waitFor(() => expect(api.stopGame).toHaveBeenCalledWith(1));
  });
});
