import json, os, pathlib, subprocess, sys, urllib.parse, urllib.request, urllib.error, shutil, traceback, math, time, zipfile

job=os.environ["JOB_ID"]
token=os.environ["JOB_TOKEN"]
base=os.environ["WORKER_URL"].rstrip("/")
headers={"Authorization":"Bearer "+token,"X-Job-Token":token,"User-Agent":"EXEcify-Windows-Builder","Accept":"application/json, application/octet-stream"}
CHUNK=10*1024*1024
ROOT=pathlib.Path("project").resolve()
DIST=ROOT/"dist"

def request(path,data=None,extra=None):
    h=dict(headers)
    if extra: h.update(extra)
    req=urllib.request.Request(base+path,data=data,headers=h,method="POST" if data is not None else "GET")
    return urllib.request.urlopen(req,timeout=180)

def request_eventually(path,attempts=30):
    last=None
    for _ in range(attempts):
        try: return request(path)
        except urllib.error.HTTPError as exc:
            if exc.code!=404:
                detail=exc.read().decode("utf-8","replace")[:500]
                raise RuntimeError(f"Worker rejected the build request (HTTP {exc.code}): {detail}") from exc
            last=exc
            time.sleep(3)
    raise RuntimeError("Uploaded project is still syncing. Please retry the build.") from last

def run(command,cwd=ROOT,timeout=600,env=None):
    safe_env=dict(os.environ)
    for key in ("JOB_ID","JOB_TOKEN","WORKER_URL","GITHUB_TOKEN","ACTIONS_RUNTIME_TOKEN","ACTIONS_ID_TOKEN_REQUEST_TOKEN","ACTIONS_ID_TOKEN_REQUEST_URL"):
        safe_env.pop(key,None)
    safe_env["CI"]="true"
    result=subprocess.run(command,cwd=cwd,capture_output=True,text=True,timeout=timeout,env=env or safe_env,shell=False)
    if result.returncode:
        output=(result.stdout+"\n"+result.stderr)[-7000:]
        raise RuntimeError(output or "Build command failed.")
    return result

def first_file(patterns):
    for pattern in patterns:
        found=sorted(ROOT.glob(pattern))
        if found: return found[0]
    return None

def package_folder(source,name):
    archive=pathlib.Path(name+"-windows-build.zip")
    with zipfile.ZipFile(archive,"w",zipfile.ZIP_DEFLATED) as z:
        for file in source.rglob("*"):
            if file.is_file(): z.write(file,file.relative_to(source.parent))
    return archive

