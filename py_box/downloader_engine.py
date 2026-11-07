"""Downloader engine for handling game/mod downloads from various sources."""

import re
import stat
import zipfile
import requests
from datetime import datetime
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Callable, Optional
from urllib.parse import urlparse

import py7zr
import rarfile


SUPPORTED_ARCHIVE_SUFFIXES = frozenset({".zip", ".7z", ".rar"})


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
        elif domain == 'gofile.io' or domain.endswith('.gofile.io'):
            return 'gofile'
        elif domain == 'bzzhr.to' or domain.endswith('.bzzhr.to'):
            return 'buzzheavier'
        elif domain == 'buzzheavier.com' or domain.endswith('.buzzheavier.com'):
            return 'buzzheavier'
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

    def _get_buzzheavier_direct_url(self, url: str) -> str:
        """Find the ts.bzzhr.to download URL embedded in a Buzzheavier page."""
        if urlparse(url).hostname == "ts.bzzhr.to":
            return url
        response = requests.get(
            url,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36"
                )
            },
            timeout=30,
        )
        response.raise_for_status()
        html = (
            response.text
            .replace("&amp;", "&")
            .replace("\\u0026", "&")
            .replace("\\/", "/")
        )
        match = re.search(
            r"https://ts\.bzzhr\.to/[^\"'<>\s\\]+",
            html,
            flags=re.IGNORECASE,
        )
        if not match:
            raise ValueError(
                "Could not find a Buzzheavier direct download link on the page."
            )
        direct_url = match.group(0).rstrip("),;")
        parsed = urlparse(direct_url)
        if parsed.scheme != "https" or parsed.hostname != "ts.bzzhr.to":
            raise ValueError("Buzzheavier returned an unexpected download host.")
        return direct_url

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
        elif source == 'buzzheavier':
            return self._get_buzzheavier_direct_url(url)
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

    def _download_browser_host(
        self,
        url: str,
        destination: Path,
        progress_callback: Optional[Callable[[int, int], None]],
        item_name: Optional[str],
    ) -> None:
        """Use a browser for manual verification, then stream its file URL in Python."""
        try:
            from playwright.sync_api import (
                Error as PlaywrightError,
                TimeoutError as PlaywrightTimeoutError,
                sync_playwright,
            )
        except ImportError as error:
            raise ValueError(
                "Browser-assisted downloads require Playwright. Install dependencies with "
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
                        "Complete the file host's verification in the browser, then "
                        "click its Download button. The installer will continue "
                        "the transfer in the terminal."
                    )
                    download = page.wait_for_event("download", timeout=600_000)
                    download_url = download.url
                    if urlparse(download_url).scheme.lower() not in {"http", "https"}:
                        raise ValueError(
                            "The browser started a download that does not have an "
                            "HTTP(S) URL, so it cannot be streamed by the installer."
                        )
                    print(f"Captured direct download URL: {download_url}")
                    cookies = page.context.cookies([download_url])
                    user_agent = page.evaluate("navigator.userAgent")
                    referer = page.url
                    download.cancel()
                finally:
                    browser.close()
        except PlaywrightTimeoutError as error:
            raise ValueError(
                "Timed out waiting for a browser download. Complete verification "
                "and click the file's Download button in the opened browser."
            ) from error
        except PlaywrightError as error:
            raise ValueError(
                "Could not capture the browser download. Ensure "
                "Playwright Chromium is installed with "
                "'python -m playwright install chromium'. "
                f"Details: {error}"
            ) from error

        with requests.Session() as session:
            for cookie in cookies:
                session.cookies.set(
                    cookie["name"],
                    cookie["value"],
                    domain=cookie.get("domain"),
                    path=cookie.get("path", "/"),
                    secure=cookie.get("secure", False),
                )

            headers = {
                "User-Agent": user_agent,
                "Referer": referer,
            }
            with session.get(
                download_url, headers=headers, stream=True, timeout=30
            ) as response:
                response.raise_for_status()
                content_type = response.headers.get("content-type", "").lower()
                if "text/html" in content_type or "application/json" in content_type:
                    raise ValueError(
                        "The verified browser download URL returned a web page "
                        "instead of a file. Try the Download button again."
                    )

                total_size = int(response.headers.get("content-length", 0))
                downloaded = 0
                with destination.open("wb") as file:
                    for chunk in response.iter_content(chunk_size=8192):
                        if chunk:
                            file.write(chunk)
                            downloaded += len(chunk)
                            self._print_progress(downloaded, total_size)
                            if progress_callback:
                                progress_callback(downloaded, total_size)

        if downloaded:
            print()
        print(f"Downloaded {item_name or destination.name} to {destination}.")

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

            if source == "gofile":
                self._download_browser_host(
                    url, destination, progress_callback, item_name
                )
                return True

            if source == "workupload":
                self._download_browser_host(
                    direct_url, destination, progress_callback, item_name
                )
                return True

            self._download_direct_file(
                direct_url, destination, progress_callback, item_name
            )
            return True
        except (requests.RequestException, OSError, ValueError) as e:
            print(f"Download failed: {e}")
            if destination.exists():
                destination.unlink()
            return False

    def _download_direct_file(
        self,
        url: str,
        destination: Path,
        progress_callback: Optional[Callable[[int, int], None]],
        item_name: Optional[str],
    ) -> None:
        """Stream a direct file URL to disk and report download progress."""
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }

        with requests.get(
            url, headers=headers, stream=True, timeout=30
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

    @staticmethod
    def _validate_archive_members(
        members: list[tuple[str, bool]], extract_to: Path
    ) -> Path:
        """Reject archive paths and links that could escape the extraction folder."""
        root = extract_to.resolve()
        for filename, is_symlink in members:
            member_path = PurePosixPath(filename.replace("\\", "/"))
            windows_path = PureWindowsPath(filename)
            if (
                member_path.is_absolute()
                or windows_path.is_absolute()
                or windows_path.drive
                or ".." in member_path.parts
                or is_symlink
            ):
                raise ValueError(f"Archive contains an unsafe path: {filename}")

            target = root.joinpath(*member_path.parts).resolve()
            if target != root and root not in target.parents:
                raise ValueError(f"Archive contains an unsafe path: {filename}")
        return root

    @staticmethod
    def is_supported_archive(archive_path: Path) -> bool:
        """Return whether a file has a supported ZIP, 7z, or RAR archive signature."""
        if not archive_path.is_file():
            return False
        return (
            zipfile.is_zipfile(archive_path)
            or py7zr.is_7zfile(archive_path)
            or rarfile.is_rarfile(archive_path)
        )

    def extract_archive(self, archive_path: Path, extract_to: Path) -> bool:
        """Extract a ZIP, 7z, or RAR archive to the destination folder."""
        try:
            extract_to.mkdir(parents=True, exist_ok=True)
            root = extract_to.resolve()
            if zipfile.is_zipfile(archive_path):
                with zipfile.ZipFile(archive_path, "r") as archive:
                    members = [
                        (
                            member.filename,
                            stat.S_ISLNK(member.external_attr >> 16),
                        )
                        for member in archive.infolist()
                    ]
                    self._validate_archive_members(members, root)
                    archive.extractall(root)
            elif py7zr.is_7zfile(archive_path):
                with py7zr.SevenZipFile(archive_path, "r") as archive:
                    members = [
                        (member.filename, member.is_symlink)
                        for member in archive.list()
                    ]
                    self._validate_archive_members(members, root)
                    archive.extractall(path=root)
            elif rarfile.is_rarfile(archive_path):
                with rarfile.RarFile(archive_path, "r") as archive:
                    members = [
                        (member.filename, member.is_symlink())
                        for member in archive.infolist()
                    ]
                    self._validate_archive_members(members, root)
                    archive.extractall(path=root)
            else:
                raise ValueError("File is not a supported ZIP, 7z, or RAR archive.")
            return True
        except rarfile.RarCannotExec as error:
            print(
                "RAR extraction failed: install 7-Zip or UnRAR and ensure "
                f"it is available on PATH. Details: {error}"
            )
            return False
        except (
            OSError,
            ValueError,
            zipfile.BadZipFile,
            py7zr.exceptions.ArchiveError,
            rarfile.Error,
        ) as e:
            print(f"Extraction failed: {e}")
            return False

    def extract_zip(self, zip_path: Path, extract_to: Path) -> bool:
        """Compatibility wrapper for callers using the original ZIP extractor."""
        return self.extract_archive(zip_path, extract_to)

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
        if not self.extract_archive(zip_path, game_folder):
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
