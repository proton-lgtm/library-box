"""Focused tests for the CLI and archive handling."""

import contextlib
import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch

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
    def test_download_file_logs_source_and_reports_progress(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            downloader = DownloaderEngine(str(root))
            response = MagicMock()
            response.headers = {"content-length": "4"}
            response.iter_content.return_value = [b"data"]
            get_response = MagicMock()
            get_response.__enter__.return_value = response
            progress = []
            output = io.StringIO()

            with patch("downloader_engine.requests.get", return_value=get_response):
                with contextlib.redirect_stdout(output):
                    downloaded = downloader.download_file(
                        "https://example.com/game.zip",
                        root / "game.zip",
                        lambda current, total: progress.append((current, total)),
                        item_name="Example Game",
                    )

            self.assertTrue(downloaded)
            self.assertEqual(progress, [(4, 4)])
            self.assertIn("Downloading Example Game from direct", output.getvalue())
            self.assertIn("100%", output.getvalue())

    def test_keeps_game_archive_after_extraction(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            downloader = DownloaderEngine(str(root))

            def create_game_archive(_url, destination, **_kwargs):
                with zipfile.ZipFile(destination, "w") as zip_file:
                    zip_file.writestr("game/readme.txt", "installed")
                return True

            with patch.object(
                downloader, "download_file", side_effect=create_game_archive
            ):
                game_root = downloader.download_and_extract_game(
                    "Example", "https://example.com/game.zip"
                )

            self.assertIsNotNone(game_root)
            self.assertTrue((downloader.game_folder / "game.zip").exists())
            self.assertEqual((game_root / "readme.txt").read_text(), "installed")

    def test_reuses_existing_game_archive_without_downloading(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            downloader = DownloaderEngine(temporary_directory)
            game_folder = downloader._create_game_folder("Example")
            with zipfile.ZipFile(game_folder / "game.zip", "w") as zip_file:
                zip_file.writestr("game/readme.txt", "installed")

            with patch.object(downloader, "download_file") as download_file:
                game_root = downloader.download_and_extract_game(
                    "Example", "https://example.com/game.zip"
                )

            download_file.assert_not_called()
            self.assertEqual(game_root, game_folder / "game")
            self.assertEqual((game_root / "readme.txt").read_text(), "installed")

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

    def test_move_step_merges_mod_directories_and_replaces_conflicting_files(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            game_root = root / "installed_game"
            game_gui = game_root / "game" / "gui"
            game_gui.mkdir(parents=True)
            (game_gui / "main_menu.png").write_text("original menu")
            (game_gui / "preferences.png").write_text("original preferences")

            mod_gui = root / "mod" / "gui"
            mod_gui.mkdir(parents=True)
            (mod_gui / "main_menu.png").write_text("mod menu")
            (mod_gui / "custom_button.png").write_text("mod button")
            manager = ModManager(DownloaderEngine(str(root)))

            applied = manager._handle_move_step(
                root / "mod",
                game_root,
                ".",
                "%GAME_ROOT%/game",
            )

            self.assertTrue(applied)
            self.assertEqual((game_gui / "main_menu.png").read_text(), "mod menu")
            self.assertEqual(
                (game_gui / "preferences.png").read_text(), "original preferences"
            )
            self.assertEqual((game_gui / "custom_button.png").read_text(), "mod button")


if __name__ == "__main__":
    unittest.main()
