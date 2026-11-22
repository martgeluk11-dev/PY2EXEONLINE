import json, os, pathlib, subprocess, sys, urllib.parse, urllib.request, urllib.error, shutil, traceback, math, time, zipfile

job=os.environ["JOB_ID"]
token=os.environ["JOB_TOKEN"]
base=os.environ["WORKER_URL"].rstrip("/")
headers={"Authorization":"Bearer "+token,"X-Job-Token":token,"User-Agent":"EXEcify-Windows-Builder","Accept":"application/json, application/octet-stream"}
CHUNK=10*1024*1024
ROOT=pathlib.Path("project").resolve()
PROJECT=ROOT
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

def run(command,cwd=None,timeout=600,env=None):
    safe_env=dict(os.environ)
    for key in ("JOB_ID","JOB_TOKEN","WORKER_URL","GITHUB_TOKEN","ACTIONS_RUNTIME_TOKEN","ACTIONS_ID_TOKEN_REQUEST_TOKEN","ACTIONS_ID_TOKEN_REQUEST_URL"):
        safe_env.pop(key,None)
    safe_env["CI"]="true"
    result=subprocess.run(command,cwd=cwd or PROJECT,capture_output=True,text=True,timeout=timeout,env=env or safe_env,shell=False)
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
    archive=(ROOT/pathlib.Path(*pathlib.PurePosixPath(m["entry_file"]).parts)).resolve()
    if ROOT not in archive.parents or not archive.is_file(): raise RuntimeError("Selected project file is missing.")
    if archive.suffix.lower()==".zip":
        extracted=ROOT/"__extracted_project"
        extracted.mkdir(exist_ok=True)
        with zipfile.ZipFile(archive) as z:
            members=z.infolist()
            if len(members)>3000: raise RuntimeError("ZIP contains too many files (maximum 3,000).")
            expanded=sum(item.file_size for item in members)
            if expanded>300*1024*1024: raise RuntimeError("Expanded ZIP is larger than 300 MB.")
            for item in members:
                rel=pathlib.PurePosixPath(item.filename)
                mode=(item.external_attr>>16)&0o170000
                if rel.is_absolute() or not rel.parts or any(part in ("..","") for part in rel.parts) or "\\\\" in item.filename or mode==0o120000:
                    raise RuntimeError("ZIP contains an unsafe path or symbolic link.")
                destination=(extracted/pathlib.Path(*rel.parts)).resolve()
                if extracted not in destination.parents and destination!=extracted:
                    raise RuntimeError("ZIP contains a path outside the project folder.")
            z.extractall(extracted)
        children=list(extracted.iterdir())
        PROJECT=children[0] if len(children)==1 and children[0].is_dir() else extracted
        def find(pattern):
            matches=[]
            for path in PROJECT.rglob(pattern):
                if any(part.lower() in {"node_modules",".git",".venv","venv","__pycache__","dist","build","target","bin","obj"} for part in path.relative_to(PROJECT).parts): continue
                matches.append(path)
            return sorted(matches,key=lambda p:(len(p.relative_to(PROJECT).parts),str(p).lower()))
        if language=="auto":
            if find("Cargo.toml"): language="rust"
            elif find("*.csproj"): language="csharp"
            elif find("go.mod"): language="go"
            elif find("tsconfig.json"): language="typescript"
            elif find("package.json"): language="node"
            elif find("pom.xml") or find("build.gradle") or find("build.gradle.kts") or find("*.java"): language="java"
            elif find("CMakeLists.txt"):
                language="cpp" if find("*.cpp") or find("*.cc") or find("*.cxx") else "c"
            elif find("requirements.txt") or find("*.py"): language="python"
            elif find("*.cpp") or find("*.cc") or find("*.cxx"): language="cpp"
            elif find("*.c"): language="c"
            else: raise RuntimeError("Could not detect the project language. Include a project manifest such as package.json, Cargo.toml, go.mod, .csproj, requirements.txt or CMakeLists.txt.")
        entry_candidates={
            "python":find("main.py")+find("app.py")+find("*.py"),
            "node":find("package.json")+find("*.js")+find("*.mjs"),
            "typescript":find("package.json")+find("*.ts"),
            "csharp":find("*.csproj"),
            "go":find("go.mod")+find("*.go"),
            "rust":find("Cargo.toml"),
            "java":find("*.java"),
            "c":find("CMakeLists.txt")+find("*.c"),
            "cpp":find("CMakeLists.txt")+find("*.cpp")+find("*.cc")+find("*.cxx")
        }
        candidates=entry_candidates.get(language,[])
        if not candidates: raise RuntimeError("No suitable entry file or project manifest was found for "+language+".")
        entry=candidates[0]
    else:
        entry=archive
        PROJECT=ROOT
        manifest_names={
            "python":["requirements.txt"],"node":["package.json"],"typescript":["package.json"],
            "csharp":[entry.name],"go":["go.mod"],"rust":["Cargo.toml"],
            "java":["pom.xml","build.gradle","build.gradle.kts"],"c":["CMakeLists.txt"],"cpp":["CMakeLists.txt"]
        }.get(language,[])
        if language=="csharp": PROJECT=entry.parent
        else:
            for parent in [entry.parent,*entry.parent.parents]:
                if parent==ROOT or ROOT not in parent.parents: continue
                if any((parent/item).is_file() for item in manifest_names):
                    PROJECT=parent
                    break
        if PROJECT==ROOT:
            project_paths=[pathlib.PurePosixPath(item["path"]).parts for item in manifest["files"] if item["path"]!="__app_icon__.ico"]
            if project_paths and all(len(parts)>1 and parts[0]==project_paths[0][0] for parts in project_paths):
                candidate=ROOT/project_paths[0][0]
                if candidate.is_dir(): PROJECT=candidate
    DIST=PROJECT/"dist"
    DIST.mkdir(exist_ok=True)
    output=None

    if language=="python":
        requirements=PROJECT/"requirements.txt"
        if requirements.is_file(): run([sys.executable,"-m","pip","install","--disable-pip-version-check","-r",str(requirements)],timeout=420)
        cmd=[sys.executable,"-m","PyInstaller","--noconfirm","--clean","--name",name,"--distpath",str(DIST),"--workpath",str(PROJECT/"build"),"--specpath",str(PROJECT/"spec"),"--paths",str(PROJECT),"--onefile" if m["build_type"]=="onefile" else "--onedir"]
        if not m["console"]: cmd.append("--windowed")
        if m.get("icon_path"):
            icon=ROOT/m["icon_path"]
            if not icon.is_file() or icon.suffix.lower()!=".ico": raise RuntimeError("Selected icon must be an uploaded .ico file")
            cmd += ["--icon",str(icon)]
        for asset in PROJECT.rglob("*"):
            if not asset.is_file(): continue
            rel=asset.relative_to(PROJECT)
            if any(p in {"dist","build","spec","__pycache__",".git",".venv","node_modules"} for p in rel.parts): continue
            if asset.suffix.lower() in {".py",".pyc",".spec",".ico"}: continue
            cmd += ["--add-data",f"{asset};{rel.parent.as_posix()}"]
        cmd.append(str(entry))
        run(cmd,timeout=600)
        output=DIST/(name+".exe") if m["build_type"]=="onefile" else package_folder(DIST/name,name)

    elif language in ("node","typescript"):
        package=PROJECT/"package.json"
        if not package.is_file(): raise RuntimeError("Node.js and TypeScript projects need a package.json file.")
        lock=PROJECT/"package-lock.json"
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
        main_path=(PROJECT/str(main)).resolve()
        if PROJECT not in main_path.parents or not main_path.is_file(): raise RuntimeError("The package.json main/bin file could not be found.")
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
        if not (PROJECT/"go.mod").is_file(): raise RuntimeError("Go projects need a go.mod file so dependencies can be resolved.")
        relative=entry.parent.relative_to(PROJECT).as_posix()
        target="." if relative=="." else "./"+relative
        run(["go","build","-trimpath","-ldflags=-s -w","-o",str(DIST/(name+".exe")),target],timeout=600)
        output=DIST/(name+".exe")

    elif language=="rust":
        cargo=PROJECT/"Cargo.toml"
        if not cargo.is_file(): raise RuntimeError("Rust projects need a Cargo.toml manifest.")
        run(["cargo","build","--release","--manifest-path",str(cargo)],timeout=600)
        candidates=list((PROJECT/"target"/"release").glob("*.exe"))
        candidates=[p for p in candidates if p.name.lower()!="build-script-build.exe"]
        if not candidates: raise RuntimeError("Cargo finished but no Windows executable was found.")
        preferred=PROJECT/"target"/"release"/(name+".exe")
        output=preferred if preferred.is_file() else max(candidates,key=lambda p:p.stat().st_mtime)

    elif language=="java":
        java_sources=list(PROJECT.rglob("*.java"))
        if not java_sources: raise RuntimeError("No Java source files were found.")
        if (PROJECT/"pom.xml").is_file():
            mvnw=PROJECT/"mvnw.cmd"
            run(["cmd.exe","/c",str(mvnw),"-DskipTests","package"] if mvnw.is_file() else ["mvn","-DskipTests","package"],timeout=600)
        elif (PROJECT/"gradlew.bat").is_file():
            run(["cmd.exe","/c",str(PROJECT/"gradlew.bat"),"build"],timeout=600)
        elif (PROJECT/"build.gradle").is_file() or (PROJECT/"build.gradle.kts").is_file():
            run(["gradle","build"],timeout=600)
        else:
            classes=PROJECT/"java-classes"
            classes.mkdir(exist_ok=True)
            run(["javac","-encoding","UTF-8","-d",str(classes)]+[str(p) for p in java_sources],timeout=480)
            main_class=entry.stem
            source_text=entry.read_text(encoding="utf-8",errors="replace")
            import re
            package_match=re.search(r"(?m)^\s*package\s+([A-Za-z0-9_.]+)\s*;",source_text)
            if package_match: main_class=package_match.group(1)+"."+main_class
            jar=PROJECT/(name+".jar")
            run(["jar","--create","--file",str(jar),"--main-class",main_class,"-C",str(classes),"."])
        jars=[p for base_dir in (PROJECT/"target",PROJECT/"build"/"libs") if base_dir.exists() for p in base_dir.rglob("*.jar")]
        if not jars and (PROJECT/(name+".jar")).is_file(): jars=[PROJECT/(name+".jar")]
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
        cmakelists=PROJECT/"CMakeLists.txt"
        if not cmakelists.is_file():
            sources=[p for p in PROJECT.rglob("*") if p.is_file() and p.suffix.lower() in ([".c"] if language=="c" else [".cpp",".cc",".cxx"])]
            if not sources: raise RuntimeError("No source files for the selected C/C++ language were found.")
            lines=["cmake_minimum_required(VERSION 3.20)",f"project({name} LANGUAGES {'C' if language=='c' else 'CXX'})",f"add_executable({name}"]
            lines += ["  "+p.relative_to(PROJECT).as_posix() for p in sources]
            lines += [")"]
            cmakelists.write_text("\n".join(lines)+"\n",encoding="utf-8")
        build=PROJECT/"cmake-build"
        run(["cmake","-S",str(PROJECT),"-B",str(build),"-A","x64"],timeout=300)
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
