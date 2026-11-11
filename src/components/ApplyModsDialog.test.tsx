// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameDownloadQueueItem, InstalledGame } from "../shared/types";
import { ApplyModsDialog } from "./ApplyModsDialog";
import { DownloadsPage } from "./DownloadsPage";

const game: InstalledGame = {
  id: 1, name: "Game 01", thumbnail: "", installDir: "C:\\Games\\Game 01",
  gameRoot: "C:\\Games\\Game 01", running: false, appliedModIds: [0],
  downloadLinks: { direct: "https://example.com/game.zip" },
  mods: [{ name: "Walkthrough Mod", download_links: { direct: "https://example.com/mod.zip" }, steps_to_apply: [] }],
};
const download: GameDownloadQueueItem = {
  id: "game:1", kind: "game", gameId: 1, gameName: game.name, thumbnail: "",
  status: "applying", bytesDownloaded: 100, totalBytes: 100, expectedBytes: 100,
  error: null, phase: "extracting", phaseDetail: "Extracting original archive…", detail: null,
  installDir: game.installDir, extractionProgress: 62,
};
afterEach(cleanup);

describe("remove all mods flow", () => {
  it("requires confirmation, blocks dismissal during restore, then clears selections", async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const onRemoveAll = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onClose = vi.fn();
    const props = { game, applying: false, onApply: vi.fn(), onClose, onRemoveAll };
    const { rerender } = render(<ApplyModsDialog {...props} />);
    await user.click(screen.getByRole("button", { name: "Remove all mods" }));
    expect(screen.getByText(/including mods and any local saves/)).toBeTruthy();
    expect(onRemoveAll).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Keep mods" }));
    expect(onRemoveAll).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Remove all mods" }));
    await user.click(screen.getByRole("button", { name: "Remove all mods" }));
    expect(onRemoveAll).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Close dialog" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<ApplyModsDialog {...props} resetting resetProgress={download} />);
    expect(screen.getByRole("progressbar", { name: "Game restoration progress" }).getAttribute("aria-valuenow")).toBe("62");
    await act(async () => finish());
    rerender(<ApplyModsDialog {...props} game={{ ...game, appliedModIds: [] }} />);
    expect(screen.getByRole("heading", { name: "All mods removed" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back to mods" }));
    expect((screen.getByRole("checkbox", { name: "Walkthrough Mod" }) as HTMLInputElement).checked).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows preflight errors and allows retry without closing", async () => {
    const user = userEvent.setup();
    const onRemoveAll = vi.fn().mockRejectedValueOnce(new Error("Original archive not found.")).mockResolvedValueOnce(undefined);
    render(<ApplyModsDialog game={game} applying={false} onApply={vi.fn()} onClose={vi.fn()} onRemoveAll={onRemoveAll} />);
    await user.click(screen.getByRole("button", { name: "Remove all mods" }));
    await user.click(screen.getByRole("button", { name: "Remove all mods" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Original archive not found.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "All mods removed" })).toBeTruthy();
  });
});

describe("extraction progress", () => {
  it("renders actual game and mod extraction percentages, not completed byte progress", () => {
    render(<DownloadsPage downloads={[download, { ...download, id: "mod:1", kind: "mod", modId: 0, modName: "Walkthrough Mod", extractionProgress: 40 }]} onPause={vi.fn()} onResume={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("progressbar", { name: "Game 01 progress" }).getAttribute("aria-valuenow")).toBe("62");
    expect(screen.getByRole("progressbar", { name: "Walkthrough Mod progress" }).getAttribute("aria-valuenow")).toBe("40");
    expect(screen.getAllByText("Extracting")).toHaveLength(2);
  });

  it("uses indeterminate progress when extraction information is unavailable", () => {
    render(<DownloadsPage downloads={[{ ...download, extractionProgress: null }]} onPause={vi.fn()} onResume={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
  });
});
