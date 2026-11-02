# Library Box CLI

Run the interactive installer from the repository root:

```powershell
python py_box\main.py
```

The CLI reads games from `games.json` in this folder. The file may contain one
game object or a list of game objects. If the file is missing, the CLI prompts
for an HTTPS URL, fetches and validates the JSON, and uses it for the current
run without saving it. Select a game by number, optionally enter
a download folder (Enter uses `~/Downloads/LibraryBox`), select mod numbers
separated by spaces, and answer whether to launch the installed game.

Downloads are stored in a `YYYY-MM-DD_<game name>` folder. The game archive is
extracted there, and selected mod archives are kept in its `game_mods`
subfolder after their configured `steps_to_apply` have been run. The downloader
accepts HTTPS URLs, normalizes Pixeldrain file links, and follows provider
redirects. For Workupload and GoFile links, Library Box opens a visible
Chromium browser; complete any verification and click the file's Download
button there. The browser closes after the download starts, and the installer
streams the verified file in the terminal with a progress bar. Mods may also
use a `direct_link` URL; non-ZIP file mods are copied into their configured
`target_folder`.

ZIP and 7z archives are extracted directly. RAR extraction uses `rarfile` and
requires 7-Zip or UnRAR to be installed and available on `PATH`. The same
archive support is used for game downloads, mods, and nested archives.

Install the Python dependencies and Playwright's Chromium browser once:

```powershell
python -m pip install -r py_box\requirements.txt
python -m playwright install chromium
```

Run the CLI and archive tests with:

```powershell
python -m unittest discover -s py_box -v
```

Build a single-file Windows executable (without bundling `games.json`) from
this folder after installing Playwright's Chromium browser:

```powershell
python -m pip install pyinstaller
python -m playwright install chromium
python -m PyInstaller --noconfirm --clean LibraryBox.spec
```

The executable is written to `dist\LibraryBox.exe`; `games.json` is not included.
