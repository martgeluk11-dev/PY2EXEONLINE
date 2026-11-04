const CHUNK = 10 * 1024 * 1024;
const TTL = 60 * 60 * 24;
const json = (data, status=200, headers={}) => new Response(JSON.stringify(data), {
  status, headers: {"Content-Type":"application/json", ...headers}
});
const cleanPath = p => typeof p === "string" && !!p && !p.startsWith("/") &&
  !p.includes("\\") && !p.split("/").some(x => !x || x === "." || x === "..") &&
  !/^[A-Za-z]:/.test(p);
const metaKey = id => "jobs/" + id + "/meta";
const fileKey = (id, path, part) => "jobs/" + id + "/f/" + encodeURIComponent(path) + "/" + part;
const resultKey = (id, part) => "jobs/" + id + "/r/" + part;
const validId = id => /^[0-9a-f-]{36}$/i.test(id);
async function getMeta(env, id) {
  const raw = await env.JOBS.get(metaKey(id));
  return raw ? JSON.parse(raw) : null;
}
async function saveMeta(env, meta) {
  await env.JOBS.put(metaKey(meta.id), JSON.stringify(meta), {expirationTtl: TTL});
}
async function getEventually(env, key) {
  for (let attempt=0; attempt<20; attempt++) {
    const value=await env.JOBS.get(key,"arrayBuffer");
    if (value) return value;
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  return null;
}
async function verifyCaptcha(request, env, token) {
  if (!env.TURNSTILE_SECRET || !token) return false;
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({secret:env.TURNSTILE_SECRET,response:token,remoteip:request.headers.get("CF-Connecting-IP")||""})
  });
  return (await response.json()).success === true;
}
function authorized(request, meta) {
  return (request.headers.get("Authorization") || "") === "Bearer " + meta.token;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin":"*",
      "Access-Control-Allow-Methods":"GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":"Content-Type, Authorization",
      "Access-Control-Expose-Headers":"Content-Disposition"
    };
    const reply = (body, status=200, headers={}) => new Response(body, {status,headers:{...cors,...headers}});
    if (request.method === "OPTIONS") return reply(null,204);
    try {
      if (!env.JOBS) return reply("Missing KV binding: JOBS",500);
      if (url.pathname === "/api/jobs" && request.method === "POST") {
        const body = await request.json();
        if (!await verifyCaptcha(request,env,String(body.captcha||"")))
          return json({detail:"Security check failed. Please try again."},403,cors);
        const files = body.files;
        if (!Array.isArray(files) || !files.length || files.length > 150)
          return json({detail:"Add between 1 and 150 project files."},400,cors);
        let total = 0;
        const seen = new Set();
        for (const file of files) {
          if (!cleanPath(file.path) || seen.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0)
            return json({detail:"Invalid project file list."},400,cors);
          seen.add(file.path);
          total += file.size;
        }
        if (total > 80*1024*1024) return json({detail:"Maximum project upload is 80 MB."},413,cors);
        const entry = String(body.entry_file||"");
        if (!seen.has(entry) || !entry.toLowerCase().endsWith(".py"))
          return json({detail:"Choose an uploaded .py entry file."},400,cors);
        const id = crypto.randomUUID();
        const token = Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,"0")).join("");
        const meta = {
          id, token, created:Date.now(), status:"uploading",
          files:files.map(f=>({path:f.path,size:f.size,chunks:Math.max(1,Math.ceil(f.size/CHUNK))})),
          entry_file:entry,
          app_name:String(body.app_name||"my_app").slice(0,48).replace(/[^A-Za-z0-9_-]/g,"_"),
          build_type:body.build_type==="folder"?"folder":"onefile",
          console:body.console !== false,
          icon_path:String(body.icon_path||"")
        };
        if (meta.icon_path && !seen.has(meta.icon_path)) return json({detail:"Icon file is missing."},400,cors);
        await saveMeta(env,meta);
        return json({job_id:id,upload_token:token,chunk_size:CHUNK},201,cors);
      }
      let match = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/files$/i);
      if (match && request.method === "POST") {
        const meta = await getMeta(env,match[1]);
        if (!meta || meta.status !== "uploading") return reply("Upload session not found",404);
        if (!authorized(request,meta)) return reply("Unauthorized",401);
        const path = url.searchParams.get("path") || "";
        const part = Number(url.searchParams.get("part"));
        const file = meta.files.find(f=>f.path===path);
        if (!file || !Number.isInteger(part) || part < 0 || part >= file.chunks) return reply("Invalid file chunk",400);
        const bytes = await request.arrayBuffer();
        const expected = part === file.chunks-1 ? file.size - part*CHUNK : CHUNK;
        if (bytes.byteLength !== expected) return reply("Chunk size mismatch",400);
        await env.JOBS.put(fileKey(meta.id,path,part),bytes,{expirationTtl:TTL});
        return reply("ok");
      }
      match = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/start$/i);
      if (match && request.method === "POST") {
        const meta = await getMeta(env,match[1]);
        if (!meta) return reply("Job not found",404);
        if (!authorized(request,meta)) return reply("Unauthorized",401);
        if (meta.status !== "uploading") return reply("Build already started",409);
        for (const file of meta.files) for (let i=0;i<file.chunks;i++) {
          if (await env.JOBS.get(fileKey(meta.id,file.path,i),"arrayBuffer") === null)
            return json({detail:"An upload chunk is missing. Please retry."},400,cors);
        }
        const wait = 1100 - (Date.now() - meta.created);
        if (wait > 0) await new Promise(resolve=>setTimeout(resolve,wait));
        meta.status = "queued";
        await saveMeta(env,meta);
        const dispatch = await fetch("https://api.github.com/repos/"+env.GITHUB_REPO+"/dispatches",{
          method:"POST",
          headers:{Authorization:"Bearer "+env.GITHUB_TOKEN,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","Content-Type":"application/json","User-Agent":"Py2EXE-Online"},
          body:JSON.stringify({event_type:"py2exe-build",client_payload:{job_id:meta.id,job_token:meta.token,worker_url:url.origin}})
        });
        if (!dispatch.ok) {
          meta.status="failed"; meta.error="Could not start GitHub Actions. Check repository Actions permissions and Worker secrets.";
          await saveMeta(env,meta);
          return json({detail:"Could not start the Windows build. Check GitHub Actions setup."},502,cors);
        }
        return reply("ok",202);
      }
      match = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)$/i);
      if (match && request.method === "GET") {
        const meta = await getMeta(env,match[1]);
        if (!meta) return json({detail:"Build not found."},404,cors);
        return json({status:meta.status,error:meta.error||null,filename:meta.filename||null},200,cors);
      }
      match = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/download$/i);
      if (match && request.method === "GET") {
        const meta = await getMeta(env,match[1]);
        if (!meta) return reply("Build not found",404);
        if (meta.status !== "completed") return reply("Build is not ready",409);
        const stream = new ReadableStream({
          async start(controller) {
            try {
              for (let i=0;i<meta.result_chunks;i++) {
                const part = await getEventually(env,resultKey(meta.id,i));
                if (!part) throw new Error("A result chunk is missing");
                controller.enqueue(new Uint8Array(part));
              }
              controller.close();
            } catch (e) { controller.error(e); }
          }
        });
        const filename = (meta.filename||"build.exe").replace(/["\\]/g,"");
        return new Response(stream,{headers:{...cors,"Content-Type":filename.endsWith(".zip")?"application/zip":"application/vnd.microsoft.portable-executable","Content-Disposition":'attachment; filename="'+filename+'"',"Cache-Control":"no-store"}});
      }
      match = url.pathname.match(/^\/internal\/jobs\/([0-9a-f-]+)\/(manifest|file|result|complete|fail)$/i);
      if (match) {
        const meta = await getMeta(env,match[1]);
        if (!meta) return reply("Job not found",404);
        if (!authorized(request,meta)) return reply("Unauthorized",401);
        const action = match[2];
        if (action === "manifest" && request.method === "GET") {
          return json({metadata:{entry_file:meta.entry_file,app_name:meta.app_name,build_type:meta.build_type,console:meta.console,icon_path:meta.icon_path},files:meta.files});
        }
        if (action === "file" && request.method === "GET") {
          const path = url.searchParams.get("path")||"";
          const part = Number(url.searchParams.get("part"));
          const file = meta.files.find(f=>f.path===path);
          if (!file || !Number.isInteger(part) || part<0 || part>=file.chunks) return reply("Bad file chunk",400);
          const data = await env.JOBS.get(fileKey(meta.id,path,part),"arrayBuffer");
          return data ? new Response(data,{headers:cors}) : reply("Not found",404);
        }
        if (action === "result" && request.method === "POST") {
          const part = Number(url.searchParams.get("part"));
          const total = Number(url.searchParams.get("total"));
          if (!Number.isInteger(part)||!Number.isInteger(total)||total<1||total>16||part<0||part>=total) return reply("Invalid result chunk",400);
          const data = await request.arrayBuffer();
          if (data.byteLength>CHUNK) return reply("Result chunk too large",413);
          await env.JOBS.put(resultKey(meta.id,part),data,{expirationTtl:TTL});
          return reply("ok");
        }
        if (action === "complete" && request.method === "POST") {
          const total=Number(url.searchParams.get("total"));
          if (!Number.isInteger(total)||total<1||total>8) return reply("Invalid result size",400);
          for(let i=0;i<total;i++) if(await env.JOBS.get(resultKey(meta.id,i),"arrayBuffer")===null) return reply("Missing result chunk",400);
          meta.result_chunks=total;
          meta.filename=(url.searchParams.get("filename")||"build.exe").replace(/[^A-Za-z0-9_.-]/g,"_");
          meta.status="completed";
          await saveMeta(env,meta);
          return reply("ok");
        }
        if (action === "fail" && request.method === "POST") {
          const body=await request.json().catch(()=>({}));
          meta.status="failed"; meta.error=String(body.error||"Build failed").slice(0,3000);
          await saveMeta(env,meta); return reply("ok");
        }
      }
      return reply("Not found",404);
    } catch(e) {
      return json({detail:e.message||"Worker error"},500,cors);
    }
  }
};