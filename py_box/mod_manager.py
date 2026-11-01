"""Mod manager for applying game mods."""

import shutil
from pathlib import Path
from typing import List, Dict, Any, Optional

if __package__:
    from .downloader_engine import DownloaderEngine
else:
    from downloader_engine import DownloaderEngine


class ModManager:
    """Manages downloading and applying game mods."""

    def __init__(self, downloader: DownloaderEngine):
        self.downloader = downloader

    def apply_mods(self, game_root: Path, mods: List[Dict[str, Any]], game_mods_folder: Path) -> bool:
        """Download and apply selected mods to the game."""
        all_succeeded = True
        for mod in mods:
            mod_name = mod.get('name', 'Unknown Mod')
            download_links = mod.get('download_links', {})
            steps = mod.get('steps_to_apply', [])

            # Prefer direct file links over file-host share pages.
            download_url = None
            for source in ['pixeldrain', 'workupload', 'patreon', 'mixdrop', 'direct']:
                if source in download_links:
                    download_url = download_links[source]
                    break

            if not download_url:
                print(f"No download link found for mod: {mod_name}")
                all_succeeded = False
                continue

            # Download mod to game_mods folder
            mod_archive = self.downloader.download_mod(mod_name, download_url, game_mods_folder)
            if not mod_archive:
                print(f"Failed to download mod: {mod_name}")
                all_succeeded = False
                continue

            # Apply mod steps
            print(f"Applying mod: {mod_name} to {game_root}...")
            if not self._apply_mod_steps(mod_archive, game_root, steps, mod_name):
                print(f"Failed to apply mod: {mod_name}")
                all_succeeded = False
                continue

            print(f"Successfully applied mod: {mod_name}")

        return all_succeeded

    def _apply_mod_steps(self, mod_archive: Path, game_root: Path, steps: List[Dict[str, Any]], mod_name: str) -> bool:
        """Apply mod installation steps."""
        # Create a temporary extraction folder
        temp_extract = mod_archive.parent / f"temp_{mod_archive.stem}"
        temp_extract.mkdir(parents=True, exist_ok=True)

        try:
            # First, extract the mod archive
            print(f"  Extracting mod archive: {mod_archive.name}")
            if not self.downloader.extract_zip(mod_archive, temp_extract):
                return False

            # Apply each step
            for index, step in enumerate(steps, start=1):
                step_type = step.get('type')
                print(f"  Applying step {index}/{len(steps)}: {step_type}")
                if step_type == 'extract':
                    # Additional extraction if needed (e.g., nested archives)
                    target = step.get('target_folder', '.')
                    if not self._handle_extract_step(temp_extract, game_root, target):
                        return False
                elif step_type == 'move':
                    source = step.get('source_folder', '')
                    target = step.get('target_folder', '')
                    if not self._handle_move_step(temp_extract, game_root, source, target):
                        return False
                else:
                    print(f"Unknown step type: {step_type}")
                    return False

            return True
        finally:
            # Clean up temp folder
            if temp_extract.exists():
                shutil.rmtree(temp_extract)

    def _handle_extract_step(self, mod_root: Path, game_root: Path, target_folder: str) -> bool:
        """Handle extract step - extract nested archives."""
        target_path = self._resolve_path(game_root, target_folder, game_root)
        target_path.mkdir(parents=True, exist_ok=True)

        # Look for nested archives in mod_root
        for archive in mod_root.rglob('*.zip'):
            print(f"  Extracting nested archive: {archive.name}")
            if not self.downloader.extract_zip(archive, target_path):
                return False
        return True

    def _handle_move_step(self, mod_root: Path, game_root: Path, source_folder: str, target_folder: str) -> bool:
        """Handle move step - move files from mod to game."""
        source_path = self._resolve_path(mod_root, source_folder)
        target_path = self._resolve_path(game_root, target_folder, game_root)

        if not source_path.exists():
            print(f"  Source not found: {source_path}")
            return False
        if not source_path.is_dir():
            print(f"  Source is not a folder: {source_path}")
            return False

        target_path.mkdir(parents=True, exist_ok=True)

        # Move all contents from source to target
        for item in source_path.iterdir():
            dest = target_path / item.name
            self._move_item_merged(item, dest)
            print(f"  Moved: {item.name} -> {target_folder}")
        return True

    def _move_item_merged(self, source: Path, destination: Path) -> None:
        """Merge directories and replace conflicting files while moving mod content."""
        if source.is_dir() and destination.is_dir():
            for item in source.iterdir():
                self._move_item_merged(item, destination / item.name)
            source.rmdir()
            return

        if destination.exists():
            if destination.is_dir():
                shutil.rmtree(destination)
            else:
                destination.unlink()
        shutil.move(str(source), str(destination))

    def _resolve_path(self, base: Path, path_str: str, game_root: Optional[Path] = None) -> Path:
        """Resolve path with placeholders."""
        if '%GAME_ROOT%' in path_str:
            if game_root is None:
                raise ValueError("%GAME_ROOT% is only valid for a game destination.")
            path_str = path_str.replace('%GAME_ROOT%', str(game_root))

        candidate = Path(path_str)
        if not candidate.is_absolute():
            candidate = base / candidate
        candidate = candidate.resolve()
        allowed_root = (game_root or base).resolve()
        if candidate != allowed_root and allowed_root not in candidate.parents:
            raise ValueError(f"Mod step path escapes its allowed folder: {path_str}")
        return candidate