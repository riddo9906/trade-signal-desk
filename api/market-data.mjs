const intervals = new Map([[15,'15min'],[60,'1h'],[240,'4h'],[1440,'1day']]);
export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status=status; this.code=code; }
}
export function parseQuery(params) {
  const provider=params.get('provider')||'kraken';
  const symbol=(params.get('symbol')||'XBTUSD').trim().toUpperCase();
  const interval=Number(params.get('interval')||60);
  if(!['kraken','twelve'].includes(provider)||!intervals.has(interval)||!symbol||symbol.length>40||!/^[A-Z0-9/^.:_-]+$/.test(symbol))
    throw new ApiError(400,'INVALID_QUERY','Use a supported provider, symbol and timeframe (15, 60, 240 or 1440 minutes).');
  return {provider,symbol,interval};
}
export function validateCandles(rows) {
  if(rows.length<60) throw new ApiError(502,'INSUFFICIENT_DATA','The provider returned fewer than 60 completed candles.');
  for(let i=0;i<rows.length;i++) {
    const r=rows[i];
    if(![r.t,r.o,r.h,r.l,r.c,r.v].every(Number.isFinite)||r.t<=0||r.l<=0||r.v<0||r.h<Math.max(r.o,r.c,r.l)||r.l>Math.min(r.o,r.c)||(i&&r.t<=rows[i-1].t))
      throw new ApiError(502,'INVALID_DATA','The provider returned invalid or duplicate candle data.');
  }
  return rows;
}
// Daily candles are exchange-session dates, not UTC intraday timestamps.
// Exclude the newest daily row conservatively; do not infer exchange close hours.
export function normalizeTwelve(body, interval, now) {
  if(!Array.isArray(body.values)) throw new ApiError(502,'PROVIDER_ERROR','No candles returned. Check symbol coverage and your provider plan.');
  let values=body.values.slice().sort((a,b)=>a.datetime.localeCompare(b.datetime));
  if(interval===1440) values=values.slice(0,-1);
  return values.map(r=>({
    t:Date.parse(r.datetime.length===10?r.datetime+'T00:00:00Z':r.datetime.replace(' ','T')+'Z'),
    o:Number(r.open),h:Number(r.high),l:Number(r.low),c:Number(r.close),v:Number(r.volume??0)
  })).filter(r=>interval===1440||r.t+interval*60000<=now);
}
export function createMarketData({fetchImpl=fetch,now=Date.now,apiKey='',persist=async()=>{},maxSubscriptions=12}={}) {
  const cache=new Map(),pending=new Map(),failures=new Map(),subscriptions=new Map();
  let twelveNext=0;
  const ttl=60000;
  function key(q){return `${q.provider}:${q.symbol}:${q.interval}`;}
  async function upstream(url) {
    let response;
    try {response=await fetchImpl(url,{signal:AbortSignal.timeout(12000),headers:{Accept:'application/json'}});}
    catch {throw new ApiError(502,'FEED_UNREACHABLE','Cannot reach the market-data provider. Try again shortly.');}
    if(!response.ok) throw new ApiError(response.status===429?429:502,'PROVIDER_HTTP','Market-data provider is unavailable or rate limited.');
    try {return await response.json();} catch {throw new ApiError(502,'PROVIDER_RESPONSE','Market-data provider returned an unreadable response.');}
  }
  async function collect(q) {
    if(q.provider==='twelve'&&!apiKey) throw new ApiError(503,'KEY_REQUIRED','Twelve Data is not configured. Add TWELVE_DATA_API_KEY to the server .env file and restart.');
    let rows,meta={};
    if(q.provider==='kraken') {
      const url=new URL('https://api.kraken.com/0/public/OHLC');
      url.searchParams.set('pair',q.symbol);url.searchParams.set('interval',q.interval);
      const body=await upstream(url);
      if(body.error?.length) throw new ApiError(502,'PROVIDER_ERROR','Kraken rejected this market request. Check the symbol or try later.');
      const raw=Object.values(body.result||{}).find(Array.isArray);
      if(!raw) throw new ApiError(502,'NO_DATA','Kraken returned no candles.');
      rows=raw.slice(0,-1).map(r=>({t:Number(r[0])*1000,o:Number(r[1]),h:Number(r[2]),l:Number(r[3]),c:Number(r[4]),v:Number(r[6])})).filter(r=>r.t+q.interval*60000<=now());
    } else {
      // Serialize provider starts to avoid bursts on basic plans.
      if(now()<twelveNext) throw new ApiError(429,'RATE_LIMIT','Please wait before requesting another Twelve Data market.');
      twelveNext=now()+15000;
      const url=new URL('https://api.twelvedata.com/time_series');
      for(const [k,v] of Object.entries({symbol:q.symbol,interval:intervals.get(q.interval),outputsize:200,timezone:'UTC',apikey:apiKey})) url.searchParams.set(k,v);
      const body=await upstream(url);
      if(body.status==='error') throw new ApiError(body.code===429?429:502,'PROVIDER_ERROR','Twelve Data rejected the request. Check key, quota, symbol and market permissions.');
      rows=normalizeTwelve(body,q.interval,now());
      meta={exchange:body.meta?.exchange||null,quoteCurrency:body.meta?.currency||null};
    }
    validateCandles(rows);
    const result={...q,...meta,candles:rows,fetchedAt:new Date(now()).toISOString(),lastClosedAt:new Date(rows.at(-1).t+q.interval*60000).toISOString(),dailySessionDates:q.provider==='twelve'&&q.interval===1440,source:q.provider==='kraken'?'Kraken public OHLC':'Twelve Data',delivery:'polled',refreshSeconds:60};
    try {await persist(q,rows);} catch {throw new ApiError(500,'STORAGE_ERROR','Data arrived but could not be saved. Check server data-directory permissions.');}
    cache.set(key(q),result);failures.delete(key(q));return result;
  }
  async function get(q) {
    const k=key(q),cached=cache.get(k),failure=failures.get(k);
    if(cached&&now()-Date.parse(cached.fetchedAt)<ttl) return {...cached,cached:true,stale:now()-cached.candles.at(-1).t>q.interval*60000*2.2};
    if(failure&&now()<failure.retryAt) throw failure.error;
    if(pending.has(k)) return pending.get(k);
    if(!subscriptions.has(k)&&subscriptions.size>=maxSubscriptions) throw new ApiError(429,'SUBSCRIPTION_LIMIT','Collector subscription limit reached. Restart the server to clear unused markets.');
    if(q.provider==='twelve'&&!apiKey) throw new ApiError(503,'KEY_REQUIRED','Twelve Data is not configured. Add TWELVE_DATA_API_KEY to the server .env file and restart.');
    subscriptions.set(k,q);
    const task=collect(q).then(data=>({...data,cached:false,stale:now()-data.candles.at(-1).t>q.interval*60000*2.2})).catch(error=>{const safe=error instanceof ApiError?error:new ApiError(502,'FEED_ERROR','Market collection failed.');failures.set(k,{error:safe,retryAt:now()+ttl});if(failures.size>100)failures.delete(failures.keys().next().value);throw safe;}).finally(()=>pending.delete(k));
    pending.set(k,task);return task;
  }
  return {get,async refresh(){for(const q of [...subscriptions.values()]) {try{await get(q);}catch{/* Status reports failures; old data is never returned as fresh. */}}},status(){return {twelveConfigured:Boolean(apiKey),refreshSeconds:60,subscriptions:[...subscriptions.values()].map(q=>({provider:q.provider,symbol:q.symbol,interval:q.interval,fetchedAt:cache.get(key(q))?.fetchedAt||null,error:failures.get(key(q))?.error.code||null}))};}};
}