try:
    manifest=json.load(request_eventually(f"/internal/jobs/{job}/manifest"))
    request(f"/internal/jobs/{job}/building",b"",{"Content-Type":"application/octet-stream"}).read()
    ROOT.mkdir(exist_ok=True)
    for item in manifest["files"]:
        rel=pathlib.PurePosixPath(item["path"])
        target=(ROOT/pathlib.Path(*rel.parts)).resolve()
        if ROOT not in target.parents: raise RuntimeError("Unsafe project path rejected.")
        target.parent.mkdir(parents=True,exist_ok=True)
        with target.open("wb") as out:
            for part in range(item["chunks"]):
                query=urllib.parse.urlencode({"path":item["path"],"part":part})
                with request_eventually(f"/internal/jobs/{job}/file?{query}") as response: out.write(response.read())

    m=manifest["metadata"]
    language=m.get("language","python")
    name=m["app_name"]
    entry=(ROOT/pathlib.Path(*pathlib.PurePosixPath(m["entry_file"]).parts)).resolve()
    if ROOT not in entry.parents or not entry.is_file(): raise RuntimeError("Selected starting file is missing.")
    DIST.mkdir(exist_ok=True)
    output=None

    if language=="python":
        requirements=ROOT/"requirements.txt"
        if requirements.is_file(): run([sys.executable,"-m","pip","install","--disable-pip-version-check","-r",str(requirements)],timeout=420)
        cmd=[sys.executable,"-m","PyInstaller","--noconfirm","--clean","--name",name,"--distpath",str(DIST),"--workpath",str(ROOT/"build"),"--specpath",str(ROOT/"spec"),"--paths",str(ROOT),"--onefile" if m["build_type"]=="onefile" else "--onedir"]
        if not m["console"]: cmd.append("--windowed")
        if m.get("icon_path"):
            icon=ROOT/m["icon_path"]
            if not icon.is_file() or icon.suffix.lower()!=".ico": raise RuntimeError("Selected icon must be an uploaded .ico file")
            cmd += ["--icon",str(icon)]
        for asset in ROOT.rglob("*"):
            if not asset.is_file(): continue
            rel=asset.relative_to(ROOT)
            if any(p in {"dist","build","spec","__pycache__",".git",".venv","node_modules"} for p in rel.parts): continue
            if asset.suffix.lower() in {".py",".pyc",".spec",".ico"}: continue
            cmd += ["--add-data",f"{asset};{rel.parent.as_posix()}"]
        cmd.append(str(entry))
        run(cmd,timeout=600)
        output=DIST/(name+".exe") if m["build_type"]=="onefile" else package_folder(DIST/name,name)

    elif language in ("node","typescript"):
        package=ROOT/"package.json"
        if not package.is_file(): raise RuntimeError("Node.js and TypeScript projects need a package.json file.")
        lock=ROOT/"package-lock.json"
        run(["npm","ci"] if lock.is_file() else ["npm","install","--no-audit","--no-fund"],timeout=480)
        if language=="typescript":
            import json as _json
            pkg=_json.loads(package.read_text(encoding="utf-8"))
            if not pkg.get("scripts",{}).get("build"): raise RuntimeError("Add a build script to package.json to compile your TypeScript project.")
            run(["npm","run","build"],timeout=480)
        import json as _json
        pkg=_json.loads(package.read_text(encoding="utf-8"))
        if language=="typescript" and not (pkg.get("bin") or pkg.get("main")):
            raise RuntimeError("Set main or bin in package.json to the compiled JavaScript entry file (for example dist/index.js).")
        main=pkg.get("bin") or pkg.get("main") or m["entry_file"]
        if isinstance(main,dict): main=next(iter(main.values()))
        main_path=(ROOT/str(main)).resolve()
        if ROOT not in main_path.parents or not main_path.is_file(): raise RuntimeError("The package.json main/bin file could not be found.")
        run(["npx","--yes","@yao-pkg/pkg","--targets","node20-win-x64","--output",str(DIST/(name+".exe")),str(main_path)],timeout=600)
        output=DIST/(name+".exe")

    elif language=="csharp":
        project=entry if entry.suffix.lower()==".csproj" else first_file(["*.csproj"])
        if not project: raise RuntimeError("C# projects need a .csproj project file.")
        run(["dotnet","publish",str(project),"-c","Release","-r","win-x64","--self-contained","true","-p:PublishSingleFile=true","-p:IncludeNativeLibrariesForSelfExtract=true","-o",str(DIST)],timeout=600)
        output=DIST/(name+".exe")
        if not output.is_file():
            candidates=[p for p in DIST.glob("*.exe") if p.name.lower()!="setup.exe"]
            if not candidates: raise RuntimeError("dotnet publish finished but no EXE was produced.")
            output=candidates[0]

    elif language=="go":
        if not (ROOT/"go.mod").is_file(): raise RuntimeError("Go projects need a go.mod file so dependencies can be resolved.")
        relative=entry.parent.relative_to(ROOT).as_posix()
        target="." if relative=="." else "./"+relative
        run(["go","build","-trimpath","-ldflags=-s -w","-o",str(DIST/(name+".exe")),target],timeout=600)
        output=DIST/(name+".exe")

    elif language=="rust":
        cargo=ROOT/"Cargo.toml"
        if not cargo.is_file(): raise RuntimeError("Rust projects need a Cargo.toml manifest.")
        run(["cargo","build","--release","--manifest-path",str(cargo)],timeout=600)
        candidates=list((ROOT/"target"/"release").glob("*.exe"))
        candidates=[p for p in candidates if p.name.lower()!="build-script-build.exe"]
        if not candidates: raise RuntimeError("Cargo finished but no Windows executable was found.")
        preferred=ROOT/"target"/"release"/(name+".exe")
        output=preferred if preferred.is_file() else max(candidates,key=lambda p:p.stat().st_mtime)

    elif language=="java":
        java_sources=list(ROOT.rglob("*.java"))
        if not java_sources: raise RuntimeError("No Java source files were found.")
        if (ROOT/"pom.xml").is_file():
            mvnw=ROOT/"mvnw.cmd"
            run([str(mvnw),"-DskipTests","package"] if mvnw.is_file() else ["mvn","-DskipTests","package"],timeout=600)
        elif (ROOT/"gradlew.bat").is_file():
            run([str(ROOT/"gradlew.bat"),"build"],timeout=600)
        elif (ROOT/"build.gradle").is_file() or (ROOT/"build.gradle.kts").is_file():
            run(["gradle","build"],timeout=600)
        else:
            classes=ROOT/"java-classes"
            classes.mkdir(exist_ok=True)
            run(["javac","-encoding","UTF-8","-d",str(classes)]+[str(p) for p in java_sources],timeout=480)
            main_class=entry.stem
            source_text=entry.read_text(encoding="utf-8",errors="replace")
            import re
            package_match=re.search(r"(?m)^\\s*package\\s+([A-Za-z0-9_.]+)\\s*;",source_text)
            if package_match: main_class=package_match.group(1)+"."+main_class
            jar=ROOT/(name+".jar")
            run(["jar","--create","--file",str(jar),"--main-class",main_class,"-C",str(classes),"."])
        jars=[p for base_dir in (ROOT/"target",ROOT/"build"/"libs") if base_dir.exists() for p in base_dir.rglob("*.jar")]
        if not jars and (ROOT/(name+".jar")).is_file(): jars=[ROOT/(name+".jar")]
        jars=[p for p in jars if not any(part in {"sources","javadoc"} for part in p.parts) and "-sources" not in p.name and "-javadoc" not in p.name]
        if not jars: raise RuntimeError("Java build completed but no application JAR was found.")
        jar=max(jars,key=lambda p:p.stat().st_mtime)
        run(["jpackage","--type","app-image","--name",name,"--input",str(jar.parent),"--main-jar",jar.name,"--dest",str(DIST)],timeout=600)
        app_image=DIST/name
        if not app_image.is_dir() or not (app_image/(name+".exe")).is_file():
            raise RuntimeError("jpackage did not create the Windows application image.")
        output=package_folder(app_image,name)

    elif language in ("c","cpp"):
        cmake=shutil.which("cmake")
        if not cmake: raise RuntimeError("CMake is not available on the Windows build machine.")
        cmakelists=ROOT/"CMakeLists.txt"
        if not cmakelists.is_file():
            sources=[p for p in ROOT.rglob("*") if p.is_file() and p.suffix.lower() in ([".c"] if language=="c" else [".cpp",".cc",".cxx"])]
            if not sources: raise RuntimeError("No source files for the selected C/C++ language were found.")
            lines=["cmake_minimum_required(VERSION 3.20)",f"project({name} LANGUAGES {'C' if language=='c' else 'CXX'})",f"add_executable({name}"]
            lines += ["  "+p.relative_to(ROOT).as_posix() for p in sources]
            lines += [")"]
            cmakelists.write_text("\n".join(lines)+"\n",encoding="utf-8")
        build=ROOT/"cmake-build"
        run(["cmake","-S",str(ROOT),"-B",str(build),"-A","x64"],timeout=300)
        run(["cmake","--build",str(build),"--config","Release","--parallel"],timeout=600)
        candidates=[p for p in build.rglob("*.exe") if "CMakeFiles" not in p.parts]
        if not candidates: raise RuntimeError("CMake finished but no EXE was produced. Check that your CMake project defines an executable target.")
        output=next((p for p in candidates if p.stem.lower()==name.lower()),candidates[0])

    else:
        raise RuntimeError("This language is not supported by the current build engine.")

    if not output or not output.is_file(): raise RuntimeError("Build finished but the expected output file was not created.")
    size=output.stat().st_size
    if size>80*1024*1024: raise RuntimeError("The finished build is larger than the 80 MB download limit.")
    total=max(1,math.ceil(size/CHUNK))
    with output.open("rb") as source:
        for part in range(total):
            data=source.read(CHUNK)
            query=urllib.parse.urlencode({"part":part,"total":total,"filename":output.name})
            request(f"/internal/jobs/{job}/result?{query}",data,{"Content-Type":"application/octet-stream"}).read()
    request(f"/internal/jobs/{job}/complete?"+urllib.parse.urlencode({"total":total,"filename":output.name}),b"",{"Content-Type":"application/octet-stream"}).read()
except Exception as exc:
    message=str(exc) or traceback.format_exc()
    try: request(f"/internal/jobs/{job}/fail",json.dumps({"error":message[-3000:]}).encode(),{"Content-Type":"application/json"}).read()
    except Exception: pass
    raise
