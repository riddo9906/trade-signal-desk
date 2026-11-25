import http from 'node:http';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {ApiError,parseQuery,createMarketData} from './api/market-data.mjs';
import {createCompanion,makeBrief} from './api/companion.mjs';
import {createBuddy} from './api/buddy.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
export function createApp({fetchImpl=fetch,apiKey='',dataDirectory=path.join(root,'data'),now=Date.now,modelUrl=process.env.PIP_MODEL_URL||'http://127.0.0.1:8000/v1/chat/completions',model=process.env.PIP_MODEL||'local'}={}) {
  const service=createMarketData({fetchImpl,apiKey,now,async persist(q,rows){
    await mkdir(dataDirectory,{recursive:true});
    const name=Buffer.from(`${q.provider}:${q.symbol}:${q.interval}`).toString('hex');
    const target=path.join(dataDirectory,name+'.json');
    let old=[];
    try {old=JSON.parse(await readFile(target,'utf8')).candles;}catch(e){if(e.code!=='ENOENT')throw e;}
    const merged=new Map(old.map(r=>[r.t,r]));rows.forEach(r=>merged.set(r.t,r));
    const record={...q,collectedAt:new Date(now()).toISOString(),candles:[...merged.values()].sort((a,b)=>a.t-b.t).slice(-10000)};
    await writeFile(target+'.tmp',JSON.stringify(record));await rename(target+'.tmp',target);
  }});
  const companion=createCompanion({workspace:path.dirname(root),root,tradingStatus:()=>service.status(),fetchImpl,clock:now});
  const buddy=createBuddy({dataDirectory,companion,fetchImpl,now,modelUrl,model});
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    const json=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
    try {
      // Bind locally and reject foreign Host headers to prevent DNS rebinding.
      const host=req.headers.host||'';
      if(!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return json(403,{error:{code:'HOST_REJECTED',message:'Use the local application address.'}});
      const url=new URL(req.url,'http://localhost');
      if(url.pathname.startsWith('/api/')) {
        if(req.headers.origin&&req.headers.origin!==`http://${host}`)return json(403,{error:{code:'ORIGIN_REJECTED',message:'Open the dashboard from its local server.'}});
        if(req.method==='POST'&&['/api/buddy/chat','/api/buddy/update'].includes(url.pathname)){
          if(req.headers['sec-fetch-site']==='cross-site')return json(403,{error:{code:'ORIGIN_REJECTED',message:'Local requests only.'}});
          if(!req.headers['content-type']?.startsWith('application/json'))return json(415,{error:{code:'JSON_REQUIRED',message:'Send JSON.'}});
          let chunks=[],length=0;
          for await(const chunk of req){length+=chunk.length;if(length>12000)throw new ApiError(413,'BODY_TOO_LARGE','Message is too large.');chunks.push(chunk);}
          const raw=Buffer.concat(chunks).toString('utf8');
          let body;try{body=JSON.parse(raw);}catch{throw new ApiError(400,'INVALID_JSON','Invalid JSON request.');}
          if(!body||typeof body!=='object'||Array.isArray(body))throw new ApiError(400,'INVALID_JSON','Send a JSON object.');
          return json(200,url.pathname.endsWith('/chat')?await buddy.chat(body.message):await buddy.update(body.action,body.id));
        }
        if(!['GET','HEAD'].includes(req.method)){res.setHeader('Allow','GET, HEAD');return json(405,{error:{code:'METHOD_NOT_ALLOWED',message:'Method not allowed.'}});}
        if(url.pathname==='/api/health')return json(200,{ok:true,...service.status()});
        if(url.pathname==='/api/buddy')return json(200,await buddy.state());
        if(url.pathname==='/api/buddy/brief'){
          const brief=await buddy.brief();res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':'attachment; filename="pip-handoff.md"','Cache-Control':'no-store'});return res.end(brief);
        }
        if(url.pathname==='/api/companion')return json(200,await companion.snapshot());
        if(url.pathname==='/api/companion/brief'){
          const snapshot=await companion.snapshot();
          res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':'attachment; filename="niblit-pulse-brief.md"','Cache-Control':'no-store'});
          return res.end(makeBrief(snapshot));
        }
        if(url.pathname==='/api/candles')return json(200,await service.get(parseQuery(url.searchParams)));
        return json(404,{error:{code:'NOT_FOUND',message:'Unknown API endpoint.'}});
      }
      if(!['GET','HEAD'].includes(req.method)){res.setHeader('Allow','GET, HEAD');return json(405,{error:{code:'METHOD_NOT_ALLOWED',message:'Method not allowed.'}});}
      const assets={'/':['index.html','text/html; charset=utf-8'],'/index.html':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8'],'/companion':['companion.html','text/html; charset=utf-8'],'/companion.js':['companion.js','text/javascript; charset=utf-8'],'/buddy-ui.js':['buddy-ui.js','text/javascript; charset=utf-8'],'/companion.css':['companion.css','text/css; charset=utf-8']};
      const asset=assets[url.pathname];if(!asset){res.writeHead(404);return res.end('Not found');}
      const content=await readFile(path.join(root,'dist',asset[0]));res.writeHead(200,{'Content-Type':asset[1],'Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:content);
    } catch(e) {const err=e instanceof ApiError?e:new ApiError(500,'INTERNAL_ERROR','The server could not complete the request.');json(err.status,{error:{code:err.code,message:err.message}});}
  });
  return {server,service};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT||8765);
  const {server,service}=createApp({apiKey:process.env.TWELVE_DATA_API_KEY||'',dataDirectory:path.resolve(root,process.env.DATA_DIRECTORY||'data')});
  server.listen(port,'127.0.0.1',()=>{
    console.log(`Signal Desk: http://127.0.0.1:${port}`);
    const watchlist=(process.env.WATCHLIST||'kraken:XBTUSD:60').split(',').slice(0,12);
    for(const item of watchlist) {try{const [provider,symbol,interval]=item.trim().split(':');const q=parseQuery(new URLSearchParams({provider,symbol,interval}));service.get(q).catch(e=>console.log(`Collector: ${q.symbol} — ${e.code}`));}catch{console.log('Collector: invalid WATCHLIST entry');}}
  });
  const timer=setInterval(()=>service.refresh(),60000);timer.unref();
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(timer);server.close(()=>process.exit(0));});
}
