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

async function rejectLinkedTargetPath(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("Mod target path contains a symbolic link.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
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
    if (!directFile) {
      await extractArchive(archivePath, workDir);
      for (const step of mod.steps_to_apply) {
        if (step.type === "extract") {
          if (!step.target_folder) throw new Error("Extract steps require target_folder.");
          const target = resolveInside(safeRoot, step.target_folder, safeRoot);
          await rejectLinkedTargetPath(safeRoot, target);
          await mkdir(target, { recursive: true });
          for (const nestedArchive of await findArchives(workDir)) {
            await extractArchive(nestedArchive, target);
          }
          continue;
        }
        if (!step.target_folder || step.target_path) {
          throw new Error("Archive move steps require target_folder.");
        }
        const source = resolveInside(workDir, step.source_folder ?? "");
        const target = resolveInside(safeRoot, step.target_folder, safeRoot);
        await rejectLinkedTargetPath(safeRoot, target);
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

    const step = mod.steps_to_apply[0];
    if (mod.steps_to_apply.length !== 1 || step?.type !== "move" || step.source_folder ||
        Boolean(step.target_folder) === Boolean(step.target_path)) {
      throw new Error(
        `Direct file mod "${mod.name}" requires one move step with target_folder or target_path.`,
      );
    }
    if (step.target_path) {
      const target = resolveInside(safeRoot, step.target_path, safeRoot);
      await rejectLinkedTargetPath(safeRoot, target);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(archivePath, target, { force: true });
    } else {
      const target = resolveInside(safeRoot, step.target_folder!, safeRoot);
      const destination = path.join(target, path.basename(archivePath));
      await rejectLinkedTargetPath(safeRoot, destination);
      await mkdir(target, { recursive: true });
      await cp(archivePath, destination, { force: true });
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
