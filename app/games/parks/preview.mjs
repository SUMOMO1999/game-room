import { previewFixture } from './preview-fixtures.mjs';
import { mountParksPreviewPage } from './page-ui.mjs';
import { mountRoomChat } from '../../room-chat.mjs';
import { gamePath } from '../../entry-path.mjs';

const params=new URLSearchParams(location.search),member=params.get('member')==='b'?'b':'a';
const exitKey='parks-preview-exited';
let exited=false;
const historyReturn=performance.getEntriesByType('navigation')[0]?.type==='back_forward';
try { if(params.get('enter')==='1'&&!historyReturn)sessionStorage.removeItem(exitKey);exited=sessionStorage.getItem(exitKey)==='1'; } catch { /* Preview also works without storage; no save claim. */ }
if(exited)location.replace('./');else start();

function start(){
  let view=previewFixture(params.get('scene')),stream=null,stopped=false,chat;
  view.selfId=`parks-preview-${member}`;
  const endpoint=(path,forMember=member)=>gamePath(`/__parks/${path}?member=${forMember}`);
  async function request(path,{body,forMember=member,query={}}={}){
    const url=new URL(endpoint(path,forMember),location.origin);for(const [key,value]of Object.entries(query))if(value!==undefined)url.searchParams.set(key,String(value));
    const response=await fetch(url,{...(body?{method:'POST',headers:{'Content-Type':'application/json','x-parks-preview':'1'},body:JSON.stringify(body)}:{}),cache:'no-store'});
    const result=await response.json();if(!response.ok){const error=new Error(result.message||result.error||'本机服务暂时不可用');error.status=response.status;throw error;}return result;
  }
  const ui=mountParksPreviewPage({root:document.getElementById('parks-root'),onScene(scene){
    view=previewFixture(scene);view.selfId=`parks-preview-${member}`;ui.applyView(view);
    history.replaceState(null,'',`${location.pathname}?scene=${encodeURIComponent(scene)}&member=${member}`);
    ui.feedback('固定场景已切换；没有改变正式牌局。');
  },onLeave(){try{sessionStorage.setItem(exitKey,'1');}catch{}stop();location.replace('./');},async onPeerMessage(){
    try{await request('chat',{forMember:member==='a'?'b':'a',body:{text:'这一站的风景真好。准备好一起往前走了吗？',requestId:crypto.randomUUID()}});}catch(error){ui.feedback(error.message);}
  }});
  chat=mountRoomChat({onCue:kind=>ui.audio.play(kind),onUnavailable:error=>ui.feedback(error.message)});
  chat.attach({chatHistory:query=>request('chat',{query}),sendChat:body=>request('chat',{body})},view,{mode:'synthetic',authenticated:true,userKey:`parks-step0-${member}`});
  function connect(){
    if(stopped||stream)return;stream=new EventSource(endpoint('events'));
    stream.onopen=()=>chat.connection('online');
    stream.onerror=()=>{chat.connection('offline');ui.feedback('本机聊天正在重连；当前选择保留。');};
    stream.addEventListener('chat',event=>{if(stopped)return;try{chat.receive(JSON.parse(event.data));}catch{ui.feedback('收到无效本机消息，等待下一次同步。');}});
  }
  function stop(){if(stopped)return;stopped=true;stream?.close();stream=null;chat.clear();ui.destroy();}
  window.addEventListener('pagehide',event=>{if(event.persisted){stream?.close();stream=null;chat.connection('offline');}else stop();});
  window.addEventListener('pageshow',()=>{let left=false;try{left=sessionStorage.getItem(exitKey)==='1';}catch{}if(left){stop();location.replace('./');}else connect();});
  ui.applyView(view);connect();
}
