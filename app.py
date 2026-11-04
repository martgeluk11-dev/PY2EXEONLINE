import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path, PurePosixPath
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
MAX_FILES = 150
MAX_TOTAL_BYTES = 200 * 1024 * 1024
MAX_SINGLE_BYTES = 100 * 1024 * 1024
BUILD_TIMEOUT = 300

app = FastAPI(title="Py2EXE Online")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/", response_class=HTMLResponse)
async def index():
    return (STATIC / "index.html").read_text(encoding="utf-8")


def clean_name(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9_-]+", "_", value.strip()).strip("_-")
    return (value or "my_app")[:48]


def safe_relative_path(raw: str) -> Path:
    # Browser uploads may use either slash style. Reject traversal and absolute paths.
    normalized = raw.replace("\\", "/")
    candidate = PurePosixPath(normalized)
    if candidate.is_absolute() or not candidate.parts:
        raise HTTPException(400, f"Invalid project path: {raw}")
    if any(part in ("", ".", "..") for part in candidate.parts):
        raise HTTPException(400, f"Unsafe project path: {raw}")
    if ":" in candidate.parts[0]:
        raise HTTPException(400, f"Invalid project path: {raw}")
    return Path(*candidate.parts)


def build_project(project_dir: Path, entry_path: Path, app_name: str,
                  build_type: str, console: bool, icon_path: Path | None):
    if os.name != "nt":
        raise RuntimeError(
            "Windows EXE builds require a Windows build server. "
            "Run this backend on Windows; PyInstaller cannot cross-compile Windows EXEs from Linux."
        )

    output_dir = project_dir / "dist"
    work_dir = project_dir / "build"
    spec_dir = project_dir / "spec"
    command = [
        "pyinstaller", "--noconfirm", "--clean",
        "--name", app_name,
        "--distpath", str(output_dir),
        "--workpath", str(work_dir),
        "--specpath", str(spec_dir),
        "--paths", str(project_dir),
        "--onefile" if build_type == "onefile" else "--onedir",
    ]
    if not console:
        command.append("--windowed")
    if icon_path:
        command.extend(["--icon", str(icon_path)])

    # Bundle every non-Python project file (images, audio, video, fonts, data, etc.)
    # while keeping its relative path inside the packaged application.
    for asset in project_dir.rglob("*"):
        if not asset.is_file():
            continue
        if any(part in {"dist", "build", "spec", "__pycache__"} for part in asset.relative_to(project_dir).parts):
            continue
        if asset.suffix.lower() in {".py", ".pyc", ".spec", ".ico"}:
            continue
        relative = asset.relative_to(project_dir)
        command.extend(["--add-data", f"{asset};{relative.parent.as_posix()}"])

    command.append(str(project_dir / entry_path))
    result = subprocess.run(
        command, cwd=project_dir, capture_output=True, text=True,
        timeout=BUILD_TIMEOUT, check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode:
        details = (result.stdout + "\n" + result.stderr)[-7000:]
        raise ValueError(details or "PyInstaller failed.")

    if build_type == "onefile":
        exe = output_dir / f"{app_name}.exe"
        if not exe.is_file():
            raise RuntimeError("Build completed but the EXE was not found.")
        return exe

    folder = output_dir / app_name
    if not folder.is_dir():
        raise RuntimeError("Build completed but the output folder was not found.")
    archive = project_dir / f"{app_name}-windows-build.zip"
    shutil.make_archive(str(archive.with_suffix("")), "zip", output_dir, app_name)
    return archive


@app.post("/api/convert")
async def convert(
    files: Annotated[list[UploadFile], File(...)],
    paths: Annotated[list[str], Form(...)],
    entry_file: Annotated[str, Form(...)],
    app_name: Annotated[str, Form()] = "my_app",
    build_type: Annotated[str, Form()] = "onefile",
    console: Annotated[str, Form()] = "true",
    icon_path: Annotated[str, Form()] = "",
):
    if os.name != "nt":
        raise HTTPException(503, "The build server is not Windows. Windows is required to produce .exe files.")
    if len(files) != len(paths) or not files:
        raise HTTPException(400, "The uploaded files and paths do not match.")
    if len(files) > MAX_FILES:
        raise HTTPException(413, f"Maximum {MAX_FILES} project files per build.")

    safe_paths = [safe_relative_path(p) for p in paths]
    if len(set(str(p).lower() for p in safe_paths)) != len(safe_paths):
        raise HTTPException(400, "The project contains duplicate file paths.")
    if entry_file not in paths:
        raise HTTPException(400, "Choose an entry .py file that is included in the upload.")
    entry_rel = safe_relative_path(entry_file)
    if entry_rel.suffix.lower() != ".py":
        raise HTTPException(400, "The entry file must be a .py file.")
    if build_type not in {"onefile", "folder"}:
        raise HTTPException(400, "Invalid build format.")

    name = clean_name(app_name)
    temp = tempfile.TemporaryDirectory(prefix="py2exe_")
    project_dir = Path(temp.name)
    total = 0
    try:
        for upload, relative in zip(files, safe_paths):
            target = project_dir / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            size = 0
            with target.open("wb") as output:
                while chunk := await upload.read(1024 * 1024):
                    size += len(chunk)
                    total += len(chunk)
                    if size > MAX_SINGLE_BYTES or total > MAX_TOTAL_BYTES:
                        raise HTTPException(413, "Project is too large. Maximum total upload is 200 MB.")
                    output.write(chunk)
            await upload.close()

        icon = None
        if icon_path:
            icon = project_dir / safe_relative_path(icon_path)
            if not icon.is_file() or icon.suffix.lower() != ".ico":
                raise HTTPException(400, "The selected icon must be an uploaded .ico file.")

        try:
            result_path = await run_in_threadpool(
                build_project, project_dir, entry_rel, name,
                build_type, console.lower() == "true", icon
            )
        except subprocess.TimeoutExpired:
            raise HTTPException(408, "Build timed out. Try a smaller project.")
        except ValueError as exc:
            raise HTTPException(422, "PyInstaller build failed:\n" + str(exc))
        except RuntimeError as exc:
            raise HTTPException(500, str(exc))

        media = "application/zip" if result_path.suffix == ".zip" else "application/vnd.microsoft.portable-executable"
        response = FileResponse(
            result_path, media_type=media,
            filename=result_path.name,
            background=BackgroundTask(temp.cleanup),
        )
        temp = None
        return response
    finally:
        if temp is not None:
            temp.cleanup()


@app.get("/api/health")
async def health():
    return {"ok": True, "windows_builds": os.name == "nt"}
