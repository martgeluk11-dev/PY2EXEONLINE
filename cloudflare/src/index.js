export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Job-Token",
      "Access-Control-Expose-Headers": "Content-Disposition",
    };
    const reply = (body, status=200, headers={}) =>
      new Response(body, {status, headers:{...cors,...headers}});
    if (request.method === "OPTIONS") return reply(null, 204);
    try {
      if (url.pathname === "/api/convert" && request.method === "POST") {
        const form = await request.formData();
        const captcha = String(form.get("cf-turnstile-response") || "");
        if (!env.TURNSTILE_SECRET || !captcha) return reply(JSON.stringify({detail:"Please complete the security check first."}),403,{"Content-Type":"application/json"});
        const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({secret:env.TURNSTILE_SECRET,response:captcha,remoteip:request.headers.get("CF-Connecting-IP")||""})});
        const verification = await verify.json();
        if (!verification.success) return reply(JSON.stringify({detail:"Security check failed. Please try again."}),403,{"Content-Type":"application/json"});
        const files = form.getAll("files");
        const paths = form.getAll("paths").map(String);
        if (!files.length || files.length !== paths.length || files.length > 150)
          return reply(JSON.stringify({detail:"Invalid project files."}),400,{"Content-Type":"application/json"});
        const entry = String(form.get("entry_file") || "");
        if (!paths.includes(entry) || !entry.toLowerCase().endsWith(".py"))
          return reply(JSON.stringify({detail:"Choose an uploaded .py entry file."}),400,{"Content-Type":"application/json"});
        let total=0;
        const clean=[];
        for(let i=0;i<files.length;i++){
          const f=files[i]; const p=paths[i].replace(/\\/g,"/");
          if (!(f instanceof File) || !p || p.startsWith("/") || p.split("/").some(x=>!x || x==="." || x==="..") || /^[A-Za-z]:/.test(p))
            return reply(JSON.stringify({detail:"Invalid project path."}),400,{"Content-Type":"application/json"});
          total+=f.size;
          if(f.size>80*1024*1024 || total>80*1024*1024)
            return reply(JSON.stringify({detail:"Cloud build upload limit is 80 MB total."}),413,{"Content-Type":"application/json"});
          clean.push({file:f,path:p});
        }
        const id=crypto.randomUUID();
        const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,"0")).join("");
        const meta={id,token,created:Date.now(),status:"queued",entry_file:entry,
          app_name:String(form.get("app_name")||"my_app").slice(0,48).replace(/[^A-Za-z0-9_-]/g,"_"),
          build_type:form.get("build_type")==="folder"?"folder":"onefile",
          console:String(form.get("console")||"true")==="true",
          icon_path:String(form.get("icon_path")||"")};
        for(let i=0;i<clean.length;i++){
          const key="jobs/"+id+"/files/"+clean[i].path;
          await env.BUILDS.put(key,clean[i].file.stream(),{httpMetadata:{contentType:clean[i].file.type||"application/octet-stream"}});
        }
        await env.BUILDS.put("jobs/"+id+"/meta.json",JSON.stringify(meta));
        const dispatch=await fetch("https://api.github.com/repos/"+env.GITHUB_REPO+"/dispatches",{
          method:"POST",
          headers:{Authorization:"Bearer "+env.GITHUB_TOKEN,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","Content-Type":"application/json","User-Agent":"Py2EXE-Online"},
          body:JSON.stringify({event_type:"py2exe-build",client_payload:{job_id:id,job_token:token,worker_url:url.origin}})
        });
        if(!dispatch.ok){
          await env.BUILDS.put("jobs/"+id+"/meta.json",JSON.stringify({...meta,status:"failed",error:"Could not start GitHub Actions. Check repository Actions permissions and Worker secrets."}));
          return reply(JSON.stringify({detail:"Could not start the Windows build. Check GitHub Actions setup."}),502,{"Content-Type":"application/json"});
        }
        return reply(JSON.stringify({job_id:id}),202,{"Content-Type":"application/json"});
      }
      const statusMatch=url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)$/i);
      if(statusMatch && request.method==="GET"){
        const meta=await env.BUILDS.get("jobs/"+statusMatch[1]+"/meta.json");
        if(!meta)return reply(JSON.stringify({detail:"Build not found."}),404,{"Content-Type":"application/json"});
        const m=await meta.json();
        return reply(JSON.stringify({status:m.status,error:m.error||null,filename:m.filename||null}),200,{"Content-Type":"application/json"});
      }
      const downloadMatch=url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)\/download$/i);
      if(downloadMatch && request.method==="GET"){
        const metaObj=await env.BUILDS.get("jobs/"+downloadMatch[1]+"/meta.json");
        if(!metaObj)return reply("Build not found",404);
        const meta=await metaObj.json();
        if(meta.status!=="completed")return reply("Build is not ready",409);
        const obj=await env.BUILDS.get("jobs/"+downloadMatch[1]+"/result");
        if(!obj)return reply("Build result missing",404);
        return new Response(obj.body,{headers:{...cors,"Content-Type":meta.filename.endsWith(".zip")?"application/zip":"application/vnd.microsoft.portable-executable","Content-Disposition":'attachment; filename="'+meta.filename.replace(/["\\]/g,"")+'"',"Cache-Control":"no-store"}});
      }
      if(url.pathname.startsWith("/internal/")){
        const auth=request.headers.get("Authorization")||"";
        const match=url.pathname.match(/^\/internal\/jobs\/([a-f0-9-]+)\/(manifest|file|result|fail)$/i);
        if(!match)return reply("Not found",404);
        const metaObj=await env.BUILDS.get("jobs/"+match[1]+"/meta.json");
        if(!metaObj)return reply("Not found",404);
        const meta=await metaObj.json();
        if(auth!=="Bearer "+meta.token || auth!=="Bearer "+(request.headers.get("X-Job-Token")||meta.token))
          return reply("Unauthorized",401);
        if(match[2]==="manifest" && request.method==="GET"){
          const list=await env.BUILDS.list({prefix:"jobs/"+match[1]+"/files/"});
          return reply(JSON.stringify({metadata:{entry_file:meta.entry_file,app_name:meta.app_name,build_type:meta.build_type,console:meta.console,icon_path:meta.icon_path},files:list.objects.map(o=>o.key.slice(("jobs/"+match[1]+"/files/").length))}),200,{"Content-Type":"application/json"});
        }
        if(match[2]==="file" && request.method==="GET"){
          const p=url.searchParams.get("path")||"";
          if(!p || p.startsWith("/") || p.split("/").some(x=>!x||x==="."||x===".."))return reply("Bad path",400);
          const obj=await env.BUILDS.get("jobs/"+match[1]+"/files/"+p);
          return obj?new Response(obj.body,{headers:cors}):reply("Not found",404);
        }
        if(match[2]==="result" && request.method==="POST"){
          const filename=(request.headers.get("X-File-Name")||"build.exe").replace(/[^A-Za-z0-9_.-]/g,"_");
          await env.BUILDS.put("jobs/"+match[1]+"/result",request.body);
          await env.BUILDS.put("jobs/"+match[1]+"/meta.json",JSON.stringify({...meta,status:"completed",filename,token:meta.token}));
          return reply("ok");
        }
        if(match[2]==="fail" && request.method==="POST"){
          const body=await request.json().catch(()=>({}));
          await env.BUILDS.put("jobs/"+match[1]+"/meta.json",JSON.stringify({...meta,status:"failed",error:String(body.error||"Build failed").slice(0,3000)}));
          return reply("ok");
        }
      }
      return reply("Not found",404);
    } catch(e) {
      return reply(JSON.stringify({detail:e.message||"Worker error"}),500,{"Content-Type":"application/json"});
    }
  }
};