import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withRoomVoice} from './platform/room-voice-session.mjs';
import {mountRoomVoiceControls} from './platform/room-voice-controls.mjs';
import {drawingTestDOM} from './test-support/drawing-page-dom.mjs';
import {supportsRoomVoice} from './platform/room-voice-policy.mjs';

function fixture(gameType){
 const doc=drawingTestDOM('<head></head><body><header><div class="room-toolbar-actions"><button>设置</button></div></header><dialog><div class="game-settings-body"></div></dialog></body>');
 const win=new EventTarget();win.crypto={randomUUID};let generation=1,voiceCount=0;
 const account={verification:'verified',authenticated:true,voiceEnabled:true,voiceKind:'sfu-v1'},calls=[],packets=[],controls=[];
 class Base {
  constructor(code,membership,callbacks){Object.assign(this,{code,membership,...callbacks,stopped:false,generation});}
  epoch(){return {generation:this.generation};}live(e){return !this.stopped&&e.generation===generation;}
  request(path,options,epoch){assert(this.live(epoch));calls.push({path,options,epoch});return Promise.resolve({id:'local-terminal-123456789'});}
  stop(){this.stopped=true;this.generation++;}
 }
 const makeVoice=({transport,onChange})=>{
  voiceCount++;let state={supported:true,joined:false,joining:false,mode:'off',speaking:false,mic:'prompt',peers:[]};
  const emit=()=>onChange({...state}),unsubscribe=transport.subscribe(p=>packets.push(p));
  return {state:()=>({...state}),async join(){await transport.join();state.joined=true;emit();},setOpen(value){state.mode=value?'open':'off';emit();},releaseHold(){},press(){},resumeAudio(){},mute(){},leave(){state.joined=false;state.mode='off';emit();},destroy(){unsubscribe();state.joined=false;state.mode='off';}};
 };
 const Client=withRoomVoice(Base,{gameType,getAccount:()=>account,document:doc,window:win,createControls:options=>{const c=mountRoomVoiceControls({...options,createVoice:makeVoice});controls.push(c);return c;}});
 const views=[],connections=[],client=new Client('123456',{playerId:'self'},{onView:v=>views.push(v),onConnection:c=>connections.push(c)});
 const view={gameType,phase:'waiting',revision:1,players:[{id:'self',name:'我'},{id:'peer',name:'伙伴'}]};
 return {client,doc,account,calls,views,connections,controls,packets,view,get count(){return voiceCount;},retire:()=>generation++};
}
for(const gameType of ['rummikub','army-flip','flying-chess','poker414-2','hyakki-trading'])test(`${gameType}: actual compact controls own one voice session through waiting, play, choice, pause and result`,async()=>{
 const f=fixture(gameType);f.client.onView(f.view);const join=f.doc.querySelector('.room-voice-join'),mic=f.doc.querySelector('.room-voice-open');
 assert(join);assert(mic);assert.equal(f.doc.querySelector('.room-voice-talk'),null);assert.equal(join.disabled,true);
 f.client.onConnection('online');assert.equal(join.disabled,false);assert.equal(mic.disabled,true);
 await f.controls[0].voice.join();assert.equal(mic.disabled,false);assert.match(f.calls[0].path,/123456\/voice\/join$/);assert.deepEqual(Object.keys(f.calls[0].options.body),['clientId']);
 mic.dispatchEvent(new Event('click'));assert.equal(mic.getAttribute('aria-pressed'),'true');
 for(const [i,phase] of ['playing','playing','paused','finished'].entries()){f.client.onView({...f.view,phase,revision:i+2,game:{turnPlayerId:i%2?'peer':'self',pending:i===1?{kind:'choice'}:null}});assert.equal(f.doc.querySelector('.room-voice-join'),join);assert.equal(f.doc.querySelector('.room-voice-open'),mic);assert.equal(mic.getAttribute('aria-pressed'),'true');}
 assert.equal(f.count,1);f.client.onVoice({kind:'closed',target:'test'});assert.equal(f.packets.length,1);
 f.client.onConnection('offline');assert.equal(mic.disabled,true);assert.equal(mic.getAttribute('aria-pressed'),'false');
 f.client.stop();assert.equal(f.doc.querySelector('.room-voice-toolbar'),null);f.client.onView(f.view);assert.equal(f.count,1);
 await assert.rejects(()=>f.client.voiceRequest('join',{}),/恢复房间/);
});
test('unverified/disabled media stays absent, wrong game cannot mount, stale identity cannot mint media and fresh client never inherits open-mic intent',async()=>{
 const f=fixture('hyakki-trading');f.account.voiceEnabled=false;f.client.onView(f.view);assert.equal(f.count,0);
 f.account.voiceEnabled=true;f.client.onView({...f.view,gameType:'parks'});assert.equal(f.count,0);
 f.client.onView(f.view);f.client.onConnection('online');f.retire();await assert.rejects(()=>f.client.voiceRequest('join',{}),/恢复房间/);assert.equal(f.calls.length,0);f.client.stop();
 assert.equal(supportsRoomVoice('parks'),false);assert.equal(supportsRoomVoice('sanguosha'),false);assert.equal(supportsRoomVoice('unknown'),false);assert.throws(()=>withRoomVoice(class {},{gameType:'parks'}));
 const fresh=fixture('hyakki-trading');fresh.client.onView(fresh.view);assert.equal(fresh.doc.querySelector('.room-voice-open').getAttribute('aria-pressed'),'false');fresh.client.stop();
});

test('media control setup failure leaves the original room view/connection alive and cleans its status on stop',()=>{
 const doc=drawingTestDOM('<head></head><body><div class="room-toolbar-actions"></div><div class="game-settings-body"></div></body>');let rendered=0;
 class Base{constructor(c,m,callbacks){Object.assign(this,callbacks);}epoch(){return {};}live(){return true;}stop(){this.stopped=true;}}
 const Client=withRoomVoice(Base,{gameType:'flying-chess',getAccount:()=>({authenticated:true,voiceEnabled:true,voiceKind:'sfu-v1'}),document:doc,window:{crypto:{randomUUID}},createControls:()=>{throw Error('media unavailable');}});
 const client=new Client('123456',{playerId:'self'},{onView:()=>rendered++,onConnection:()=>{}});
 assert.doesNotThrow(()=>client.onView({gameType:'flying-chess'}));assert.equal(rendered,1);assert.match(doc.querySelector('.game-settings-body').textContent,/游戏可以继续/);assert.equal(doc.querySelector('.room-voice-toolbar'),null);client.stop();assert.equal(doc.querySelector('.game-settings-body').textContent,'');
});
