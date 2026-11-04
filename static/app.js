const $ = (id) => document.getElementById(id);
const API_BASE = window.PY2EXE_API_BASE || "https://py2exe-online.martgeluk11.workers.dev";
const fileInput = $("files"), folderInput = $("folder");
let projectFiles = [];
let format = "onefile";
let iconFile = null;
const CHUNK_SIZE = 10 * 1024 * 1024;

function addFiles(list) {
  const incoming = [...list].map(file => ({file, path:file.webkitRelativePath || file.name}));
  const map = new Map(projectFiles.map(item => [item.path,item]));
  for (const item of incoming) map.set(item.path,item);
  projectFiles = [...map.values()];
  renderFiles();
}
function renderFiles() {
  $("file-summary").hidden = projectFiles.length === 0;
  $("file-count").textContent = projectFiles.length + (projectFiles.length === 1 ? " file" : " files");
  $("file-list").innerHTML = "";
  projectFiles.slice(0,150).forEach(({file,path}) => {
    const row=document.createElement("div"); row.className="file-row";
    const name=document.createElement("span"); name.textContent=path;
    const size=document.createElement("span");
    size.textContent=file.size<1024*1024?(file.size/1024).toFixed(1)+" KB":(file.size/1024/1024).toFixed(1)+" MB";
    row.append(name,size); $("file-list").append(row);
  });
  const pyFiles=projectFiles.filter(item=>item.path.toLowerCase().endsWith(".py"));
  const select=$("entry"); select.innerHTML="";
  if(!pyFiles.length){select.add(new Option("Add at least one .py file",""));select.disabled=true;}
  else{pyFiles.forEach(item=>select.add(new Option(item.path,item.path)));select.disabled=false;}
  $("build").disabled=!pyFiles.length||projectFiles.length>150;
}
fileInput.addEventListener("change",e=>{addFiles(e.target.files);fileInput.value="";});
folderInput.addEventListener("change",e=>{addFiles(e.target.files);folderInput.value="";});
$("folder-button").addEventListener("click",()=>$("folder").click());
$("clear").addEventListener("click",()=>{projectFiles=[];renderFiles();});
const drop=$("drop");
["dragenter","dragover"].forEach(type=>drop.addEventListener(type,e=>{e.preventDefault();drop.classList.add("over");}));
["dragleave","drop"].forEach(type=>drop.addEventListener(type,e=>{e.preventDefault();drop.classList.remove("over");}));
drop.addEventListener("drop",e=>addFiles(e.dataTransfer.files));
$("formats").addEventListener("click",e=>{
  const button=e.target.closest("button[data-value]");if(!button)return;
  format=button.dataset.value;
  document.querySelectorAll(".segments button").forEach(b=>b.classList.toggle("selected",b===button));
});
$("icon").addEventListener("change",e=>{iconFile=e.target.files[0]||null;$("icon-name").textContent=iconFile?iconFile.name:"Choose an .ico file";});
function setStatus(message,error=false){$("status").textContent=message;$("status").classList.toggle("error",error);}
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
  const files=[...projectFiles];
  if(iconFile)files.push({file:iconFile,path:"__app_icon__.ico"});
  const total=files.reduce((sum,item)=>sum+item.file.size,0);
  if(total>80*1024*1024){setStatus("Your project is larger than 80 MB.",true);return;}
  const captcha=window.turnstile?.getResponse?.();
  if(!captcha){setStatus("Please complete the security check first.",true);return;}
  const button=$("build");button.disabled=true;button.querySelector("span").textContent="Uploading project…";
  $("progress").classList.add("show");
  try{
    if(API_BASE.includes("YOUR-WORKER"))throw new Error("The build service URL has not been configured yet.");
    const create=await fetch(API_BASE+"/api/jobs",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      captcha,files:files.map(item=>({path:item.path,size:item.file.size})),
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
    button.querySelector("span").textContent="Building your app…";
    setStatus("Upload complete. Waiting for a Windows build…");
    const deadline=Date.now()+12*60*1000;
    let state="queued";
    while(Date.now()<deadline){
      await new Promise(resolve=>setTimeout(resolve,2500));
      const check=await fetch(API_BASE+"/api/jobs/"+encodeURIComponent(job_id));
      if(!check.ok)throw new Error("Could not check build status.");
      const result=await check.json();state=result.status;
      if(state==="failed")throw new Error(result.error||"Windows build failed.");
      if(state==="completed"){
        setStatus("Build complete — downloading your file…");
        const download=await fetch(API_BASE+"/api/jobs/"+encodeURIComponent(job_id)+"/download");
        if(!download.ok)throw new Error("Build completed, but the download failed.");
        const blob=await download.blob(),a=document.createElement("a"),objectUrl=URL.createObjectURL(blob);
        a.href=objectUrl;a.download=result.filename||"my_app.exe";document.body.appendChild(a);a.click();a.remove();
        setTimeout(()=>URL.revokeObjectURL(objectUrl),30000);
        setStatus("Build complete — your download should have started.");break;
      }
      setStatus(state==="uploading"?"Uploading project files…":state==="queued"?"Build queued — starting a Windows machine…":state==="building"?"Windows machine is building your app…":"Windows machine is preparing your app…");
    }
    if(state!=="completed"&&state!=="failed")throw new Error("The build took too long. Please try again.");
  }catch(error){setStatus(error.message||"Something went wrong.",true);}
  finally{button.disabled=false;button.querySelector("span").textContent="Build Windows EXE";$("progress").classList.remove("show");window.turnstile?.reset?.();renderFiles();}
});
renderFiles();
