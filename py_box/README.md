# Library Box CLI

Run the interactive installer from the repository root:

```powershell
python py_box\main.py
```

The CLI reads games from `games.json` in this folder. The file may contain one
game object or a list of game objects. Select a game by number, optionally enter
a download folder (Enter uses `~/Downloads/LibraryBox`), select mod numbers
separated by spaces, and answer whether to launch the installed game.

Downloads are stored in a `YYYY-MM-DD_<game name>` folder. The game archive is
extracted there, and selected mod archives are kept in its `game_mods`
subfolder after their configured `steps_to_apply` have been run. The downloader
accepts HTTPS URLs, normalizes Pixeldrain file links, and follows provider
redirects. For Workupload links, Library Box opens a visible Chromium browser;
complete any verification and click the file's Download button there. The
installer saves that browser-session download and then continues automatically.
Install the Python dependencies and Playwright's Chromium browser once:

```powershell
python -m pip install -r py_box\requirements.txt
python -m playwright install chromium
```

Run the CLI and archive tests with:

```powershell
python -m unittest discover -s py_box -v
```
