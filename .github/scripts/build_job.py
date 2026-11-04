import json, os, pathlib, subprocess, sys, urllib.parse, urllib.request, urllib.error, shutil, traceback, math, time

job=os.environ["JOB_ID"]
token=os.environ["JOB_TOKEN"]
base=os.environ["WORKER_URL"].rstrip("/")
headers={"Authorization":"Bearer "+token,"X-Job-Token":token,"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36","Accept":"application/json, application/octet-stream"}
CHUNK=10*1024*1024

def request(path, data=None, extra=None):
    h=dict(headers)
    if extra: h.update(extra)
    req=urllib.request.Request(base+path,data=data,headers=h,method="POST" if data is not None else "GET")
    return urllib.request.urlopen(req,timeout=180)

def request_eventually(path, attempts=30):
    last=None
    for _ in range(attempts):
        try:
            return request(path)
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                detail=exc.read().decode("utf-8","replace")[:500]
                raise RuntimeError(f"Worker rejected the build request (HTTP {exc.code}): {detail}") from exc
            last=exc
            time.sleep(3)
    raise RuntimeError("Uploaded project is still syncing. Please retry the build.") from last

try:
    manifest=json.load(request_eventually(f"/internal/jobs/{job}/manifest"))
    request(f"/internal/jobs/{job}/building",b"",{"Content-Type":"application/octet-stream"}).read()
    root=pathlib.Path("project").resolve()
    root.mkdir(exist_ok=True)
    for item in manifest["files"]:
        rel=item["path"]
        target=root/pathlib.PurePosixPath(rel)
        target.parent.mkdir(parents=True,exist_ok=True)
        with target.open("wb") as out:
            for part in range(item["chunks"]):
                query=urllib.parse.urlencode({"path":rel,"part":part})
                with request_eventually(f"/internal/jobs/{job}/file?{query}") as r:
                    out.write(r.read())
    m=manifest["metadata"]
    entry=pathlib.Path(m["entry_file"])
    if not (root/entry).is_file(): raise RuntimeError("Entry Python file is missing")
    name=m["app_name"]
    dist=root/"dist"; work=root/"build"; spec=root/"spec"
    cmd=[sys.executable,"-m","PyInstaller","--noconfirm","--clean","--name",name,
         "--distpath",str(dist),"--workpath",str(work),"--specpath",str(spec),
         "--paths",str(root),"--onefile" if m["build_type"]=="onefile" else "--onedir"]
    if not m["console"]: cmd.append("--windowed")
    if m["icon_path"]:
        icon=root/m["icon_path"]
        if not icon.is_file() or icon.suffix.lower()!=".ico": raise RuntimeError("Selected icon must be an uploaded .ico file")
        cmd += ["--icon",str(icon)]
    for asset in root.rglob("*"):
        if not asset.is_file(): continue
        rel=asset.relative_to(root)
        if any(p in {"dist","build","spec","__pycache__"} for p in rel.parts): continue
        if asset.suffix.lower() in {".py",".pyc",".spec",".ico"}: continue
        cmd += ["--add-data",f"{asset};{rel.parent.as_posix()}"]
    cmd.append(str(root/entry))
    result=subprocess.run(cmd,cwd=root,capture_output=True,text=True,timeout=600)
    if result.returncode: raise RuntimeError((result.stdout+"\n"+result.stderr)[-6000:])
    if m["build_type"]=="onefile":
        output=dist/(name+".exe")
    else:
        output=pathlib.Path(shutil.make_archive(name+"-windows-build","zip",root_dir=dist,base_dir=name))
    if not output.is_file(): raise RuntimeError("Build output was not created")
    size=output.stat().st_size
    if size>80*1024*1024: raise RuntimeError("The finished build is larger than the 80 MB download limit.")
    total=max(1,math.ceil(size/CHUNK))
    with output.open("rb") as source:
        for part in range(total):
            data=source.read(CHUNK)
            query=urllib.parse.urlencode({"part":part,"total":total,"filename":output.name})
            request(f"/internal/jobs/{job}/result?{query}",data,{"Content-Type":"application/octet-stream"}).read()
    request(f"/internal/jobs/{job}/complete?"+urllib.parse.urlencode({"total":total,"filename":output.name}),b"",{"Content-Type":"application/octet-stream"}).read()
except Exception as e:
    message=str(e) or traceback.format_exc()
    try: request(f"/internal/jobs/{job}/fail",json.dumps({"error":message[-3000:]}).encode(),{"Content-Type":"application/json"}).read()
    except Exception: pass
    raise
