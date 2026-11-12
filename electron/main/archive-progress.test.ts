import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { path7za } from "7zip-bin";
import { afterEach, expect, it, vi } from "vitest";
import { extractArchive, resolveArchiveBinaryPath, type ExtractionProgress } from "./archive";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn: vi.fn(),
}));
it.each([
  [String.raw`C:\Portable App\resources\app.asar\node_modules\7zip-bin\win\x64\7za.exe`, String.raw`C:\Portable App\resources\app.asar.unpacked\node_modules\7zip-bin\win\x64\7za.exe`],
  ["/Applications/Playmart.app/Contents/Resources/app.asar/node_modules/7zip-bin/mac/arm64/7za", "/Applications/Playmart.app/Contents/Resources/app.asar.unpacked/node_modules/7zip-bin/mac/arm64/7za"],
  ["/opt/Playmart/resources/app.asar/node_modules/7zip-bin/linux/x64/7za", "/opt/Playmart/resources/app.asar.unpacked/node_modules/7zip-bin/linux/x64/7za"],
  [path7za, path7za],
  [String.raw`C:\app.asar-backup\resources\app.asar.unpacked\7za.exe`, String.raw`C:\app.asar-backup\resources\app.asar.unpacked\7za.exe`],
])("resolves the extractor executable on disk: %s", (input, expected) => {
  expect(resolveArchiveBinaryPath(input)).toBe(expected);
});

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function archiveFixture() {
  const root = mkdtempSync(path.join(process.cwd(), ".archive-progress-"));
  roots.push(root);
  writeFileSync(path.join(root, "file.txt"), "content");
  const archive = path.join(root, "input.zip");
  execFileSync(path7za, ["a", archive, "file.txt"], { cwd: root, stdio: "ignore" });
  return { root, archive };
}

function mockExtraction(chunks: string[], code = 0) {
  vi.mocked(spawn).mockImplementation((() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => {
      for (const chunk of chunks) child.stdout.write(chunk);
      if (code !== 0) child.stderr.write("archive checksum failed");
      child.emit("close", code);
    });
    return child;
  }) as unknown as typeof spawn);
}

it("parses chunked 7zip percentages and counts, deduplicates, and never regresses", async () => {
  const { root, archive } = archiveFixture();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => { now += 250; return now; });
  mockExtraction(["  0% 0\r  2", "5% 12\r 25% 13\r 10% 2\r  80% 45\r"]);
  const updates: ExtractionProgress[] = [];
  await extractArchive(archive, path.join(root, "output"), (update) => updates.push(update));
  expect(updates.map((update) => update.percent)).toEqual([null, 0, 25, 80, 100]);
  expect(updates[2].detail).toBe("12 entries processed");
  expect(spawn).toHaveBeenCalledWith(path7za, expect.arrayContaining(["-bsp1", "-bso0"]), expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }));
});

it("coalesces a burst of progress without delaying successful completion", async () => {
  const { root, archive } = archiveFixture();
  vi.spyOn(performance, "now").mockReturnValue(0);
  mockExtraction(Array.from({ length: 101 }, (_, percent) => ` ${percent}% ${percent}\r`));
  const updates: ExtractionProgress[] = [];
  await extractArchive(archive, path.join(root, "output"), (update) => updates.push(update));
  expect(updates.map((update) => update.percent)).toEqual([null, 0, 100]);
});

it("emits intermediate progress at most once every 250ms", async () => {
  const { root, archive } = archiveFixture();
  const now = vi.spyOn(performance, "now");
  now.mockReturnValueOnce(0).mockReturnValueOnce(100).mockReturnValueOnce(249)
    .mockReturnValueOnce(250).mockReturnValueOnce(400).mockReturnValueOnce(500);
  mockExtraction([" 0% 0\r10% 1\r20% 2\r30% 3\r40% 4\r50% 5\r"]);
  const updates: ExtractionProgress[] = [];
  await extractArchive(archive, path.join(root, "output"), (update) => updates.push(update));
  expect(updates.map((update) => update.percent)).toEqual([null, 0, 30, 50, 100]);
});

it("keeps progress indeterminate when the extractor produces no usable percentage", async () => {
  const { root, archive } = archiveFixture();
  mockExtraction(["Extracting files\rno percentage\r"]);
  const updates: ExtractionProgress[] = [];
  await extractArchive(archive, path.join(root, "output"), (update) => updates.push(update));
  expect(updates.map((update) => update.percent)).toEqual([null, 100]);
});

it("rejects extractor failures without reporting completion", async () => {
  const { root, archive } = archiveFixture();
  mockExtraction([" 12% 1\r"], 2);
  const updates: ExtractionProgress[] = [];
  await expect(extractArchive(archive, path.join(root, "output"), (update) => updates.push(update))).rejects.toThrow(/checksum failed/);
  expect(updates.map((update) => update.percent)).toEqual([null, 12]);
});
