import os from 'node:os';
import path from 'node:path';
import {stat,statfs} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);

const serviceTargets=[
  {id:'niblit',name:'Niblit core',url:'http://127.0.0.1:5000/health'},
  {id:'inference',name:'Niblit inference',url:'http://127.0.0.1:8000/health'}
];
const repoNames=['Niblit','Niblit-cloud-server','niblit-ui','niblit-lean-algos'];
const cpuTotals=()=>os.cpus().reduce((sum,c)=>({idle:sum.idle+c.times.idle,total:sum.total+Object.values(c.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0});
export async function probeHealth(target,fetchImpl=fetch) {
  const start=performance.now();
  try {
    const res=await fetchImpl(target.url,{signal:AbortSignal.timeout(2000),redirect:'error',headers:{Accept:'application/json'}});
    let body={};
    // Health bodies are intentionally bounded; never expose raw payloads or errors.
    if(res.body){const reader=res.body.getReader();let length=0,chunks=[];try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>65536){await reader.cancel();break}chunks.push(value)}if(length<=65536)body=JSON.parse(Buffer.concat(chunks).toString());}catch{}finally{reader.releaseLock()}}
    const reported=typeof body.status==='string'?body.status.toLowerCase():null;
    const degraded=body.inference_ready===false||body.ready===false||body.api_ready===false||['degraded','error','unhealthy','failed','not_ready'].includes(reported);
    const known=body.inference_ready===true||body.ready===true||body.api_ready===true||['ready','ok','healthy','running','online'].includes(reported);
    return {...target,state:!res.ok||degraded?'attention':known?'ready':'unverified',httpStatus:res.status,inferenceReady:typeof body.inference_ready==='boolean'?body.inference_ready:null,latencyMs:Math.round(performance.now()-start)};
  } catch {return {...target,state:'unreachable',httpStatus:null,inferenceReady:null,latencyMs:Math.round(performance.now()-start)};}
}
async function repository(workspace,name){
  const dir=path.join(workspace,name);
  try{await stat(path.join(dir,'.git'));}catch{return {name,state:'missing',branch:null,changedTrackedFiles:null};}
  try{
    const options={cwd:dir,windowsHide:true,timeout:3000,maxBuffer:1024*1024};
    const [branch,changes,revision]=await Promise.all([
      exec('git',['branch','--show-current'],options),exec('git',['status','--porcelain=v1','-uno'],options),exec('git',['rev-parse','--short','HEAD'],options)
    ]);
    return {name,state:'available',branch:branch.stdout.trim()||'detached',revision:revision.stdout.trim(),changedTrackedFiles:changes.stdout.split(/\r?\n/).filter(Boolean).length};
  }catch{return {name,state:'unavailable',branch:null,changedTrackedFiles:null};}
}
export function buildActions(snapshot){
  const actions=[];
  if(!snapshot.trading.twelveConfigured)actions.push({priority:'setup',title:'Connect forex, gold and equities',detail:'Add a Twelve Data key in the server .env file. The key stays on this PC.'});
  for(const service of snapshot.services)if(service.state!=='ready')actions.push({priority:'check',title:`Check ${service.name}`,detail:service.state==='unreachable'?`No response from ${service.url}. It may be stopped or using a different port.`:'The endpoint responded, but readiness was not confirmed. Check its own diagnostics before using it.'});
  if(snapshot.pc.memory.usedPercent>=85)actions.unshift({priority:'attention',title:'Memory is under pressure',detail:'Close unused applications or reduce the number of loaded local models.'});
  if(snapshot.pc.disk&&snapshot.pc.disk.freePercent<10)actions.unshift({priority:'attention',title:'Storage is running low',detail:'Review model files and old downloads. Back up anything important before removing it.'});
  if(snapshot.trading.subscriptions.some(s=>s.error))actions.push({priority:'check',title:'Check a market-data subscription',detail:'One or more collector requests failed. Review the feed status before using a trading signal.'});
  actions.push({priority:'research',title:'Validate the trading strategy',detail:'Backtest with spread, fees and slippage, then paper trade. No strategy performance has been established.'});
  return actions;
}
export function makeBrief(s){
 return ['# Niblit Pulse · local handoff',`Observed: ${s.observedAt}`,'','## PC',`CPU usage: ${s.pc.cpuPercent===null?'sampling':s.pc.cpuPercent+'%'}; memory: ${s.pc.memory.usedPercent}% used; uptime: ${Math.floor(s.pc.uptimeSeconds/3600)}h.`,s.pc.disk?`Disk: ${Math.round(s.pc.disk.freeBytes/1024**3)} GiB free.`:'Disk measurement unavailable.','','## Services',...s.services.map(x=>`- ${x.name}: ${x.state}${x.inferenceReady===null?'':'; inference ready: '+x.inferenceReady}`),'','## Trading',`Twelve Data key configured: ${s.trading.twelveConfigured?'yes':'no'}. Subscriptions: ${s.trading.subscriptions.length}.`,...s.trading.subscriptions.map(x=>`- ${x.provider} ${x.symbol} ${x.interval}m: ${x.error||'last collection '+(x.fetchedAt||'not yet collected')}`),'','## Repositories',...s.repositories.map(x=>`- ${x.name}: ${x.state}; branch ${x.branch||'unknown'}; changed tracked files: ${x.changedTrackedFiles??'unknown'}`),'','## Next checks',...s.actions.map(x=>`- ${x.title}: ${x.detail}`),'','This is an observed snapshot, not an instruction or proof of trading profitability. No chat history, credentials, file contents or raw health payloads are included. Nothing is automatically sent to an assistant or Niblit.'].join('\n');
}
export function createCompanion({workspace,root,tradingStatus,fetchImpl=fetch,clock=Date.now}={}){
 let previous=cpuTotals(),cpuPercent=null,cached=null,pending=null;
 const start=clock();
 return {async snapshot(){
   if(cached&&clock()-Date.parse(cached.observedAt)<15000)return cached;
   if(pending)return pending;
   pending=(async()=>{
     const current=cpuTotals(),elapsed=current.total-previous.total;
     if(clock()-start>500&&elapsed>0)cpuPercent=Math.round(100*(1-(current.idle-previous.idle)/elapsed));
     previous=current;
     const total=os.totalmem(),free=os.freemem();
     const [services,repositories,disk]=await Promise.all([
       Promise.all(serviceTargets.map(t=>probeHealth(t,fetchImpl))),
       Promise.all(repoNames.map(name=>repository(workspace,name))),
       statfs(root).then(d=>({totalBytes:d.blocks*d.bsize,freeBytes:d.bavail*d.bsize,freePercent:Math.round(d.bavail/d.blocks*100)})).catch(()=>null)
     ]);
     const snapshot={observedAt:new Date(clock()).toISOString(),pc:{platform:os.platform(),cpuCores:os.cpus().length,cpuPercent:cpuPercent===null?null:Math.max(0,Math.min(100,cpuPercent)),memory:{totalBytes:total,freeBytes:free,usedPercent:Math.round((1-free/total)*100)},uptimeSeconds:Math.floor(os.uptime()),disk},services,repositories,trading:tradingStatus()};
     snapshot.actions=buildActions(snapshot);cached=snapshot;return snapshot;
   })().finally(()=>pending=null);
   return pending;
 }};
}
