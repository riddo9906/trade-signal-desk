// Loaded by companion.js through a same-origin script tag.
(()=>{
const by=id=>document.getElementById(id);let sending=false;
function element(tag,text,cls){const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e;}
async function request(url,body){const res=await fetch(url,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(40000)});const data=await res.json();if(!res.ok)throw Error(data.error?.message||'Pip is unavailable.');return data;}
async function update(action,id){try{render(await request('/api/buddy/update',{action,id}));}catch(e){by('chat-status').textContent=e.message;}}
function render(s){
 by('pip-progress').replaceChildren(...[s.progress.memories+' memories',s.progress.openTasks+' open tasks',s.progress.completedTasks+' completed'].map(x=>element('span',x)));
 by('chat').replaceChildren();if(!s.messages.length)by('chat').append(element('p','Hi, I’m Pip. Teach me one useful thing, give me a task, or ask me to check your PC.'));
 for(const m of s.messages.slice(-30)){const row=element('div','', 'chat-message '+m.role);row.append(element('span',m.role==='user'?'YOU':m.mode==='local-model'?'PIP · LOCAL NIBLIT':'PIP · BUILT-IN','speaker'),element('span',m.text));if(m.role==='assistant'){const feedback=element('div','','feedback');for(const [action,label] of [['helpful','Helpful'],['needs-work','Needs work']]){const b=element('button',label,m.feedback===action?'chosen':'');b.type='button';b.onclick=()=>update(action,m.id);feedback.append(b)}row.append(feedback)}by('chat').append(row)}by('chat').scrollTop=by('chat').scrollHeight;
 by('memories').replaceChildren();if(!s.memories.length)by('memories').append(element('p','A fresh start. No saved memories yet.'));
 for(const m of s.memories){const row=element('div','','memory'),forget=element('button','Forget');forget.type='button';forget.setAttribute('aria-label','Forget memory: '+m.text);forget.onclick=()=>update('forget-memory',m.id);row.append(element('span',m.text),forget);by('memories').append(row)}
 by('tasks').replaceChildren();if(!s.tasks.length)by('tasks').append(element('p','Add a task with “Task: …”.'));
 for(const t of s.tasks){const row=element('div','','task'+(t.done?' done':'')),done=element('button',t.done?'Reopen':'Complete');done.type='button';done.onclick=()=>update('complete-task',t.id);row.append(element('span',t.text),done);by('tasks').append(row)}
 const last=s.messages.filter(m=>m.role==='assistant').at(-1);by('pip-mode').textContent=last?.mode==='local-model'?'LOCAL NIBLIT CONVERSATION':'BUILT-IN ABILITIES';
}
async function send(message){if(sending)return;sending=true;by('send').disabled=true;by('chat-status').textContent='Pip is thinking…';try{const data=await request('/api/buddy/chat',{message});render(data.state);by('message').value='';by('chat-status').textContent='Saved locally. '+(data.mode==='local-model'?'Reply from your local Niblit model.':'Reply from Pip’s built-in abilities.');}catch(e){by('chat-status').textContent=e.message;}finally{sending=false;by('send').disabled=false;}}
by('chat-form').onsubmit=e=>{e.preventDefault();send(by('message').value)};document.querySelectorAll('[data-prompt]').forEach(b=>b.onclick=()=>send(b.dataset.prompt));request('/api/buddy').then(render).catch(e=>by('chat-status').textContent=e.message);
})();
