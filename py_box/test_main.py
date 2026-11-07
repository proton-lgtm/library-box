"""Focused tests for the CLI and archive handling."""

import contextlib
import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import py7zr
import rarfile

from downloader_engine import DownloaderEngine
from main import GameDownloaderCLI
from mod_manager import ModManager


class GameDownloaderCliTests(unittest.TestCase):
    def test_loads_single_game_json_object(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            games_file = Path(temporary_directory) / "games.json"
            games_file.write_text(
                '{"name": "Game 01", "download_links": {}}',
                encoding="utf-8",
            )
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

    def test_selects_workupload_link(self):
        self.assertEqual(
            GameDownloaderCLI._select_download_url(
                {"workupload": "https://workupload.com/file/example"}
            ),
            "https://workupload.com/file/example",
        )

    def test_prefers_direct_link_and_selects_gofile(self):
        self.assertEqual(
            GameDownloaderCLI._select_download_url(
                {
                    "gofile": "https://gofile.io/d/example",
                    "direct_link": "https://example.com/archive.zip",
                }
            ),
            "https://example.com/archive.zip",
        )
        self.assertEqual(
            GameDownloaderCLI._select_download_url(
                {"gofile": "https://gofile.io/d/example"}
            ),
            "https://gofile.io/d/example",
        )


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
    def test_detects_workupload_file_link(self):
        downloader = DownloaderEngine(".")

        self.assertEqual(
            downloader._detect_source("https://workupload.com/file/example"),
            "workupload",
        )
        self.assertEqual(
            downloader._get_direct_download_url(
                "https://workupload.com/file/example", "workupload"
            ),
            "https://workupload.com/file/example",
        )

    def test_detects_gofile_share_link(self):
        downloader = DownloaderEngine(".")

        self.assertEqual(
            downloader._detect_source("https://gofile.io/d/example"),
            "gofile",
        )

    def test_detects_buzzheavier_short_and_final_links(self):
        downloader = DownloaderEngine(".")

        self.assertEqual(
            downloader._detect_source("https://bzzhr.to/und5pmrgbz5r"),
            "buzzheavier",
        )
        self.assertEqual(
            downloader._detect_source("https://www.buzzheavier.com/file/example"),
            "buzzheavier",
        )

    def test_buzzheavier_uses_embedded_direct_download_url(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            downloader = DownloaderEngine(temporary_directory)
            destination = Path(temporary_directory) / "game.zip"

            with patch.object(
                downloader,
                "_get_buzzheavier_direct_url",
                return_value="https://ts.bzzhr.to/file/game.zip",
            ) as find_direct_url, patch.object(
                downloader, "_download_direct_file"
            ) as stream_file, patch.object(
                downloader, "_download_browser_host"
            ) as browser:
                downloaded = downloader.download_file(
                    "https://bzzhr.to/und5pmrgbz5r",
                    destination,
                    item_name="Game",
                )

            self.assertTrue(downloaded)
            find_direct_url.assert_called_once_with(
                "https://bzzhr.to/und5pmrgbz5r"
            )
            stream_file.assert_called_once_with(
                "https://ts.bzzhr.to/file/game.zip", destination, None, "Game"
            )
            browser.assert_not_called()

    def test_extracts_buzzheavier_direct_url_from_page_html(self):
        downloader = DownloaderEngine(".")
        response = MagicMock()
        response.text = (
            '<a href="https://ts.bzzhr.to/file/game.zip?token=one&amp;expires=two">'
        )

        with patch("downloader_engine.requests.get", return_value=response):
            direct_url = downloader._get_buzzheavier_direct_url(
                "https://bzzhr.to/und5pmrgbz5r"
            )

        self.assertEqual(
            direct_url,
            "https://ts.bzzhr.to/file/game.zip?token=one&expires=two",
        )

    def test_gofile_uses_browser_without_api(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            downloader = DownloaderEngine(temporary_directory)
            destination = Path(temporary_directory) / "game.zip"

            with patch.object(
                downloader, "_download_direct_file"
            ) as stream_file, patch.object(
                downloader, "_download_browser_host"
            ) as browser:
                downloaded = downloader.download_file(
                    "https://gofile.io/d/share-code",
                    destination,
                    item_name="Game",
                )

            self.assertTrue(downloaded)
            browser.assert_called_once_with(
                "https://gofile.io/d/share-code", destination, None, "Game"
            )
            stream_file.assert_not_called()

    def test_browser_host_download_streams_with_browser_cookies_and_progress(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            destination = root / "game.zip"
            downloader = DownloaderEngine(temporary_directory)
            progress = []
            download = MagicMock()

            class FakePage:
                context = MagicMock()
                url = "https://workupload.com/file/example"

                def __init__(self):
                    self.context.cookies.return_value = [
                        {
                            "name": "session",
                            "value": "verified",
                            "domain": ".workupload.com",
                            "path": "/",
                            "secure": True,
                        }
                    ]

                def goto(self, *_args, **_kwargs):
                    return None

                def wait_for_event(self, *_args, **_kwargs):
                    return download

                def evaluate(self, _script):
                    return "test-agent"

            class FakeBrowser:
                def new_page(self, **_kwargs):
                    return FakePage()

                def close(self):
                    return None

            class FakeChromium:
                def launch(self, **_kwargs):
                    return FakeBrowser()

            class FakePlaywright:
                chromium = FakeChromium()

                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return None

            download.url = "https://download.workupload.com/file/archive"
            download.cancel = MagicMock()
            fake_sync_playwright = MagicMock(return_value=FakePlaywright())
            error_type = type("PlaywrightError", (Exception,), {})
            timeout_type = type("PlaywrightTimeoutError", (error_type,), {})
            playwright_module = MagicMock()
            playwright_module.Error = error_type
            playwright_module.TimeoutError = timeout_type
            playwright_module.sync_playwright = fake_sync_playwright
            response = MagicMock()
            response.headers = {"content-length": "7"}
            response.iter_content.return_value = [b"archive"]
            response.__enter__.return_value = response
            response.__exit__.return_value = None
            session = MagicMock()
            session.__enter__.return_value = session
            session.__exit__.return_value = None
            session.get.return_value = response

            output = io.StringIO()
            with patch.dict("sys.modules", {"playwright.sync_api": playwright_module}), \
                    patch("downloader_engine.requests.Session", return_value=session), \
                    contextlib.redirect_stdout(output):
                downloader._download_browser_host(
                    "https://workupload.com/file/example",
                    destination,
                    lambda current, total: progress.append((current, total)),
                    "Game",
                )

            self.assertEqual(destination.read_bytes(), b"archive")
            self.assertEqual(progress, [(7, 7)])
            self.assertIn(
                "Captured direct download URL: https://download.workupload.com/file/archive",
                output.getvalue(),
            )
            download.cancel.assert_called_once()
            session.cookies.set.assert_called_once_with(
                "session",
                "verified",
                domain=".workupload.com",
                path="/",
                secure=True,
            )
            session.get.assert_called_once_with(
                "https://download.workupload.com/file/archive",
                headers={
                    "User-Agent": "test-agent",
                    "Referer": "https://workupload.com/file/example",
                },
                stream=True,
                timeout=30,
            )

    def test_applies_direct_file_mod_to_target_folder(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            mod_file = root / "unlock_gallery.rpy"
            mod_file.write_text("gallery unlocked")
            game_root = root / "installed_game"
            game_root.mkdir()
            manager = ModManager(DownloaderEngine(temporary_directory))

            applied = manager._apply_mod_steps(
                mod_file,
                game_root,
                [{"type": "move", "target_folder": "%GAME_ROOT%/game"}],
                "Gallery Unlocker",
            )

            self.assertTrue(applied)
            self.assertEqual(
                (game_root / "game" / "unlock_gallery.rpy").read_text(),
                "gallery unlocked",
            )
            self.assertEqual(mod_file.read_text(), "gallery unlocked")

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

    def test_downloads_and_extracts_7z_game_archive(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "readme.txt"
            source.write_text("installed")
            downloader = DownloaderEngine(str(root))

            def create_game_archive(_url, destination, **_kwargs):
                with py7zr.SevenZipFile(destination, "w") as archive_file:
                    archive_file.write(source, "game/readme.txt")
                return True

            with patch.object(
                downloader, "download_file", side_effect=create_game_archive
            ):
                game_root = downloader.download_and_extract_game(
                    "Example", "https://example.com/game.7z"
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

    def test_extracts_valid_7z_archive(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "readme.txt"
            source.write_text("installed")
            archive = root / "valid.7z"
            with py7zr.SevenZipFile(archive, "w") as archive_file:
                archive_file.write(source, "game/readme.txt")

            self.assertTrue(
                DownloaderEngine(str(root)).extract_zip(
                    archive, root / "extracted"
                )
            )
            self.assertEqual(
                (root / "extracted" / "game" / "readme.txt").read_text(),
                "installed",
            )

    def test_routes_rar_archive_to_rarfile(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            archive_path = root / "valid.rar"
            archive_path.touch()
            member = MagicMock()
            member.filename = "game/readme.txt"
            member.is_symlink.return_value = False
            archive = MagicMock()
            archive.__enter__.return_value = archive
            archive.infolist.return_value = [member]
            rar_file = MagicMock(return_value=archive)

            with patch("downloader_engine.rarfile.is_rarfile", return_value=True), patch(
                "downloader_engine.rarfile.RarFile", rar_file
            ):
                extracted = DownloaderEngine(str(root)).extract_zip(
                    archive_path, root / "extracted"
                )

            self.assertTrue(extracted)
            archive.extractall.assert_called_once_with(path=(root / "extracted").resolve())

    def test_rejects_unsafe_rar_member_path(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            archive_path = root / "unsafe.rar"
            archive_path.touch()
            member = MagicMock()
            member.filename = "../outside.txt"
            member.is_symlink.return_value = False
            archive = MagicMock()
            archive.__enter__.return_value = archive
            archive.infolist.return_value = [member]

            with patch("downloader_engine.rarfile.is_rarfile", return_value=True), patch(
                "downloader_engine.rarfile.RarFile", return_value=archive
            ), contextlib.redirect_stdout(io.StringIO()):
                extracted = DownloaderEngine(str(root)).extract_zip(
                    archive_path, root / "extracted"
                )

            self.assertFalse(extracted)
            archive.extractall.assert_not_called()
            self.assertFalse((root / "outside.txt").exists())

    def test_reports_missing_rar_extractor(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            archive_path = root / "valid.rar"
            archive_path.touch()
            output = io.StringIO()

            with patch("downloader_engine.rarfile.is_rarfile", return_value=True), patch(
                "downloader_engine.rarfile.RarFile",
                side_effect=rarfile.RarCannotExec("extractor missing"),
            ), contextlib.redirect_stdout(output):
                extracted = DownloaderEngine(str(root)).extract_archive(
                    archive_path, root / "extracted"
                )

            self.assertFalse(extracted)
            self.assertIn("install 7-Zip or UnRAR", output.getvalue())

    def test_applies_7z_mod_archive(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "readme.txt"
            source.write_text("installed")
            archive = root / "mod.7z"
            with py7zr.SevenZipFile(archive, "w") as archive_file:
                archive_file.write(source, "game/readme.txt")
            game_root = root / "installed_game"
            game_root.mkdir()
            manager = ModManager(DownloaderEngine(str(root)))

            applied = manager._apply_mod_steps(
                archive,
                game_root,
                [
                    {
                        "type": "move",
                        "source_folder": "game",
                        "target_folder": "%GAME_ROOT%/game",
                    }
                ],
                "7z Mod",
            )

            self.assertTrue(applied)
            self.assertEqual(
                (game_root / "game" / "readme.txt").read_text(), "installed"
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
