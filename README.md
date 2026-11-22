# EXEcify

**Try it online:** [https://martgeluk11-dev.github.io/PY2EXEONLINE/](https://martgeluk11-dev.github.io/PY2EXEONLINE/)

<img width="1364" height="766" alt="Screenshot 2026-11-06 13 24 24" src="https://github.com/user-attachments/assets/e7a66245-ccd3-4691-b1be-887d8afa458a" />

A browser-based multi-language project builder that creates **real Windows executables** from complete source projects.

## Features

- Upload multiple files or an entire project folder.
- Supported languages: **Python, JavaScript / Node.js, TypeScript, C, C++, C# / .NET, Go, Rust and Java**.
- Upload complete project folders, individual files, or ZIP archives with multiple source files, manifests, dependencies and assets. ZIP archives are extracted and scanned automatically. Generated folders such as node_modules, .git, build and dist are skipped automatically.
- Resolve dependencies through project-native tools: pip, npm, NuGet/.NET, Go modules and Cargo.
- C and C++ projects can use CMake; simple source projects get a generated CMake build file.
- Build on a temporary Windows runner and download the resulting EXE.
- Optional .ico icon and console window (currently applied to Python builds).

## Online architecture

- GitHub Pages hosts the frontend.
- A Cloudflare Worker handles uploads and job status.
- Cloudflare Workers KV stores temporary upload/result chunks for 24 hours.
- GitHub Actions uses a temporary Windows runner with language-specific toolchains: PyInstaller, Node packaging, CMake/MSVC, .NET, Go, Rust and Java.

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
- Python dependencies are read from requirements.txt; Node/TypeScript use package.json and package-lock.json; .NET restores NuGet packages; Go uses go.mod; Rust uses Cargo.toml. C/C++ dependency setup should be declared in CMakeLists.txt.
- Node.js / TypeScript packaging currently relies on the @yao-pkg/pkg tool and may not support every native module or modern Node API.
- Java projects are packaged as a ZIP containing a Windows app image, launcher EXE and bundled Java runtime.
- C/C++ projects with custom dependencies should include a CMakeLists.txt.
- Other languages are not supported by this build engine yet.

## Local Windows build

The legacy FastAPI backend can also be run on Windows with Python 3.11+ using `start.bat`; that local backend remains Python-only. Multi-language builds use the online Windows runner.
