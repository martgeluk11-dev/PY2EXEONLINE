const $ = (id) => document.getElementById(id);
// Set this to your deployed Cloudflare Worker URL (without a trailing slash).
const API_BASE = window.PY2EXE_API_BASE || "https://YOUR-WORKER.workers.dev";
const fileInput = $("files"), folderInput = $("folder");
let projectFiles = [];
let format = "onefile";
let iconFile = null;

function addFiles(list) {
  const incoming = [...list].map(file => {
    const path = file.webkitRelativePath || file.name;
    return {file, path};
  });
  const map = new Map(projectFiles.map(item => [item.path, item]));
  for (const item of incoming) map.set(item.path, item);
  projectFiles = [...map.values()];
  renderFiles();
}
function renderFiles() {
  $("file-summary").hidden = projectFiles.length === 0;
  $("file-count").textContent = projectFiles.length + (projectFiles.length === 1 ? " file" : " files");
  $("file-list").innerHTML = "";
  projectFiles.slice(0, 150).forEach(({file,path}) => {
    const row = document.createElement("div");
    row.className = "file-row";
    const name = document.createElement("span");
    name.textContent = path;
    const size = document.createElement("span");
    size.textContent = file.size < 1024*1024 ? (file.size/1024).toFixed(1)+" KB" : (file.size/1024/1024).toFixed(1)+" MB";
    row.append(name,size);
    $("file-list").append(row);
  });
  const pyFiles = projectFiles.filter(item => item.path.toLowerCase().endsWith(".py"));
  const select = $("entry");
  select.innerHTML = "";
  if (!pyFiles.length) {
    select.add(new Option("Add at least one .py file", ""));
    select.disabled = true;
  } else {
    pyFiles.forEach((item,i) => select.add(new Option(item.path,item.path)));
    select.disabled = false;
  }
  $("build").disabled = !pyFiles.length || projectFiles.length > 150;
}
fileInput.addEventListener("change", e => { addFiles(e.target.files); fileInput.value = ""; });
folderInput.addEventListener("change", e => { addFiles(e.target.files); folderInput.value = ""; });
$("folder-button").addEventListener("click", () => folderInput.click());
$("clear").addEventListener("click", () => { projectFiles=[]; renderFiles(); });
const drop = $("drop");
["dragenter","dragover"].forEach(type => drop.addEventListener(type,e=>{e.preventDefault();drop.classList.add("over")}));
["dragleave","drop"].forEach(type => drop.addEventListener(type,e=>{e.preventDefault();drop.classList.remove("over")}));
drop.addEventListener("drop",e=>addFiles(e.dataTransfer.files));
$("formats").addEventListener("click",e=>{
  const button=e.target.closest("button[data-value]"); if(!button)return;
  format=button.dataset.value;
  document.querySelectorAll(".segments button").forEach(b=>b.classList.toggle("selected",b===button));
});
$("icon").addEventListener("change",e=>{
  iconFile=e.target.files[0]||null;
  $("icon-name").textContent=iconFile?iconFile.name:"Choose an .ico file";
});
function setStatus(message,error=false){$("status").textContent=message;$("status").classList.toggle("error",error)}
$("build").addEventListener("click",async()=>{
  if(!projectFiles.length)return;
  const data=new FormData();
  projectFiles.forEach(({file,path})=>{data.append("files",file,path);data.append("paths",path)});
  const captcha=window.turnstile?.getResponse?.();
  if(!captcha){setStatus("Please complete the security check first.",true);return;}
  data.append("cf-turnstile-response",captcha);
  data.append("entry_file",$("entry").value);
  data.append("app_name",$("appname").value||"my_app");
  data.append("build_type",format);
  data.append("console",$("console").checked?"true":"false");
  if(iconFile){
    const iconPath="__app_icon__.ico";
    data.append("files",iconFile,iconPath);
    data.append("paths",iconPath);
    data.append("icon_path",iconPath);
  }
  const button=$("build");button.disabled=true;button.querySelector("span").textContent="Building your app…";
  $("progress").classList.add("show");setStatus("Uploading project and building your Windows executable. This can take a few minutes.");
  try{
    if(API_BASE.includes("YOUR-WORKER")){throw new Error("The Cloudflare Worker URL has not been configured yet.");}
    const response=await fetch(API_BASE+"/api/convert",{method:"POST",body:data});
    if(!response.ok){
      let message=await response.text();
      try{const parsed=JSON.parse(message);message=parsed.detail||message}catch{}
      throw new Error(message);
    }
    const {job_id}=await response.json();
    if(!job_id) throw new Error("The build service did not return a job ID.");
    setStatus("Project uploaded. Waiting for a Windows build…");
    const deadline=Date.now()+12*60*1000;
    let state="queued";
    while(Date.now()<deadline){
      await new Promise(resolve=>setTimeout(resolve,2500));
      const check=await fetch(API_BASE+"/api/jobs/"+encodeURIComponent(job_id));
      if(!check.ok) throw new Error("Could not check build status.");
      const result=await check.json();
      state=result.status;
      if(state==="failed") throw new Error(result.error||"Windows build failed.");
      if(state==="completed"){
        setStatus("Build complete — downloading your file…");
        const download=await fetch(API_BASE+"/api/jobs/"+encodeURIComponent(job_id)+"/download");
        if(!download.ok) throw new Error("Build completed, but the download failed.");
        const blob=await download.blob();
        const a=document.createElement("a"),objectUrl=URL.createObjectURL(blob);
        a.href=objectUrl;a.download=result.filename||"my_app.exe";document.body.appendChild(a);a.click();a.remove();
        setTimeout(()=>URL.revokeObjectURL(objectUrl),30000);
        setStatus("Build complete — your download should have started.");
        break;
      }
      setStatus(state==="queued"?"Build queued — starting a Windows machine…":"Windows machine is building your app…");
    }
    if(state!=="completed" && state!=="failed") throw new Error("The build took too long. Please try again.");  }catch(error){setStatus(error.message||"Something went wrong.",true)}
  finally{button.disabled=false;button.querySelector("span").textContent="Build Windows EXE";$("progress").classList.remove("show");window.turnstile?.reset?.();renderFiles()}
});
renderFiles();
