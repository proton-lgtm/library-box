"""Downloader engine for handling game/mod downloads from various sources."""

import re
import zipfile
import requests
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urlparse


class DownloaderEngine:
    """Handles downloading and extracting game/mod archives."""

    def __init__(self, base_download_folder: str):
        self.base_download_folder = Path(base_download_folder)
        self.base_download_folder.mkdir(parents=True, exist_ok=True)
        self.game_folder: Optional[Path] = None

    def _get_date_prefix(self) -> str:
        """Get current date as prefix (YYYY-MM-DD)."""
        return datetime.now().strftime("%Y-%m-%d")

    def _sanitize_folder_name(self, name: str) -> str:
        """Sanitize folder name for filesystem."""
        return re.sub(r'[<>:"/\\|?*]', '_', name)

    def _create_game_folder(self, game_name: str) -> Path:
        """Create date-prefixed game folder."""
        date_prefix = self._get_date_prefix()
        safe_name = self._sanitize_folder_name(game_name)
        folder_name = f"{date_prefix}_{safe_name}"
        game_folder = self.base_download_folder / folder_name
        game_folder.mkdir(parents=True, exist_ok=True)
        return game_folder

    def _detect_source(self, url: str) -> str:
        """Detect download source from URL."""
        parsed = urlparse(url)
        if parsed.scheme.lower() != 'https':
            raise ValueError("Only HTTPS download URLs are supported.")
        domain = (parsed.hostname or '').lower()
        if domain == 'pixeldrain.com' or domain.endswith('.pixeldrain.com'):
            return 'pixeldrain'
        elif domain.startswith('mixdrop.') or '.mixdrop.' in domain:
            return 'mixdrop'
        elif domain == 'patreon.com' or domain.endswith('.patreon.com'):
            return 'patreon'
        elif domain == 'patreonusercontent.com' or domain.endswith('.patreonusercontent.com'):
            return 'patreon'
        elif domain == 'workupload.com' or domain.endswith('.workupload.com'):
            return 'workupload'
        return 'direct'

    def _get_pixeldrain_direct_url(self, url: str) -> str:
        """Convert pixeldrain URL to direct download URL."""
        # Extract file ID from various pixeldrain URL formats
        patterns = [
            r'pixeldrain\.com/u/([a-zA-Z0-9]+)',
            r'pixeldrain\.com/api/file/([a-zA-Z0-9]+)',
        ]
        for pattern in patterns:
            match = re.search(pattern, url)
            if match:
                file_id = match.group(1)
                return f"https://pixeldrain.com/api/file/{file_id}"
        return url

    def _get_mixdrop_direct_url(self, url: str) -> str:
        """Pass through a direct MixDrop URL without automating its share page."""
        return url

    def _get_patreon_direct_url(self, url: str) -> str:
        """Patreon links typically require authentication."""
        # Patreon links need session cookies - return as-is
        return url

    def _get_workupload_direct_url(self, url: str) -> str:
        """Pass through Workupload links; redirects to file downloads are followed by requests."""
        return url

    def _get_direct_download_url(self, url: str, source: str) -> str:
        """Get direct download URL based on source."""
        if source == 'pixeldrain':
            return self._get_pixeldrain_direct_url(url)
        elif source == 'mixdrop':
            return self._get_mixdrop_direct_url(url)
        elif source == 'patreon':
            return self._get_patreon_direct_url(url)
        elif source == 'workupload':
            return self._get_workupload_direct_url(url)
        return url

    @staticmethod
    def _format_size(size: int) -> str:
        """Format a byte count for download progress output."""
        value = float(size)
        for unit in ("B", "KB", "MB", "GB", "TB"):
            if value < 1024 or unit == "TB":
                return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
            value /= 1024
        return f"{value:.1f} TB"

    @classmethod
    def _print_progress(cls, downloaded: int, total_size: int) -> None:
        if total_size > 0:
            percent = min(100, int(downloaded * 100 / total_size))
            bar_width = 30
            filled = int(bar_width * percent / 100)
            bar = "#" * filled + "-" * (bar_width - filled)
            print(
                f"\r  [{bar}] {percent:3d}% "
                f"({cls._format_size(downloaded)} / {cls._format_size(total_size)})",
                end="",
                flush=True,
            )
        else:
            print(
                f"\r  Downloaded {cls._format_size(downloaded)} (total size unknown)",
                end="",
                flush=True,
            )

    def _download_workupload(
        self,
        url: str,
        destination: Path,
        progress_callback: Optional[Callable[[int, int], None]],
        item_name: Optional[str],
    ) -> None:
        """Wait for a user-initiated Workupload download in a visible browser."""
        try:
            from playwright.sync_api import (
                Error as PlaywrightError,
                TimeoutError as PlaywrightTimeoutError,
                sync_playwright,
            )
        except ImportError as error:
            raise ValueError(
                "Workupload downloads require Playwright. Install dependencies with "
                "'python -m pip install -r py_box\\requirements.txt', then run "
                "'python -m playwright install chromium'."
            ) from error

        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=False)
                try:
                    page = browser.new_page(accept_downloads=True)
                    page.goto(url, wait_until="domcontentloaded", timeout=60_000)
                    print(
                        "Complete Workupload's verification in the browser, then "
                        "click its Download button. The installer will continue "
                        "when the download starts."
                    )
                    download = page.wait_for_event("download", timeout=600_000)
                    download.save_as(str(destination))
                finally:
                    browser.close()
        except PlaywrightTimeoutError as error:
            raise ValueError(
                "Timed out waiting for a Workupload download. Complete verification "
                "and click the file's Download button in the opened browser."
            ) from error
        except PlaywrightError as error:
            raise ValueError(
                "Could not complete the Workupload browser download. Ensure "
                "Playwright Chromium is installed with "
                "'python -m playwright install chromium'. "
                f"Details: {error}"
            ) from error

        size = destination.stat().st_size
        print(f"Downloaded {item_name or destination.name} to {destination}.")
        if progress_callback:
            progress_callback(size, size)

    def download_file(
        self,
        url: str,
        destination: Path,
        progress_callback: Optional[Callable[[int, int], None]] = None,
        item_name: Optional[str] = None,
    ) -> bool:
        """Download a file from URL to destination."""
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            source = self._detect_source(url)
            direct_url = self._get_direct_download_url(url, source)
            print(f"Downloading {item_name or destination.name} from {source}...")

            if source == "workupload":
                self._download_workupload(
                    direct_url, destination, progress_callback, item_name
                )
                return True

            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }

            with requests.get(
                direct_url, headers=headers, stream=True, timeout=30
            ) as response:
                response.raise_for_status()
                content_type = response.headers.get('content-type', '').lower()
                if 'text/html' in content_type or 'application/json' in content_type:
                    raise ValueError(
                        "The URL returned a web page instead of a file. "
                        "Use a direct download URL; interactive host pages are not supported."
                    )

                total_size = int(response.headers.get('content-length', 0))
                downloaded = 0
                progress_reported = False
                with destination.open('wb') as file:
                    for chunk in response.iter_content(chunk_size=8192):
                        if chunk:
                            file.write(chunk)
                            downloaded += len(chunk)
                            self._print_progress(downloaded, total_size)
                            progress_reported = True
                            if progress_callback:
                                progress_callback(downloaded, total_size)

                if progress_reported:
                    print()
                print(f"Downloaded {item_name or destination.name} to {destination}.")
            return True
        except (requests.RequestException, OSError, ValueError) as e:
            print(f"Download failed: {e}")
            if destination.exists():
                destination.unlink()
            return False

    def extract_zip(self, zip_path: Path, extract_to: Path) -> bool:
        """Extract zip file to destination folder."""
        try:
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                root = extract_to.resolve()
                for member in zip_ref.infolist():
                    target = (root / member.filename).resolve()
                    if target != root and root not in target.parents:
                        raise ValueError(
                            f"Archive contains an unsafe path: {member.filename}"
                        )
                zip_ref.extractall(root)
            return True
        except (OSError, ValueError, zipfile.BadZipFile) as e:
            print(f"Extraction failed: {e}")
            return False

    def download_and_extract_game(self, game_name: str, download_url: str) -> Optional[Path]:
        """Download and extract a game. Returns game root folder path."""
        game_folder = self._create_game_folder(game_name)
        self.game_folder = game_folder
        zip_path = game_folder / "game.zip"

        if zip_path.exists():
            print(f"Game archive already exists at {zip_path}; skipping download.")
        elif not self.download_file(download_url, zip_path, item_name=game_name):
            return None

        print(f"Extracting {game_name} from {zip_path}...")
        if not self.extract_zip(zip_path, game_folder):
            return None

        print(f"Keeping game archive at {zip_path}.")

        # Find the actual game folder (might be nested).
        extracted_items = [item for item in game_folder.iterdir() if item != zip_path]
        if len(extracted_items) == 1 and extracted_items[0].is_dir():
            return extracted_items[0]
        return game_folder

    def download_mod(self, mod_name: str, download_url: str, game_mods_folder: Path) -> Optional[Path]:
        """Download a mod to the game_mods folder (not extracted)."""
        game_mods_folder.mkdir(parents=True, exist_ok=True)
        safe_name = self._sanitize_folder_name(mod_name)
        # Try to get extension from URL
        parsed = urlparse(download_url)
        ext = Path(parsed.path).suffix or '.zip'
        mod_path = game_mods_folder / f"{safe_name}{ext}"

        if not self.download_file(download_url, mod_path, item_name=mod_name):
            return None

        return mod_path
