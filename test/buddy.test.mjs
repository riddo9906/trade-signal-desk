import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createBuddy} from '../api/buddy.mjs';
import {probeHealth,buildActions} from '../api/companion.mjs';
import {createApp} from '../server.mjs';
const snapshot={observedAt:new Date().toISOString(),pc:{cpuPercent:10,memory:{usedPercent:40},uptimeSeconds:100,disk:null},services:[{name:'Niblit core',state:'unreachable',inferenceReady:null,url:'http://127.0.0.1:8080/health'}],trading:{twelveConfigured:false,subscriptions:[]},repositories:[]};snapshot.actions=buildActions(snapshot);
const companion={snapshot:async()=>snapshot};
test('Pip learns only explicit memories, retains state, tracks tasks and forgets on request',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'pip-test-'));
 try{
  let pip=createBuddy({dataDirectory:dir,companion,fetchImpl:async()=>{throw Error()}});
  assert.equal((await pip.state()).memories.length,0);
  await Promise.all([pip.chat('Remember: My project is Niblit.'),pip.chat('Task: Test market signals.')]);
  let state=await pip.state();assert.equal(state.memories.length,1);assert.equal(state.tasks.length,1);
  await pip.chat('Remember: My project is Niblit.');assert.equal((await pip.state()).memories.length,1);
  pip=createBuddy({dataDirectory:dir,companion});assert.equal((await pip.state()).memories.length,1);
  await pip.update('complete-task',state.tasks[0].id);assert.equal((await pip.state()).progress.completedTasks,1);
  const brief=await pip.brief();assert.ok(brief.includes('My project is Niblit.'));assert.ok(!brief.includes('## Pip: open tasks\n- Test'));
  await pip.update('forget-memory',state.memories[0].id);assert.equal((await pip.state()).memories.length,0);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('Pip refuses obvious credentials, handles unavailable model, records feedback without double counting',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'pip-test-'));
 try{
  const pip=createBuddy({dataDirectory:dir,companion,fetchImpl:async()=>{throw Error('secret URL')}});
  await assert.rejects(pip.chat('Remember: api_key=private123'),{code:'SECRET_DETECTED'});assert.equal((await pip.state()).messages.length,0);
  const response=await pip.chat('Tell me a story about the moon');assert.equal(response.mode,'built-in');assert.ok(response.reply.includes('isn’t available'));
  const id=response.state.messages.at(-1).id;await pip.update('helpful',id);await pip.update('helpful',id);assert.equal((await pip.state()).feedback.helpful,1);
  await pip.update('needs-work',id);assert.deepEqual((await pip.state()).feedback,{helpful:0,needsWork:1});
  await assert.rejects(pip.update('run-command','id'),{code:'INVALID_ACTION'});
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('model endpoint is restricted to local HTTP and model text cannot perform actions',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'pip-test-'));let called=false;
 try{
  let pip=createBuddy({dataDirectory:dir,companion,modelUrl:'https://remote.example/v1/chat/completions',fetchImpl:async()=>{called=true}});
  await pip.chat('Tell me a story');assert.equal(called,false);
  pip=createBuddy({dataDirectory:dir,companion,fetchImpl:async()=>Response.json({choices:[{message:{content:'I suggest reviewing the task list.'}}]})});
  const r=await pip.chat('Tell me a story');assert.equal(r.mode,'local-model');assert.equal(r.state.tasks.length,0);assert.equal(r.state.memories.length,0);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('health distinguishes transport, degraded inference and readiness without leaking raw fields',async()=>{
 const target={id:'inference',name:'Model',url:'http://127.0.0.1:8000/health'};
 let result=await probeHealth(target,async()=>Response.json({status:'degraded',api_ready:true,inference_ready:false,password:'not-for-export'},{status:503}));
 assert.equal(result.state,'attention');assert.ok(!JSON.stringify(result).includes('not-for-export'));
 result=await probeHealth(target,async()=>Response.json({status:'ready',inference_ready:true}));assert.equal(result.state,'ready');
 result=await probeHealth(target,async()=>{throw Error()});assert.equal(result.state,'unreachable');
 result=await probeHealth(target,async()=>new Response('<html>not a health endpoint</html>'));assert.equal(result.state,'unverified');
});
test('buddy HTTP supports local JSON writes and blocks cross-origin writes and oversized bodies',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'pip-http-'));
 const {server}=createApp({dataDirectory:dir,fetchImpl:async()=>{throw Error()}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(base+'/companion')).status,200);assert.equal((await fetch(base+'/buddy-ui.js')).status,200);
  let res=await fetch(base+'/api/buddy/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'Remember: test memory'})});assert.equal(res.status,200);
  res=await fetch(base+'/api/buddy/chat',{method:'POST',headers:{Origin:'https://foreign.example','Content-Type':'application/json'},body:'{}'});assert.equal(res.status,403);
  res=await fetch(base+'/api/buddy/chat',{method:'POST',headers:{'Content-Type':'text/plain'},body:'hello'});assert.equal(res.status,415);
  res=await fetch(base+'/api/buddy/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:'['});assert.equal(res.status,400);
  res=await fetch(base+'/api/buddy/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'x'.repeat(13000)})});assert.equal(res.status,413);
  res=await fetch(base+'/api/buddy/brief');assert.equal(res.status,200);assert.ok((await res.text()).includes('test memory'));
 }finally{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true})}
});
