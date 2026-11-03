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
