"""Focused tests for the CLI and archive handling."""

import contextlib
import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from downloader_engine import DownloaderEngine
from main import GameDownloaderCLI
from mod_manager import ModManager


class GameDownloaderCliTests(unittest.TestCase):
    def test_loads_single_game_json_object(self):
        games_file = Path(__file__).with_name("games.json")
        cli = GameDownloaderCLI(games_json_path=games_file)

        cli.load_games()

        self.assertEqual(len(cli.games), 1)
        self.assertEqual(cli.games[0]["name"], "Game 01")

    def test_selects_multiple_mods_without_duplicates(self):
        mods = [{"name": "First"}, {"name": "Second"}]
        with patch("builtins.input", return_value="2 1 2"):
            selected = GameDownloaderCLI.select_mods({"mods": mods})

        self.assertEqual(selected, [mods[1], mods[0]])

    def test_empty_mod_selection_selects_none(self):
        with patch("builtins.input", return_value=""):
            selected = GameDownloaderCLI.select_mods({"mods": [{"name": "Mod"}]})

        self.assertEqual(selected, [])


class ModPathTests(unittest.TestCase):
    def test_resolves_game_root_placeholder(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            game_root = Path(temporary_directory) / "game"
            game_root.mkdir()
            manager = ModManager(DownloaderEngine(temporary_directory))

            resolved = manager._resolve_path(
                game_root, "%GAME_ROOT%/game", game_root
            )

            self.assertEqual(
                resolved.as_posix().casefold(),
                (game_root / "game").resolve().as_posix().casefold(),
            )

    def test_rejects_paths_outside_game_root(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            game_root = Path(temporary_directory) / "game"
            game_root.mkdir()
            manager = ModManager(DownloaderEngine(temporary_directory))

            with self.assertRaises(ValueError):
                manager._resolve_path(game_root, "../outside", game_root)


class ArchiveExtractionTests(unittest.TestCase):
    def test_rejects_zip_path_traversal(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            archive = root / "unsafe.zip"
            with zipfile.ZipFile(archive, "w") as zip_file:
                zip_file.writestr("../outside.txt", "not allowed")

            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                extracted = DownloaderEngine(str(root)).extract_zip(
                    archive, root / "extracted"
                )

            self.assertFalse(extracted)
            self.assertFalse((root / "outside.txt").exists())

    def test_extracts_valid_archive(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            archive = root / "valid.zip"
            with zipfile.ZipFile(archive, "w") as zip_file:
                zip_file.writestr("game/readme.txt", "installed")

            self.assertTrue(
                DownloaderEngine(str(root)).extract_zip(
                    archive, root / "extracted"
                )
            )
            self.assertEqual(
                (root / "extracted" / "game" / "readme.txt").read_text(),
                "installed",
            )

    def test_applies_configured_extract_and_move_steps(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            game_root = root / "installed_game"
            game_root.mkdir()
            archive = root / "walkthrough.zip"
            with zipfile.ZipFile(archive, "w") as zip_file:
                zip_file.writestr(
                    "DEAR-0.3-Joker WT Mod/Optional/game/walkthrough.rpy",
                    "walkthrough",
                )
            manager = ModManager(DownloaderEngine(str(root)))

            applied = manager._apply_mod_steps(
                archive,
                game_root,
                [
                    {"type": "extract", "target_folder": "."},
                    {
                        "type": "move",
                        "source_folder": "./DEAR-0.3-Joker WT Mod/Optional/game",
                        "target_folder": "%GAME_ROOT%/game",
                    },
                ],
                "Walkthrough Mod",
            )

            self.assertTrue(applied)
            self.assertEqual(
                (game_root / "game" / "walkthrough.rpy").read_text(),
                "walkthrough",
            )


if __name__ == "__main__":
    unittest.main()
