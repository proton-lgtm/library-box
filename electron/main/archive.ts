import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { path7za } from "7zip-bin";

const execFileAsync = promisify(execFile);

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
      parts.includes("..") ||
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
  const listing = await execFileAsync(path7za, ["l", "-slt", archive], {
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

export async function extractArchive(
  archivePath: string,
  destination: string,
): Promise<void> {
  const archive = path.resolve(archivePath);
  const target = path.resolve(destination);
  const listing = await execFileAsync(path7za, ["l", "-slt", archive], {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (/^(?:Symbolic Link|Hard Link) = /m.test(listing.stdout)) {
    throw new Error("Archive contains links, which are not allowed.");
  }
  validateArchivePaths(listArchivePaths(listing.stdout), target);
  await execFileAsync(path7za, ["x", "-y", `-o${target}`, archive], {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
}

export function isSupportedArchive(fileName: string): boolean {
  return [".zip", ".7z", ".rar"].includes(path.extname(fileName).toLowerCase());
}
