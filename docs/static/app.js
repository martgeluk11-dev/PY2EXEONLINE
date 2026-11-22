const $ = (id) => document.getElementById(id);
const API_BASE = window.PY2EXE_API_BASE || "https://py2exe-online.martgeluk11.workers.dev";
const fileInput = $("files"), folderInput = $("folder");
let projectFiles = [];
let format = "onefile";
let iconFile = null;
const CHUNK_SIZE = 10 * 1024 * 1024;
const IGNORED_DIRS = new Set(["node_modules",".git",".venv","venv","__pycache__","dist","build","target","bin","obj",".next",".turbo"]);
const EXTENSIONS = {
  python:[".py"], node:[".js",".mjs",".cjs"], typescript:[".ts"],
  c:[".c"], cpp:[".cpp",".cc",".cxx"], csharp:[".csproj"],
  go:[".go","go.mod"], rust:["cargo.toml",".rs"], java:[".java"]
};
const LABELS = {
  python:"Python",node:"JavaScript / Node.js",typescript:"TypeScript",c:"C",cpp:"C++",
  csharp:"C# / .NET",go:"Go",rust:"Rust",java:"Java"
};
function hasZipArchive(){return projectFiles.length===1&&projectFiles[0].path.toLowerCase().endsWith(".zip");}
function detectLanguage(){
  if(hasZipArchive())return "auto";
  const paths=projectFiles.map(x=>x.path.toLowerCase());
  if(paths.some(x=>x.endsWith("cargo.toml")))return "rust";
  if(paths.some(x=>x.endsWith(".java"))||paths.some(x=>x.endsWith("pom.xml"))||paths.some(x=>x.endsWith("build.gradle"))||paths.some(x=>x.endsWith("build.gradle.kts")))return "java";
  if(paths.some(x=>x.endsWith(".csproj")))return "csharp";
  if(paths.some(x=>x.endsWith("go.mod")))return "go";
  if(paths.some(x=>x.endsWith("tsconfig.json"))||paths.some(x=>x.endsWith(".ts")))return "typescript";
  if(paths.some(x=>x.endsWith("package.json"))||paths.some(x=>/\.(mjs|cjs|js)$/.test(x)))return "node";
  if(paths.some(x=>x.endsWith("cmakelists.txt"))||paths.some(x=>/\.(cpp|cc|cxx)$/.test(x)))return "cpp";
  if(paths.some(x=>x.endsWith(".c")))return "c";
  if(paths.some(x=>x.endsWith(".py")))return "python";
  return "python";
}
function currentLanguage(){
  const selected=$("language").value;
  return selected==="auto"?(hasZipArchive()?"auto":detectLanguage()):selected;
}
function addFiles(list){
  let incoming=[...list].map(file=>({file,path:file.webkitRelativePath||file.name}))
    .filter(item=>{
      const parts=item.path.replace(/\\/g,"/").split("/");
      return !parts.some(part=>IGNORED_DIRS.has(part.toLowerCase()))&&![".ds_store","thumbs.db"].includes(parts.at(-1).toLowerCase());
    });
  const archives=incoming.filter(item=>item.path.toLowerCase().endsWith(".zip"));
  if(archives.length){
    if(incoming.length!==1){setStatus("Upload one ZIP archive at a time.",true);return;}
    projectFiles=archives;
    $("language").value="auto";
  }else{
    if(projectFiles.some(item=>item.path.toLowerCase().endsWith(".zip"))){projectFiles=[];}
  }
  const map=new Map(projectFiles.map(item=>[item.path,item]));
  for(const item of incoming)map.set(item.path,item);
  projectFiles=[...map.values()];
  renderFiles();
}
function renderFiles(){
  $("file-summary").hidden=projectFiles.length===0;
  $("file-count").textContent=projectFiles.length+(projectFiles.length===1?" file":" files");
  $("file-list").innerHTML="";
  projectFiles.slice(0,150).forEach(({file,path})=>{
    const row=document.createElement("div");row.className="file-row";
    const name=document.createElement("span");name.textContent=path;
    const size=document.createElement("span");
    size.textContent=file.size<1024*1024?(file.size/1024).toFixed(1)+" KB":(file.size/1024/1024).toFixed(1)+" MB";
    row.append(name,size);$("file-list").append(row);
  });
  const language=currentLanguage();
  const archive=hasZipArchive();
  const folderOption=document.querySelector('#formats [data-value="folder"]');
  if(folderOption)folderOption.hidden=language!=="python";
  if(language!=="python"&&format==="folder"){
    format="onefile";
    document.querySelectorAll(".segments button").forEach(b=>b.classList.toggle("selected",b.dataset.value==="onefile"));
  }
  const iconField=$("icon").closest(".field");
  if(iconField)iconField.hidden=language!=="python";
  if(language!=="python"){iconFile=null;$("icon").value="";$("icon-name").textContent="Choose an icon";}
  const candidates=archive?projectFiles:projectFiles.filter(item=>EXTENSIONS[language].some(ext=>item.path.toLowerCase().endsWith(ext)));
  const select=$("entry");select.innerHTML="";
  if(archive){
    select.add(new Option("Detect project inside ZIP archive",projectFiles[0].path));
    select.disabled=false;
  }else if(!candidates.length){
    select.add(new Option(projectFiles.length?"No matching project file found":"Add project files first",""));
    select.disabled=true;
  }else{
    candidates.forEach(item=>select.add(new Option(item.path,item.path)));
    select.disabled=false;
  }
  const help={
    python:"Choose the Python file that launches your application.",
    node:"Choose the JavaScript entry file. A package.json is required.",
    typescript:"Choose the TypeScript entry file. A package.json and TypeScript build setup are required.",
    c:"Choose the main .c source file. Multiple source files are supported.",
    cpp:"Choose the main C++ source file. Multiple source files are supported.",
    csharp:"Choose the .csproj project file. NuGet dependencies are restored automatically.",
    go:"Choose the main .go file or go.mod. A go.mod is required for dependencies.",
    rust:"Choose Cargo.toml (recommended) or a Rust source file. Cargo.toml is required.",
    java:"Choose the main .java file. Maven or Gradle project files are supported."
  };
  $("entry-help").textContent=archive?"EXEcify will safely extract the archive and detect its project files and language.":help[language];
  $("build").disabled=!candidates.length||projectFiles.length>150;
}
fileInput.addEventListener("change",e=>{addFiles(e.target.files);fileInput.value="";});
folderInput.addEventListener("change",e=>{addFiles(e.target.files);folderInput.value="";});
$("folder-button").addEventListener("click",()=>$("folder").click());
$("clear").addEventListener("click",()=>{projectFiles=[];renderFiles();});
$("language").addEventListener("change",renderFiles);
const drop=$("drop");
["dragenter","dragover"].forEach(type=>drop.addEventListener(type,e=>{e.preventDefault();drop.classList.add("over");}));
["dragleave","drop"].forEach(type=>drop.addEventListener(type,e=>{e.preventDefault();drop.classList.remove("over");}));
drop.addEventListener("drop",e=>addFiles(e.dataTransfer.files));
$("formats").addEventListener("click",e=>{
  const button=e.target.closest("button[data-value]");if(!button)return;
  format=button.dataset.value;
  document.querySelectorAll(".segments button").forEach(b=>b.classList.toggle("selected",b===button));
});
$("icon").addEventListener("change",e=>{iconFile=e.target.files[0]||null;$("icon-name").textContent=iconFile?iconFile.name:"Choose an icon";});
function setStatus(message,error=false){$("status").textContent=message;$("status").classList.toggle("error",error);}
let simulatedProgress=0;
let progressTimer=null;
function paintProgress(value){
  simulatedProgress=value;
  const bar=$("progress");bar.querySelector("i").style.width=value+"%";
  bar.setAttribute("aria-valuenow",String(Math.round(value)));
}
function startProgress(){
  clearTimeout(progressTimer);simulatedProgress=0;$("progress").classList.add("show");paintProgress(0);
  const tick=()=>{
    if(simulatedProgress>=98)return;
    const boundary=simulatedProgress<60?60:98,remaining=boundary-simulatedProgress;
    const step=simulatedProgress<60?(Math.random()<.28?1:Math.random()<.62?2:4):(Math.random()<.48?.25:Math.random()<.76?.5:1);
    paintProgress(Math.min(boundary,simulatedProgress+Math.min(step,remaining)));
    if(simulatedProgress===60){progressTimer=setTimeout(tick,1900+Math.random()*1100);return;}
    if(simulatedProgress>=98)return;
    const delay=simulatedProgress<60?(Math.random()<.2?850+Math.random()*500:180+Math.random()*260):(Math.random()<.3?1050+Math.random()*650:420+Math.random()*500);
    progressTimer=setTimeout(tick,delay);
  };
  progressTimer=setTimeout(tick,180);
}
function finishProgress(){clearTimeout(progressTimer);progressTimer=null;paintProgress(100);}
function resetProgress(){clearTimeout(progressTimer);progressTimer=null;simulatedProgress=0;paintProgress(0);$("progress").classList.remove("show");}
async function uploadFile(jobId,token,item){
  const chunks=Math.max(1,Math.ceil(item.file.size/CHUNK_SIZE));
  for(let part=0;part<chunks;part++){
    const start=part*CHUNK_SIZE,end=Math.min(item.file.size,start+CHUNK_SIZE);
    const bytes=await item.file.slice(start,end).arrayBuffer();
    const query=new URLSearchParams({path:item.path,part:String(part)});
    const response=await fetch(API_BASE+"/api/jobs/"+jobId+"/files?"+query,{method:"POST",headers:{"Authorization":"Bearer "+token,"Content-Type":"application/octet-stream"},body:bytes});
    if(!response.ok)throw new Error("Upload failed for "+item.path+" (chunk "+(part+1)+").");
  }
}
$("build").addEventListener("click",async()=>{
  if(!projectFiles.length)return;
  const language=currentLanguage();
  const files=[...projectFiles];
  if(iconFile)files.push({file:iconFile,path:"__app_icon__.ico"});
  const total=files.reduce((sum,item)=>sum+item.file.size,0);
  if(total>80*1024*1024){setStatus("Your project is larger than 80 MB.",true);return;}
  const captcha=window.turnstile?.getResponse?.();
  if(!captcha){setStatus("Please complete the security check first.",true);return;}
  const button=$("build");button.disabled=true;button.querySelector("span").textContent="Uploading project…";
  resetProgress();
  try{
    if(API_BASE.includes("YOUR-WORKER"))throw new Error("The build service URL has not been configured yet.");
    const create=await fetch(API_BASE+"/api/jobs",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      captcha,language,files:files.map(item=>({path:item.path,size:item.file.size})),
      entry_file:$("entry").value,app_name:$("appname").value||"my_app",build_type:format,
      console:$("console").checked,icon_path:iconFile?"__app_icon__.ico":""
    })});
    if(!create.ok){let msg=await create.text();try{msg=JSON.parse(msg).detail||msg;}catch{}throw new Error(msg);}
    const {job_id,upload_token}=await create.json();
    for(let i=0;i<files.length;i++){
      setStatus("Uploading project files… "+(i+1)+" of "+files.length);
      await uploadFile(job_id,upload_token,files[i]);
    }
    const start=await fetch(API_BASE+"/api/jobs/"+job_id+"/start",{method:"POST",headers:{"Authorization":"Bearer "+upload_token}});
    if(!start.ok)throw new Error(await start.text()||"Could not start the Windows build.");
    button.querySelector("span").textContent="Building your "+LABELS[language]+" app…";
    startProgress();setStatus("Upload complete. Waiting for a Windows build…");
    const deadline=Date.now()+22*60*1000;
    let state="queued";
    while(Date.now()<deadline){
      await new Promise(resolve=>setTimeout(resolve,2500));
      const auth={"Authorization":"Bearer "+upload_token};
      const check=await fetch(API_BASE+"/api/jobs/"+encodeURIComponent(job_id),{headers:auth});
      if(!check.ok)throw new Error("Could not check build status.");
      const result=await check.json();state=result.status;
      if(state==="failed")throw new Error(result.error||"Windows build failed.");
      if(state==="completed"){
        finishProgress();setStatus("Build complete — downloading your file…");
        const download=await fetch(API_BASE+"/api/jobs/"+encodeURIComponent(job_id)+"/download",{headers:auth});
        if(!download.ok)throw new Error("Build completed, but the download failed.");
        const blob=await download.blob(),a=document.createElement("a"),objectUrl=URL.createObjectURL(blob);
        a.href=objectUrl;a.download=result.filename||"my_app.exe";document.body.appendChild(a);a.click();a.remove();
        setTimeout(()=>URL.revokeObjectURL(objectUrl),30000);
        setStatus("Build complete — your download should have started.");break;
      }
      setStatus(state==="queued"?"Build queued — starting a Windows machine…":state==="building"?"Windows machine is building your app…":"Windows machine is preparing your app…");
    }
    if(state!=="completed"&&state!=="failed")throw new Error("The build took too long. Please try again.");
  }catch(error){setStatus(error.message||"Something went wrong.",true);}
  finally{
    button.disabled=false;button.querySelector("span").textContent="Build my Windows app";
    if(simulatedProgress>=100)setTimeout(resetProgress,1100);else resetProgress();
    window.turnstile?.reset?.();renderFiles();
  }
});
renderFiles();
