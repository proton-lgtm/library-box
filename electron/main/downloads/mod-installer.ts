import { cp, lstat, mkdir, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { extractArchive, isSupportedArchive } from "../archive";
import type { GameMod } from "../../../src/shared/types";

function resolveInside(base: string, value: string, gameRoot?: string): string {
  const expanded = value.includes("%GAME_ROOT%")
    ? gameRoot ? value.replaceAll("%GAME_ROOT%", gameRoot) : (() => {
      throw new Error("%GAME_ROOT% is only valid for a game destination.");
    })()
    : value;
  const resolved = path.resolve(base, expanded);
  const root = path.resolve(gameRoot ?? base);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Mod step path escapes its allowed folder: ${value}`);
  }
  return resolved;
}

async function findArchives(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Mod archive contains a symbolic link.");
    if (entry.isDirectory()) found.push(...await findArchives(fullPath));
    else if (entry.isFile() && isSupportedArchive(entry.name)) found.push(fullPath);
  }
  return found;
}

async function mergeMove(source: string, destination: string): Promise<void> {
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink()) throw new Error("Mod content contains a symbolic link.");
  if (sourceInfo.isDirectory()) {
    let destinationInfo;
    try {
      destinationInfo = await lstat(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (destinationInfo?.isSymbolicLink()) {
      throw new Error("Mod target contains a symbolic link.");
    }
    if (destinationInfo?.isDirectory()) {
      for (const child of await readdir(source)) {
        await mergeMove(path.join(source, child), path.join(destination, child));
      }
      await rmdir(source);
      return;
    }
  }
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  await rm(source, { recursive: true, force: true });
}

export async function applyModArchive(
  archivePath: string,
  mod: GameMod,
  gameRoot: string,
  directFile = false,
): Promise<void> {
  const safeRoot = path.resolve(gameRoot);
  const workDir = path.join(path.dirname(archivePath), `extract-${path.basename(archivePath)}-${Date.now()}`);
  await mkdir(workDir, { recursive: true });
  try {
    if (!directFile && isSupportedArchive(archivePath)) {
      await extractArchive(archivePath, workDir);
      for (const step of mod.steps_to_apply) {
        if (step.type === "extract") {
          const target = resolveInside(safeRoot, step.target_folder, safeRoot);
          await mkdir(target, { recursive: true });
          for (const nestedArchive of await findArchives(workDir)) {
            await extractArchive(nestedArchive, target);
          }
          continue;
        }
        const source = resolveInside(workDir, step.source_folder ?? "");
        const target = resolveInside(safeRoot, step.target_folder, safeRoot);
        const sourceInfo = await lstat(source).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") throw new Error(`Mod source folder was not found: ${step.source_folder ?? ""}`);
          throw error;
        });
        if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
          throw new Error(`Mod source is not a safe folder: ${step.source_folder ?? ""}`);
        }
        await mkdir(target, { recursive: true });
        for (const entry of await readdir(source)) {
          await mergeMove(path.join(source, entry), path.join(target, entry));
        }
      }
      return;
    }

    if (mod.steps_to_apply.length !== 1 || mod.steps_to_apply[0].type !== "move" ||
        mod.steps_to_apply[0].source_folder) {
      throw new Error(`Direct file mod "${mod.name}" requires one move step without a source folder.`);
    }
    const target = resolveInside(safeRoot, mod.steps_to_apply[0].target_folder, safeRoot);
    await mkdir(target, { recursive: true });
    const filename = path.basename(archivePath);
    await cp(archivePath, path.join(target, filename), { force: true });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
