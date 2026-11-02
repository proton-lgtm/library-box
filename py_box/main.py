"""Interactive command-line installer for the games in games.json."""

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import requests

if __package__:
    from .downloader_engine import DownloaderEngine
    from .mod_manager import ModManager
else:
    from downloader_engine import DownloaderEngine
    from mod_manager import ModManager


class GameDownloaderCLI:
    """Command-line interface for game downloads, mods, and launching."""

    def __init__(
        self,
        games_json_path: Optional[Path] = None,
        default_download_folder: Optional[Path] = None,
    ):
        self.games_json_path = games_json_path or Path(__file__).with_name("games.json")
        self.default_download_folder = (
            default_download_folder
            or Path.home() / "Downloads" / "LibraryBox"
        )
        self.games: List[Dict[str, Any]] = []

    def load_games(self) -> None:
        """Read game definitions locally or fetch them if the file is missing."""
        if self.games_json_path.exists():
            with self.games_json_path.open(encoding="utf-8") as file:
                data = json.load(file)
        else:
            data = self._fetch_games_json()

        self.games = self._validate_games_data(data)

    def _fetch_games_json(self) -> Any:
        """Prompt for and fetch the missing games JSON document."""
        url = input(
            f"Games file not found at {self.games_json_path}. "
            "Enter an HTTPS URL to fetch games.json: "
        ).strip()
        parsed_url = urlparse(url)
        if parsed_url.scheme.lower() != "https" or not parsed_url.netloc:
            raise ValueError("The games JSON URL must be a valid HTTPS URL.")

        response = requests.get(url, timeout=30)
        response.raise_for_status()
        data = response.json()
        self._validate_games_data(data)
        return data

    def _validate_games_data(self, data: Any) -> List[Dict[str, Any]]:
        """Validate and normalize game definitions from a JSON document."""
        games = data if isinstance(data, list) else [data]
        if not games:
            raise ValueError(f"No games are configured in {self.games_json_path}.")
        for index, game in enumerate(games, start=1):
            if not isinstance(game, dict) or not isinstance(game.get("name"), str):
                raise ValueError(f"Game entry {index} must have a string name.")
            if not isinstance(game.get("download_links"), dict):
                raise ValueError(f"Game '{game['name']}' has no download_links object.")
            if not isinstance(game.get("mods", []), list):
                raise ValueError(f"Game '{game['name']}' must have a mods list.")
        return games

    def select_game(self) -> Optional[Dict[str, Any]]:
        print("Available games:")
        for index, game in enumerate(self.games, start=1):
            print(f"  {index}. {game['name']}")

        while True:
            answer = input("Select a game number (or q to quit): ").strip()
            if answer.lower() == "q":
                return None
            try:
                selection = int(answer)
            except ValueError:
                print("Enter a number from the list, or q to quit.")
                continue
            if 1 <= selection <= len(self.games):
                return self.games[selection - 1]
            print(f"Enter a number from 1 to {len(self.games)}.")

    def select_download_folder(self) -> Path:
        answer = input(
            f"Download folder (press Enter for {self.default_download_folder}): "
        ).strip()
        return Path(answer).expanduser() if answer else self.default_download_folder

    @staticmethod
    def select_mods(game: Dict[str, Any]) -> List[Dict[str, Any]]:
        mods = game.get("mods", [])
        if not mods:
            print("No mods are available for this game.")
            return []

        print("\nAvailable mods:")
        for index, mod in enumerate(mods, start=1):
            print(f"  {index}. {mod.get('name', 'Unknown Mod')}")
        while True:
            answer = input(
                "Select mod numbers separated by spaces, or press Enter for none: "
            ).strip()
            if not answer:
                return []

            try:
                selections = [int(value) for value in answer.split()]
            except ValueError:
                print("Enter valid mod numbers separated by spaces.")
                continue
            if any(number < 1 or number > len(mods) for number in selections):
                print(f"Choose mod numbers from 1 to {len(mods)}.")
                continue
            return [mods[number - 1] for number in dict.fromkeys(selections)]

    @staticmethod
    def confirm_run_game() -> bool:
        while True:
            answer = input("Run the game after installing? (y/n): ").strip().lower()
            if answer in {"y", "yes"}:
                return True
            if answer in {"n", "no"}:
                return False
            print("Enter y or n.")

    @staticmethod
    def _select_download_url(links: Dict[str, Any]) -> Optional[str]:
        for source in (
            "direct_link",
            "pixeldrain",
            "gofile",
            "workupload",
            "patreon",
            "mixdrop",
            "direct",
        ):
            url = links.get(source)
            if isinstance(url, str) and url.strip():
                return url.strip()
        return None

    @staticmethod
    def run_game(game_root: Path) -> bool:
        if os.name == "nt":
            launchers = sorted(game_root.rglob("*.exe"))
        elif sys.platform == "darwin":
            launchers = sorted(path for path in game_root.rglob("*.app") if path.is_dir())
        else:
            launchers = sorted(game_root.rglob("*.sh"))
            if not launchers:
                launchers = sorted(game_root.rglob("*.x86_64"))
        if not launchers:
            print(f"No supported game launcher was found under {game_root}.")
            return False

        launcher = next(
            (path for path in launchers if path.stem.casefold() in game_root.name.casefold()),
            launchers[0],
        )
        try:
            if os.name == "nt":
                os.startfile(str(launcher))  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.Popen(["open", str(launcher)], cwd=str(launcher.parent))
            elif launcher.suffix.lower() == ".sh":
                subprocess.Popen(["/bin/sh", str(launcher)], cwd=str(launcher.parent))
            else:
                subprocess.Popen([str(launcher)], cwd=str(launcher.parent))
        except OSError as error:
            print(f"Could not start {launcher}: {error}")
            return False
        print(f"Started {launcher.name}.")
        return True

    def run(self) -> int:
        try:
            self.load_games()
        except (
            OSError,
            requests.RequestException,
            json.JSONDecodeError,
            ValueError,
        ) as error:
            print(f"Could not load games: {error}", file=sys.stderr)
            return 1

        game = self.select_game()
        if game is None:
            print("Goodbye!")
            return 0

        download_folder = self.select_download_folder()
        selected_mods = self.select_mods(game)
        run_after_install = self.confirm_run_game()
        download_url = self._select_download_url(game["download_links"])
        if not download_url:
            print(
                f"No supported download link is configured for {game['name']}.",
                file=sys.stderr,
            )
            return 1

        try:
            downloader = DownloaderEngine(str(download_folder))
            game_root = downloader.download_and_extract_game(game["name"], download_url)
            if game_root is None:
                return 1

            if selected_mods:
                if downloader.game_folder is None:
                    raise RuntimeError("The download folder was not initialized.")
                game_mods_folder = downloader.game_folder / "game_mods"
                if not ModManager(downloader).apply_mods(
                    game_root, selected_mods, game_mods_folder
                ):
                    print(
                        "One or more selected mods could not be applied.",
                        file=sys.stderr,
                    )
                    return 1

            print(f"Installed {game['name']} to {game_root}.")
            if run_after_install and not self.run_game(game_root):
                return 1
            return 0
        except (OSError, ValueError, RuntimeError) as error:
            print(f"Installation failed: {error}", file=sys.stderr)
            return 1


def main() -> int:
    return GameDownloaderCLI().run()


if __name__ == "__main__":
    raise SystemExit(main())
