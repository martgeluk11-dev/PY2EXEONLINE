# EXEcify

**Try it online:** [https://martgeluk11-dev.github.io/PY2EXEONLINE/](https://martgeluk11-dev.github.io/PY2EXEONLINE/)

A browser-based Python project packager that builds **real Windows .exe files** with PyInstaller.

## Features

- Upload multiple files or an entire project folder.
- Choose the main Python entry file.
- Bundle images, audio, video, fonts, JSON, text files and other assets.
- Build a single EXE or a ZIP containing an onedir build.
- Optional .ico icon and console window.

## Online architecture

- GitHub Pages hosts the frontend.
- A Cloudflare Worker handles uploads and job status.
- Cloudflare Workers KV stores temporary upload/result chunks for 24 hours.
- GitHub Actions uses a temporary Windows runner to build with PyInstaller.

The online version does not use R2. It is designed for the Cloudflare Workers Free plan: KV has a free daily quota and operations beyond that quota fail instead of being billed. Keep the account on the Workers Free plan; do not upgrade or enable paid usage. See Cloudflare's [KV limits](https://developers.cloudflare.com/kv/platform/limits/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

## Cloudflare setup

1. Create a Worker named `py2exe-online` and paste `cloudflare/src/index.js`.
2. Create a Workers KV namespace named `PY2EXE_JOBS`.
3. Add a KV binding to the Worker with variable name `JOBS` and select `PY2EXE_JOBS`.
4. Add the Worker secret `TURNSTILE_SECRET`.
5. Add the Worker secret `GITHUB_TOKEN` (a fine-grained token for this repository with Contents: Read and write).
6. Add the text variable `GITHUB_REPO` with value `martgeluk11-dev/PY2EXEONLINE`.
7. Deploy the Worker and copy its `workers.dev` URL.

Create a Turnstile widget for the GitHub Pages domain and put its Site Key in `static/index.html`. Put the deployed Worker URL in `static/app.js`. Never put either secret in frontend files.

## GitHub setup

Enable GitHub Actions for the repository. The workflow listens for the `py2exe-build` repository dispatch event and builds on `windows-latest`.

## Limits

- 150 files per project.
- 80 MB total input.
- 80 MB output.
- Upload and build data expires after 24 hours.
- Dependencies not included with the project are not installed automatically. Add required packages to the build workflow if needed.

## Local Windows build

The legacy FastAPI backend can also be run on Windows with Python 3.11+ using `start.bat`.
