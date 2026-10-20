// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Game, GameFile, InstalledGame } from "./types";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  open: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

import App from "./App";

const stillwaterFile: GameFile = {
  uploadId: null,
  fileName: "StillwaterRemastered-2.0-win.zip",
  size: "458 MB",
  platforms: ["Windows"],
  installable: true,
};

const stillwater: Game = {
  id: 11,
  slug: "stillwater",
  title: "Stillwater",
  creator: "Studio Clump",
  description: "A mysterious letter draws investigator Hugo Laurent into an old family's curse.",
  coverUrl: "",
  gameUrl: "https://studioclump.itch.io/stillwater",
  downloadUrl: null,
  genre: "Visual novel",
  published: "Remastered Dec 2023",
  downloadStatus: "installed",
  browserOnly: false,
  browserPlayable: false,
  files: [stillwaterFile],
};

let library: InstalledGame[];
let downloadDestination: string;

function installCommandMocks() {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "list_games") return [stillwater];
    if (command === "list_downloads") return [];
    if (command === "list_library") return library;
    if (command === "refresh_game_files") return [stillwaterFile];
    if (command === "start_download") return undefined;
    if (command === "launch_game") return undefined;
    throw new Error(`Unexpected Tauri command: ${command}`);
  });
}

async function openStillwaterDetails(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Stillwater/ }));
  return screen.findByRole("button", { name: "DOWNLOAD GAME" });
}

describe("library install workflow", () => {
  beforeEach(() => {
    localStorage.clear();
    library = [];
    downloadDestination = "C:\\Users\\azureuser\\Downloads";
    window.scrollTo = vi.fn();
    installCommandMocks();
    mocks.listen.mockResolvedValue(vi.fn());
    mocks.open.mockResolvedValue(downloadDestination);
    mocks.openUrl.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("remembers the last selected folder and starts the selected Windows build there", async () => {
    const user = userEvent.setup();
    const firstMount = render(<App />);

    await openStillwaterDetails(user);
    await user.click(screen.getByRole("button", { name: "DOWNLOAD GAME" }));
    await user.click(screen.getByRole("button", { name: /BROWSE/ }));
    expect(await screen.findByText(downloadDestination)).toBeTruthy();
    firstMount.unmount();

    render(<App />);
    await openStillwaterDetails(user);
    await user.click(screen.getByRole("button", { name: "DOWNLOAD GAME" }));
    expect(screen.getByText(downloadDestination)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "START DOWNLOAD" }));
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("start_download", {
        gameId: stillwater.id,
        destination: downloadDestination,
        runAfter: false,
        fileName: stillwaterFile.fileName,
        uploadId: null,
      });
    });
    expect(localStorage.getItem("redline.last-install-folder")).toBe(downloadDestination);
  });

  it("refreshes installed-game availability on load and each page navigation", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /Discover/ });
    await waitFor(() => {
      expect(mocks.invoke.mock.calls.filter(([command]) => command === "list_library")).toHaveLength(1);
    });

    await user.click(screen.getByRole("button", { name: /My Library/ }));
    await waitFor(() => {
      expect(mocks.invoke.mock.calls.filter(([command]) => command === "list_library")).toHaveLength(2);
    });
  });

  it("offers Download instead of another-copy when an old install is missing", async () => {
    const user = userEvent.setup();
    library = [];
    render(<App />);

    await openStillwaterDetails(user);
    expect(screen.queryByRole("button", { name: /INSTALL ANOTHER COPY/ })).toBeNull();
    expect(screen.getByRole("button", { name: "DOWNLOAD GAME" })).toBeTruthy();
  });

  it("offers Play and launches when the install is still available", async () => {
    const user = userEvent.setup();
    library = [{
      gameId: stillwater.id,
      title: stillwater.title,
      creator: stillwater.creator,
      coverUrl: stillwater.coverUrl,
      installDir: `${downloadDestination}\\stillwater`,
      running: false,
    }];
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /Stillwater/ }));
    const playButton = await screen.findByRole("button", { name: "PLAY" });
    await user.click(playButton);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("launch_game", { gameId: stillwater.id }));
  });
});