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
redirects. File-host pages that require a browser login, captcha, or other
interactive access may need a direct download URL instead.

Install the Python dependency with:

```powershell
python -m pip install -r py_box\requirements.txt
```

Run the CLI and archive tests with:

```powershell
python -m unittest discover -s py_box -v
```
