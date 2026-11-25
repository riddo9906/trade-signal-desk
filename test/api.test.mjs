import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createMarketData,parseQuery,normalizeTwelve} from '../api/market-data.mjs';
import {createApp} from '../server.mjs';
const start=Date.UTC(2026,9,20);
const rows=Array.from({length:81},(_,i)=>[(start+i*3600000)/1000,'100','102','99','101','100','5',10]);
const q={provider:'kraken',symbol:'XBTUSD',interval:60};
const ok=()=>Response.json({error:[],result:{XXBTZUSD:rows,last:1}});
test('drops open candle, deduplicates concurrent requests and caches within a minute',async()=>{
 let calls=0,saves=0;const service=createMarketData({now:()=>start+81*3600000,fetchImpl:async()=>{calls++;return ok()},persist:async()=>saves++});
 const [a,b]=await Promise.all([service.get(q),service.get(q)]);
 assert.equal(a.candles.length,80);assert.equal(a.candles.at(-1).t,start+79*3600000);assert.deepEqual(a,b);assert.equal(calls,1);assert.equal(saves,1);
 assert.equal((await service.get(q)).cached,true);assert.equal(calls,1);
});
test('failed refresh never returns cached data as fresh and automatically retries',async()=>{
 let time=start+81*3600000,fail=false,calls=0;const service=createMarketData({now:()=>time,fetchImpl:async()=>{calls++;if(fail)throw Error('private upstream URL');return ok()}});
 await service.get(q);time+=61000;fail=true;await assert.rejects(service.get(q),{code:'FEED_UNREACHABLE'});
 await assert.rejects(service.get(q));assert.equal(calls,2);
 time+=61000;fail=false;await service.refresh();assert.equal(calls,3);assert.equal(service.status().subscriptions[0].error,null);
});
test('initial provider outage remains subscribed and recovers on background refresh',async()=>{
 let time=start+81*3600000,fail=true;const s=createMarketData({now:()=>time,fetchImpl:async()=>{if(fail)throw Error();return ok()}});
 await assert.rejects(s.get(q));assert.equal(s.status().subscriptions.length,1);time+=61000;fail=false;await s.refresh();assert.ok(s.status().subscriptions[0].fetchedAt);
});
test('validates query and does not fetch without a server key',async()=>{
 assert.throws(()=>parseQuery(new URLSearchParams('provider=evil&symbol=AAPL')),{code:'INVALID_QUERY'});
 assert.throws(()=>parseQuery(new URLSearchParams('interval=2')));
 const service=createMarketData({fetchImpl:()=>assert.fail('must not fetch')});
 await assert.rejects(service.get({...q,provider:'twelve'}),{code:'KEY_REQUIRED'});
});
test('Twelve intraday includes most recent completed bar but filters open bars; daily excludes newest session',()=>{
 const values=[{datetime:'2026-10-20 03:00:00',open:'1',high:'2',low:'1',close:'2'},{datetime:'2026-10-20 02:00:00',open:'1',high:'2',low:'1',close:'2'}];
 const normalized=normalizeTwelve({values},60,start+3.5*3600000);assert.equal(normalized.length,1);assert.equal(normalized[0].t,start+2*3600000);
 const daily=normalizeTwelve({values:values.map((r,i)=>({...r,datetime:'2026-10-'+(21-i)}))},1440,start+3.5*3600000);assert.equal(daily.length,1);assert.equal(daily[0].t,start);
});
test('HTTP serves dashboard, protects secrets, persists data, handles validation and methods',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'signal-api-'));const {server}=createApp({dataDirectory:dir,now:()=>start+81*3600000,fetchImpl:async()=>ok(),apiKey:'test-secret'});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try {
  assert.equal((await fetch(base)).status,200);
  let health=await (await fetch(base+'/api/health')).text();assert.ok(!health.includes('test-secret'));assert.equal(JSON.parse(health).twelveConfigured,true);
  let res=await fetch(base+'/api/candles');assert.equal(res.status,200);assert.equal((await res.json()).candles.length,80);
  await fetch(base+'/api/candles');let files=await readdir(dir);assert.equal(files.length,1);let disk=JSON.parse(await readFile(path.join(dir,files[0]),'utf8'));assert.equal(disk.candles.length,80);
  assert.equal((await fetch(base+'/api/candles?interval=bad')).status,400);
  assert.equal((await fetch(base+'/api/candles',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/.env')).status,404);
  assert.equal((await fetch(base+'/api/health',{headers:{Origin:'https://foreign.example'}})).status,403);
 } finally {await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
test('invalid OHLC and limited subscriptions return explicit errors',async()=>{
 const service=createMarketData({now:()=>start+81*3600000,maxSubscriptions:1,fetchImpl:async()=>ok()});await service.get(q);
 await assert.rejects(service.get({...q,symbol:'ETHUSD'}),{code:'SUBSCRIPTION_LIMIT'});
 const bad=createMarketData({now:()=>start+81*3600000,fetchImpl:async()=>Response.json({error:[],result:{pair:rows.map(r=>[...r.slice(0,3),'200',...r.slice(4)])}})});
 await assert.rejects(bad.get(q),{code:'INVALID_DATA'});
});
