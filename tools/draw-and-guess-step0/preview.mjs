import { roomChatMarkup, mountRoomChat } from '/room-chat.mjs';
import { createGameAudio } from '/game-audio.mjs';
import { mountRoomSettings } from '/platform/room-settings.mjs';
import { gameViewport } from '/game-viewport.mjs';

const byId=id=>document.getElementById(id), node=(tag,text,className)=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element;};
const query=new URLSearchParams(location.search), role=['drawer','guesser-1','spectator-1'].includes(query.get('role'))?query.get('role'):'drawer';
const deviceId=crypto.randomUUID(), audio=createGameAudio();
const page=location.pathname==='/wordbank'?'bank':location.pathname==='/paint'?'paint':'start';
byId(page==='paint'?'game-page':page==='bank'?'bank-page':'start-page').hidden=false;
byId('role-select').value=role;
byId('role-select').addEventListener('change',()=>location.replace(`/paint?role=${encodeURIComponent(byId('role-select').value)}`));
mountRoomSettings({document,buttonId:'settings-toggle',dialogId:'settings-dialog',closeButtonId:'settings-close'});
audio.onStateChange(state=>{byId('sound-toggle').textContent=state.muted?'声音关':state.ready?'声音开':'点按启声';byId('volume').value=String(state.volume);});
byId('sound-toggle').addEventListener('click',async()=>{if(!audio.state().ready){await audio.unlock();audio.play('select',{gesture:true});}else audio.setMuted(!audio.state().muted);});
byId('volume').addEventListener('input',()=>audio.setVolume(Number(byId('volume').value)));
document.addEventListener('pointerdown',()=>audio.unlock(),{capture:true});
byId('exit-lab').addEventListener('click',event=>{event.preventDefault();location.replace('/start');});
async function request(path,body){const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),5000);try{const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,cache:'no-store'});const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||'操作没有确认。'),{status:response.status,data});return data;}finally{clearTimeout(timeout);}}
function viewport(){const frame=gameViewport({width:innerWidth,height:innerHeight,visual:visualViewport,editing:['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)});for(const [name,value] of Object.entries({height:frame.height,top:frame.top,left:frame.left,width:frame.width}))byId('lab-shell').style.setProperty(`--lab-${name}`,`${value}px`);fitPaper();}
for(const type of ['resize','pageshow','focus'])addEventListener(type,viewport);visualViewport?.addEventListener('resize',viewport);visualViewport?.addEventListener('scroll',viewport);document.addEventListener('focusin',viewport);document.addEventListener('focusout',()=>queueMicrotask(viewport));
function fitPaper(){if(page!=='paint')return;const box=byId('canvas-slot').getBoundingClientRect();const width=Math.max(1,Math.min(box.width-12,(box.height-12)*4/3));byId('paper').style.width=`${width}px`;byId('paper').style.height=`${width*3/4}px`;}
viewport();

if(page==='paint')await mountPaint();
if(page==='bank')await mountBank();

async function mountPaint(){
  const colors=[['#ed2634','红'],['#1269dc','蓝'],['#27884f','绿'],['#e8b51e','黄'],['#182a33','黑'],['#ffffff','白'],['#f58a2b','橙'],['#864aba','紫']];
  let tool='pen',color='#182a33',width=10,snapshot=null,lease=null,active=null,pending=[],busy=false,online=false,needsRead=false,strokeSerial=0,writerBlocked=false,leaseValidUntil=0,bootId=null,autoAcquired=false;
  const canvas=byId('drawing'),context=canvas.getContext('2d');
  byId('role-heading').textContent=role==='drawer'?'画出你想到的东西':role.startsWith('guesser')?'看着画布，猜猜是什么':'坐在一旁，也能参与聊天';
  byId('guess-form').hidden=!role.startsWith('guesser');byId('drawing-tools').hidden=role!=='drawer';
  byId('game-page').classList.toggle('read-only',role!=='drawer');
  if(role!=='drawer')canvas.style.cursor='default';
  function selectColor(value){color=value;byId('color-select').value=value;for(const button of byId('palette').querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.color===value));}
  for(const [value,name] of colors){const button=node('button');button.type='button';button.dataset.color=value;button.setAttribute('aria-label',`${name}色画笔`);button.title=`${name}色`;button.setAttribute('aria-pressed',String(value===color));const chip=node('i');chip.style.background=value;button.append(chip);button.addEventListener('click',()=>selectColor(value));byId('palette').append(button);const option=node('option',`${name}色`);option.value=value;byId('color-select').append(option);}
  selectColor(color);byId('color-select').addEventListener('change',()=>selectColor(byId('color-select').value));
  for(const button of document.querySelectorAll('[data-tool]'))button.addEventListener('click',()=>{tool=button.dataset.tool;for(const item of document.querySelectorAll('[data-tool]'))item.setAttribute('aria-pressed',String(item===button));});
  for(const button of document.querySelectorAll('[data-width]'))button.addEventListener('click',()=>{width=Number(button.dataset.width);for(const item of document.querySelectorAll('[data-width]'))item.setAttribute('aria-pressed',String(item===button));});
  function draw(stroke,opacity=1){if(!stroke?.points?.length)return;context.save();context.globalAlpha=opacity;context.strokeStyle=stroke.tool==='eraser'?'#fffefa':stroke.color;context.fillStyle=context.strokeStyle;context.lineWidth=stroke.width;context.lineCap='round';context.lineJoin='round';if(stroke.points.length===1){const [x,y]=stroke.points[0];context.beginPath();context.arc(x*1024,y*768,stroke.width/2,0,Math.PI*2);context.fill();}else{context.beginPath();context.moveTo(stroke.points[0][0]*1024,stroke.points[0][1]*768);for(const [x,y] of stroke.points.slice(1))context.lineTo(x*1024,y*768);context.stroke();}context.restore();}
  function render(){context.clearRect(0,0,1024,768);for(const stroke of snapshot?.strokes||[])draw(stroke);for(const stroke of pending)draw(stroke,.65);if(active)draw(active,.65);byId('canvas-empty').hidden=Boolean(snapshot?.strokes?.length||pending.length||active);byId('takeover').hidden=role==='drawer'&&Boolean(lease)&&!writerBlocked;for(const id of ['undo','redo','clear'])byId(id).disabled=!online||!lease||busy||Boolean(active)||pending.length>0||writerBlocked;}
  function acceptBoot(value){
    if(!value.bootId)return false;
    if(bootId!==null&&value.bootId!==bootId){
      snapshot=null;lease=null;active=null;pending=[];leaseValidUntil=0;writerBlocked=true;autoAcquired=true;
      byId('paint-status').textContent='本机服务已重启，临时画布已重置。接管后可重新画图。';
    }
    bootId=value.bootId;return true;
  }
  function apply(value){
    if(!value.bootId||bootId!==null&&value.bootId!==bootId)return false;
    bootId??=value.bootId;
    if(snapshot&&(value.sequence<snapshot.sequence||value.clearGeneration<snapshot.clearGeneration||value.leaseGeneration<snapshot.leaseGeneration))return false;
    snapshot=value;
    if(snapshot.stage!=='drawing'||snapshot.paused||Date.now()>=snapshot.deadline){writerBlocked=true;active=null;pending=[];}
    if(lease!==null&&snapshot.leaseGeneration!==lease){writerBlocked=true;active=null;pending=[];byId('paint-status').textContent='画笔已由另一设备接管。可以看图，或在这里重新接管。';}
    render();return true;
  }
  async function refresh(){
    if(!apply(await request(`/lab/read?labUser=${role}`)))return;
    needsRead=false;
    if(role!=='drawer')byId('paint-status').textContent=`已同步 ${snapshot.pointCount} 点 · 本机实时看图`;
  }
  async function acquire(){
    const requestedBoot=bootId;
    try{
      const result=await request(`/lab/acquire?labUser=${role}`,{deviceId});
      if(result.bootId!==bootId||requestedBoot!==null&&requestedBoot!==bootId)return;
      lease=result.leaseGeneration;leaseValidUntil=result.validUntil;writerBlocked=false;await refresh();
      byId('paint-status').textContent='画笔已就绪。落笔即预览，确认后其他窗口可见。';render();
    }catch(error){if(requestedBoot===bootId)byId('paint-status').textContent=error.message;}
  }
  byId('takeover').addEventListener('click',acquire);
  function point(event){const box=canvas.getBoundingClientRect();return [Math.min(1,Math.max(0,(event.clientX-box.left)/box.width)),Math.min(1,Math.max(0,(event.clientY-box.top)/box.height))];}
  function endPointer(event){if(!active||active.pointerId!==event.pointerId)return;const finished={...active};delete finished.pointerId;active=null;pending.push(finished);render();flush();}
  canvas.addEventListener('pointerdown',event=>{if(role!=='drawer'||!online||!lease||writerBlocked||active||pending.length>=4||Date.now()>=leaseValidUntil)return;event.preventDefault();active={strokeId:`${deviceId}-${++strokeSerial}`,tool,color,width,points:[point(event)],pointerId:event.pointerId};canvas.setPointerCapture(event.pointerId);render();});
  canvas.addEventListener('pointermove',event=>{if(!active||active.pointerId!==event.pointerId)return;event.preventDefault();const events=event.getCoalescedEvents?.()||[event];for(const value of events){if(active.points.length>=240)break;const next=point(value),last=active.points.at(-1);if(Math.hypot(next[0]-last[0],next[1]-last[1])>.001)active.points.push(next);}render();});
  canvas.addEventListener('pointerup',endPointer);for(const type of ['pointercancel','lostpointercapture'])canvas.addEventListener(type,event=>{if(active?.pointerId!==event.pointerId)return;active=null;pending=[];byId('paint-status').textContent='手势已取消，保留已确认的笔迹。';render();});
  async function flush(){
    if(busy||!pending.length||!online||!lease||writerBlocked||!snapshot||Date.now()>=leaseValidUntil)return;
    busy=true;
    const operations=pending.slice(0,1),requestId=crypto.randomUUID(),requestedBoot=bootId;
    render();
    try{
      const result=await request(`/lab/append?labUser=${role}`,{deviceId,leaseGeneration:lease,clearGeneration:snapshot.clearGeneration,expectedSequence:snapshot.sequence,requestId,operations});
      if(requestedBoot!==bootId||result.ack?.bootId!==bootId)return;
      if(!result.ack.persisted)throw new Error('保存尚未确认。');
      leaseValidUntil=result.ack.leaseValidUntil;
      pending=pending.filter(stroke=>stroke!==operations[0]);
      if(snapshot.sequence===result.ack.sequence-1){
        for(const operation of operations){
          const known=snapshot.strokes.find(stroke=>stroke.strokeId===operation.strokeId);
          if(known)known.points.push(...operation.points);else snapshot.strokes.push(structuredClone(operation));
        }
        Object.assign(snapshot,{sequence:result.ack.sequence,clearGeneration:result.ack.clearGeneration,leaseGeneration:result.ack.leaseGeneration,pointCount:snapshot.strokes.reduce((n,stroke)=>n+stroke.points.length,0)});
      }else if(snapshot.sequence!==result.ack.sequence)await refresh();
      if(requestedBoot===bootId)byId('paint-status').textContent=`已保存 ${snapshot.pointCount} 点 · 本机逐批同步`;
    }catch(error){
      if(requestedBoot===bootId){
        pending=[];active=null;writerBlocked=true;needsRead=true;
        byId('paint-status').textContent=error.status===409?'画布已变化。未确认笔迹已丢弃，请重新接管后继续。':'保存结果未确认。先重新读取，未确认笔迹不会自动补发。';
      }
    }finally{busy=false;render();if(pending.length)flush();}
  }
  const batchTimer=setInterval(()=>{if(lease&&Date.now()>=leaseValidUntil&&!writerBlocked){writerBlocked=true;active=null;pending=[];byId('paint-status').textContent='画笔授权已到期。点接管后继续，已保存图保持。';render();}if(active?.points.length>1&&pending.length<4&&!busy){const segment={...active};delete segment.pointerId;pending.push(segment);active={...active,points:[active.points.at(-1)]};render();flush();}},1000);
  async function action(type){
    if(!lease||busy||pending.length||active||writerBlocked)return;
    if(type==='clear'&&!confirm('清空这张画布？已确认的笔画会清除。'))return;
    busy=true;render();const requestedBoot=bootId;
    try{
      const result=await request(`/lab/${type}?labUser=${role}`,{deviceId,leaseGeneration:lease,clearGeneration:snapshot.clearGeneration,expectedSequence:snapshot.sequence,requestId:crypto.randomUUID()});
      if(requestedBoot!==bootId||result.ack?.bootId!==bootId)return;
      leaseValidUntil=result.ack.leaseValidUntil;
      await refresh();audio.play(type==='clear'?'restore':'undo',{gesture:true});
      if(requestedBoot===bootId)byId('paint-status').textContent=type==='clear'?'画布已清空。':'画布已更新。';
    }catch(error){if(requestedBoot===bootId){byId('paint-status').textContent=error.message;await refresh().catch(()=>{});}}
    finally{busy=false;render();}
  }
  for(const name of ['clear','undo','redo'])byId(name).addEventListener('click',()=>action(name));
  byId('guess-form').addEventListener('submit',event=>{event.preventDefault();if(event.isComposing||byId('guess-input').matches('[data-composing]'))return;const text=byId('guess-input').value.trim();if(!text)return;byId('guess-status').textContent='输入已保留。本样板不判答案，正式猜词将在权威规则阶段接入。';audio.play('select',{gesture:true});});
  byId('guess-input').addEventListener('compositionstart',()=>byId('guess-input').dataset.composing='');byId('guess-input').addEventListener('compositionend',()=>byId('guess-input').removeAttribute('data-composing'));
  document.body.insertAdjacentHTML('beforeend',roomChatMarkup());byId('chat-toggle').hidden=false;
  const chat=mountRoomChat({onCue:cue=>audio.play(cue),onUnavailable:error=>{byId('paint-status').textContent=error.message;}});
  const client={chatHistory:({after,before}={})=>request(`/lab/chat?labUser=${role}${after?`&after=${after}`:''}${before?`&before=${before}`:''}`),sendChat:body=>request(`/lab/chat?labUser=${role}`,body)};
  chat.attach(client,{roomId:'lab-room',roomCode:'000000',selfId:role},{mode:'unified',authenticated:true,userKey:`lab:${role}`});
  const stream=new EventSource(`/lab/events?labUser=${role}`);
  stream.addEventListener('open',async()=>{
    online=true;byId('connection').textContent='已连接 · 本机';chat.connection('online');
    await refresh().catch(()=>{});
    if(role==='drawer'&&!autoAcquired){autoAcquired=true;await acquire();}
    else if(needsRead){pending=[];active=null;await refresh().catch(()=>{});}
    render();
  });
  stream.addEventListener('snapshot',event=>{const value=JSON.parse(event.data);if(acceptBoot(value))apply(value);});
  stream.addEventListener('canvas',event=>{
    const data=JSON.parse(event.data);
    if(data.bootId!==bootId)return;
    if(data.kind==='replace'){apply(data);return;}
    if(snapshot&&data.sequence<=snapshot.sequence)return;
    if(!snapshot||data.sequence!==snapshot.sequence+1||data.clearGeneration!==snapshot.clearGeneration){refresh().catch(()=>{});return;}
    for(const operation of data.operations){
      const known=snapshot.strokes.find(stroke=>stroke.strokeId===operation.strokeId);
      if(known)known.points.push(...operation.points);else snapshot.strokes.push(operation);
    }
    snapshot.sequence=data.sequence;snapshot.pointCount=data.pointCount;snapshot.leaseGeneration=data.leaseGeneration;apply(snapshot);
  });
  stream.addEventListener('chat',event=>{const data=JSON.parse(event.data);if(data.bootId===bootId)chat.receive(data);});
  stream.addEventListener('recovery',event=>{
    const data=JSON.parse(event.data);if(!acceptBoot(data))return;
    active=null;pending=[];refresh().catch(()=>{writerBlocked=true;render();});
  });
  stream.addEventListener('error',()=>{online=false;active=null;pending=[];writerBlocked=true;needsRead=true;chat.connection('offline');byId('connection').textContent='连接恢复中';byId('paint-status').textContent='未确认轨迹已停止，恢复后先看已保存画布。';render();});
  let previousBox=null;new ResizeObserver(()=>{const box=byId('canvas-slot').getBoundingClientRect();if(previousBox&&(Math.abs(previousBox.width-box.width)>2||Math.abs(previousBox.height-box.height)>2)&&active){active=null;pending=[];byId('paint-status').textContent='画面尺寸已变化，保留已确认笔迹，重新落笔即可。';render();}previousBox={width:box.width,height:box.height};fitPaper();}).observe(byId('canvas-slot'));
  addEventListener('pageshow',event=>{if(event.persisted)location.reload();});addEventListener('pagehide',()=>{clearInterval(batchTimer);stream.close();chat.clear();audio.close();},{once:true});
}

async function mountBank(){
  let bank=null,shown=40,preview=null,loading=false,editGeneration=0;
  const categories=()=>new Map(bank.categories.map(c=>[c.id,c.name]));
  async function reload(){bank=await request('/lab/words');render();}
  function feedback(text){byId('word-feedback').textContent=text;}
  function render(){
    const filter=byId('category-filter').value,editing=byId('edit-category').value;
    for(const id of ['category-filter','edit-category']){const select=byId(id);select.replaceChildren();if(id==='category-filter'){const option=node('option','所有分类');option.value='';select.append(option);}for(const c of bank.categories){const option=node('option',c.name);option.value=c.id;select.append(option);}select.value=id==='category-filter'?filter:bank.categories.some(c=>c.id===editing)?editing:bank.categories[0].id;}
    byId('bank-count').textContent=`${bank.words.length} 词 · ${bank.categories.length} 类`;
    const needle=byId('word-search').value.trim().toLowerCase(),matched=bank.words.filter(w=>(!filter||w.category===filter)&&(!needle||[w.answer,...w.aliases].some(s=>s.toLowerCase().includes(needle))));
    const names=categories(),list=byId('word-list');list.replaceChildren();for(const word of matched.slice(0,shown)){const card=node('article',undefined,'word-card');card.append(node('strong',word.answer),node('small',`${names.get(word.category)} · ${{easy:'简单',normal:'普通',hard:'挑战'}[word.difficulty]}`,'word-meta'));if(word.aliases.length)card.append(node('small',`别名：${word.aliases.join('、')}`));list.append(card);}if(!matched.length)list.append(node('p','暂时没有匹配的词条。'));byId('more-words').hidden=matched.length<=shown;
    const versions=byId('versions');versions.replaceChildren();for(const version of [...bank.versions].reverse()){const row=node('div',undefined,'version-row');row.append(node('span',`${version.name} · ${version.total}词`));const restore=node('button','恢复为样稿');restore.addEventListener('click',async()=>{if(!confirm('恢复这个样稿版本？会替换已保存的本机样稿；已保存版本记录保留，输入框内尚未保存的词条也会保留。'))return;try{bank=await request('/lab/words/restore',{expectedRevision:bank.revision,versionId:version.id});invalidate();render();feedback('已恢复为新样稿。需要时再保存一个版本。');}catch(error){feedback(error.message);await reload().catch(()=>{});}});row.append(restore);versions.append(row);}
  }
  function invalidate(){++editGeneration;preview=null;byId('save-words').disabled=true;}
  const payload=()=>({expectedRevision:bank.revision,category:byId('edit-category').value,difficulty:byId('edit-difficulty').value,lines:byId('word-lines').value});
  for(const id of ['word-lines','edit-category','edit-difficulty'])byId(id).addEventListener('input',invalidate);
  byId('category-filter').addEventListener('change',()=>{shown=40;render();});byId('word-search').addEventListener('input',()=>{shown=40;render();});byId('more-words').addEventListener('click',()=>{shown+=40;render();});
  byId('preview-words').addEventListener('click',async()=>{if(loading)return;loading=true;invalidate();const captured=payload(),epoch=editGeneration;try{const result=await request('/lab/words/preview',captured);if(epoch!==editGeneration){feedback('输入已变化，请重新预览当前内容。');return;}preview={...result,payload:captured,editGeneration:epoch};byId('save-words').disabled=false;feedback(`检查通过，将新增 ${preview.added} 词。确认后保存样稿。`);}catch(error){feedback(error.data?.report?.errors?.map(e=>e.message).slice(0,12).join('\n')||error.message);if(error.status===409)await reload().catch(()=>{});}finally{loading=false;}});
  byId('save-words').addEventListener('click',async()=>{if(!preview||loading)return;loading=true;const captured=preview.payload,epoch=preview.editGeneration;try{bank=await request('/lab/words/save',captured);if(epoch===editGeneration)byId('word-lines').value='';invalidate();render();feedback(epoch===editGeneration-1?'样稿已保存。服务重启会重置，不影响正式公共词库。':'已保存此前确认的样稿。后来输入仍保留，请重新预览。');audio.play('commit',{gesture:true});}catch(error){feedback(error.message);invalidate();if(error.status===409)await reload().catch(()=>{});}finally{loading=false;}});
  byId('new-category').addEventListener('click',async()=>{const name=prompt('新分类名称');if(name===null)return;try{bank=await request('/lab/words/category',{expectedRevision:bank.revision,name});invalidate();render();feedback('新分类已加入本机样稿。');}catch(error){feedback(error.message);if(error.status===409)await reload().catch(()=>{});}});
  byId('publish-words').addEventListener('click',async()=>{if(!confirm('保存当前全部样稿为一个新版本？仅用于本机操作验证。'))return;try{bank=await request('/lab/words/publish',{expectedRevision:bank.revision});invalidate();render();feedback('样稿版本已保留，可继续添加或恢复旧版。');}catch(error){feedback(error.message);if(error.status===409)await reload().catch(()=>{});}});
  try{await reload();}catch(error){feedback(error.message);}
}
