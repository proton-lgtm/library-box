import { execFile, spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { path7za } from "7zip-bin";

const execFileAsync = promisify(execFile);

export function resolveArchiveBinaryPath(binaryPath: string): string {
  // Child processes need a real executable, not Electron's virtual ASAR path.
  return binaryPath.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
}

const archiveBinaryPath = resolveArchiveBinaryPath(path7za);

export function validateArchivePaths(
  entries: string[],
  destination: string,
): void {
  const root = path.resolve(destination);
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    const parts = normalized.split("/");
    const target = path.resolve(root, ...parts);
    if (
      path.isAbsolute(entry) ||
      /^[a-zA-Z]:/.test(entry) ||
      normalized.startsWith("//") ||
      normalized.startsWith("/") ||
      parts.includes("..") ||
      parts.some((part) => /[\x00-\x1f:]/.test(part) || /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
      (target !== root && !target.startsWith(`${root}${path.sep}`))
    ) {
      throw new Error(`Archive contains an unsafe path: ${entry}`);
    }
  }
}

function listArchivePaths(output: string): string[] {
  return output.split(/\r?\n\s*\r?\n/)
    .filter((section) => !/(?:^|\r?\n)Type = /m.test(section))
    .flatMap((section) => {
      const pathLine = section.split(/\r?\n/).find((line) => line.startsWith("Path = "));
      return pathLine ? [pathLine.slice("Path = ".length)] : [];
    })
    .filter(Boolean);
}

export async function findGameRootInArchive(
  archivePath: string,
  installDirectory: string,
  maxDirectoryDepth = 3,
): Promise<string> {
  const archive = path.resolve(archivePath);
  const installRoot = path.resolve(installDirectory);
  const listing = await execFileAsync(archiveBinaryPath, ["l", "-slt", "-p-", "--", archive], {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  const executableExtensions = process.platform === "win32"
    ? [".exe"]
    : process.platform === "darwin"
      ? [".sh", ".command"]
      : [".sh", ".x86_64", ".x86", ".linux"];
  const candidates = listArchivePaths(listing.stdout)
    .map((entry) => entry.replaceAll("\\", "/").replace(/\/+$/, ""))
    .filter((entry) => executableExtensions.includes(path.posix.extname(entry).toLowerCase()))
    .map((entry) => {
      const directory = path.posix.dirname(entry);
      return {
        directory,
        depth: directory === "." ? 0 : directory.split("/").filter(Boolean).length,
      };
    })
    .filter(({ depth }) => depth > 0 && depth <= maxDirectoryDepth)
    .sort((left, right) =>
      left.depth - right.depth || left.directory.localeCompare(right.directory),
    );
  const selected = candidates[0];
  if (!selected) return installRoot;
  const gameRoot = path.resolve(installRoot, ...selected.directory.split("/"));
  if (gameRoot !== installRoot && !gameRoot.startsWith(`${installRoot}${path.sep}`)) {
    throw new Error("The game executable path is outside the installation folder.");
  }
  return gameRoot;
}

export interface ExtractionProgress {
  percent: number | null;
  detail: string | null;
}

export type ExtractionProgressListener = (progress: ExtractionProgress) => void;

export async function assertUnlinkedPath(target: string): Promise<void> {
  const resolved = path.resolve(target);
  let current = path.parse(resolved).root;
  for (const segment of path.relative(current, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("Path contains a symbolic link or junction.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function validateArchive(archivePath: string, destination: string): Promise<void> {
  const archive = path.resolve(archivePath);
  await assertUnlinkedPath(archive);
  const listing = await execFileAsync(archiveBinaryPath, ["l", "-slt", "-p-", "--", archive], {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (/^(?:Symbolic Link|Hard Link) = /m.test(listing.stdout) ||
      /^Attributes = .*\b[lL][rwx-]{9}/m.test(listing.stdout) ||
      /^Attributes = [A-Z_]*L/m.test(listing.stdout)) {
    throw new Error("Archive contains links, which are not allowed.");
  }
  const entries = listArchivePaths(listing.stdout);
  validateArchivePaths(entries, destination);
  await assertUnlinkedPath(destination);
  for (const entry of entries) {
    const target = path.resolve(destination, entry.replaceAll("\\", "/"));
    if (target === archive) throw new Error("Archive cannot overwrite itself.");
    await assertUnlinkedPath(target);
    try {
      const metadata = await lstat(target);
      if (metadata.isFile() && metadata.nlink > 1) throw new Error("Archive target is a hard link.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function testArchive(archivePath: string): Promise<void> {
  await execFileAsync(archiveBinaryPath, ["t", "-p-", "--", path.resolve(archivePath)], {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
}

export async function extractArchive(
  archivePath: string,
  destination: string,
  onProgress?: ExtractionProgressListener,
): Promise<void> {
  const archive = path.resolve(archivePath);
  const target = path.resolve(destination);
  onProgress?.({ percent: null, detail: null });
  await validateArchive(archive, target);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(archiveBinaryPath, ["x", "-y", "-p-", "-bsp1", "-bso0", "-bse2", `-o${target}`, "--", archive], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let pending = "";
    let lastPercent: number | null = null;
    let lastProgressAt = -Infinity;
    let errorOutput = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split(/[\r\n\x08]+/);
      pending = lines.pop()!.slice(-4096);
      for (const line of lines) {
        const match = line.match(/^\s*(\d{1,3})%\s*(\d+)?/);
        if (!match) continue;
        const percent = Math.max(0, Math.min(100, Number(match[1])));
        if (lastPercent !== null && percent <= lastPercent) continue;
        lastPercent = percent;
        const now = performance.now();
        // Limit queue/database updates to four per second; completion is emitted after a successful exit.
        if (percent === 100 || now - lastProgressAt < 250) continue;
        lastProgressAt = now;
        onProgress?.({ percent, detail: match[2] ? `${match[2]} entries processed` : null });
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      errorOutput = (errorOutput + chunk.toString()).slice(-8192);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`Archive extraction failed (${code}): ${errorOutput.trim()}`));
      else {
        onProgress?.({ percent: 100, detail: null });
        resolve();
      }
    });
  });
}

export function isSupportedArchive(fileName: string): boolean {
  return [".zip", ".7z", ".rar"].includes(path.extname(fileName).toLowerCase());
}
