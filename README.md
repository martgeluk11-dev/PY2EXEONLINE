# Py2EXE Online

A browser-based Python project packager that builds **real Windows .exe files** with PyInstaller.

## Features

- Upload multiple files at once, or select an entire project folder.
- Choose the main/entry `.py` file.
- Keep project folder structure and Python modules.
- Automatically bundle non-Python assets: images, audio, video, fonts, JSON, text files, and more.
- One-file EXE or onedir ZIP output.
- Optional `.ico` app icon and console window setting.
- Drag-and-drop project upload.

## Important: Windows build host required

PyInstaller does not cross-compile Windows executables from Linux. The FastAPI backend must run on a **Windows machine/server**. GitHub stores the source code; GitHub Pages alone cannot run the EXE build backend.

## Run on Windows

1. Install Python 3.11+ and make sure `py` works in Command Prompt.
2. Clone this repository.
3. Run `start.bat`.
4. Open http://localhost:8000.

For an online public service, deploy the backend on a Windows VPS and put it behind HTTPS/reverse proxy. Do not expose an unrestricted build server to the public internet: uploaded code is untrusted and builds consume CPU/RAM. Add authentication, rate limits, per-user quotas, and isolated worker accounts before public launch.

## Project asset paths

All uploaded non-`.py` files are bundled automatically while preserving their relative folders. For example, `assets/picture.png` is included at `assets/picture.png` inside the bundle.

For runtime access in a PyInstaller one-file app, resolve bundled assets relative to `sys._MEIPASS`, not the current working directory:

```python
from pathlib import Path
import sys

def resource_path(relative_path: str) -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return base / relative_path

image_file = resource_path("assets/picture.png")
```

Use the same approach for MP3/WAV audio, MP4 video, and other bundled resources. PyInstaller packages files; it does not automatically rewrite your app's file paths or install external system codecs.

## Limits

- 150 files per project.
- 200 MB total upload; 100 MB per file.
- 5-minute build timeout.
- Python dependencies must already be installed on the build server or added to its environment. This first version does not install arbitrary uploaded requirements automatically.
