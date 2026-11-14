import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true, getVersion: vi.fn(() => "0.1.3"), once: vi.fn(), removeListener: vi.fn() },
  showMessageBox: vi.fn(), fetch: vi.fn(), openExternal: vi.fn(),
  checkForUpdates: vi.fn(), quitAndInstall: vi.fn(),
}));
vi.mock("electron", () => ({
  app: mocks.app, dialog: { showMessageBox: mocks.showMessageBox },
  net: { fetch: mocks.fetch }, shell: { openExternal: mocks.openExternal },
}));
vi.mock("electron-updater", async () => {
  const { EventEmitter } = await import("node:events");
  return { autoUpdater: Object.assign(new EventEmitter(), {
    checkForUpdates: mocks.checkForUpdates, quitAndInstall: mocks.quitAndInstall,
    autoDownload: false, autoInstallOnAppQuit: true, allowPrerelease: true, allowDowngrade: true,
  }) };
});
import { autoUpdater } from "electron-updater";
import { isNewerStableRelease, startAutoUpdates, supportsAutomaticUpdates } from "./updater";

const events = autoUpdater as EventEmitter;
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.app.isPackaged = true;
  mocks.showMessageBox.mockResolvedValue({ response: 1 });
  mocks.checkForUpdates.mockResolvedValue(null);
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ tag_name: "v0.1.4" }) });
  vi.stubEnv("PORTABLE_EXECUTABLE_DIR", "");
  vi.stubEnv("APPIMAGE", "/opt/Playmart.AppImage");
});
afterEach(() => {
  stop?.();
  stop = undefined;
  (autoUpdater as unknown as EventEmitter).removeAllListeners();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([
  ["v0.1.4", "0.1.3", true], ["v0.1.3", "0.1.3", false],
  ["v0.1.2", "0.1.3", false], ["v0.2.0", "0.1.99", true],
  ["v0.1.3", "0.1.3-beta.1", true], ["v0.1.4-beta.1", "0.1.3", false],
  ["v0.1.4/evil", "0.1.3", false], ["v01.1.4", "0.1.3", false],
])("compares %s with %s", (tag, installed, expected) => {
  expect(isNewerStableRelease(tag, installed)).toBe(expected);
});
it("distinguishes automatic and manual package types", () => {
  expect(supportsAutomaticUpdates("win32", {})).toBe(true);
  expect(supportsAutomaticUpdates("win32", { PORTABLE_EXECUTABLE_DIR: "portable" })).toBe(false);
  expect(supportsAutomaticUpdates("darwin", {})).toBe(true);
  expect(supportsAutomaticUpdates("linux", { APPIMAGE: "/opt/app" })).toBe(true);
  expect(supportsAutomaticUpdates("linux", {})).toBe(false);
});

describe("automatic updates", () => {
  it("skips development builds", () => {
    mocks.app.isPackaged = false;
    stop = startAutoUpdates();
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
  });
  it("downloads automatically but never installs on exit or after Later", async () => {
    stop = startAutoUpdates();
    expect(mocks.checkForUpdates).toHaveBeenCalledOnce();
    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
    expect(autoUpdater.allowPrerelease).toBe(false);
    expect(autoUpdater.allowDowngrade).toBe(false);
    events.emit("update-downloaded", { version: "0.1.4" });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.showMessageBox).toHaveBeenCalledOnce();
    expect(mocks.quitAndInstall).not.toHaveBeenCalled();
  });
  it("installs only after explicit approval", async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    stop = startAutoUpdates();
    events.emit("update-downloaded", { version: "0.1.4" });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.quitAndInstall).toHaveBeenCalledOnce();
  });
  it("does not install if shutdown starts while the dialog is open", async () => {
    let resolve: (value: { response: number }) => void = () => {};
    mocks.showMessageBox.mockReturnValue(new Promise((done) => { resolve = done; }));
    stop = startAutoUpdates();
    events.emit("update-downloaded", { version: "0.1.4" });
    stop();
    resolve({ response: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.quitAndInstall).not.toHaveBeenCalled();
  });
  it("retries failed checks without interrupting offline usage", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.checkForUpdates.mockRejectedValue(new Error("offline"));
    stop = startAutoUpdates();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    stop();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});

describe.skipIf(process.platform !== "win32")("portable update fallback", () => {
  beforeEach(() => { vi.stubEnv("PORTABLE_EXECUTABLE_DIR", "portable"); });
  it("opens only the trusted release URL after approval", async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    stop = startAutoUpdates();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.openExternal).toHaveBeenCalledWith("https://github.com/proton-lgtm/library-box/releases/tag/v0.1.4");
  });
  it.each(["v0.1.2", "v0.1.3", "https://evil.invalid", "v0.1.4-beta.1"])("ignores %s", async (tag) => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ tag_name: tag }) });
    stop = startAutoUpdates();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });
});
