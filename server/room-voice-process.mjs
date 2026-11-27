import {spawn} from 'node:child_process';
import {readFile,lstat,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {isIP,createConnection} from 'node:net';
import {createRoomVoiceMedia} from './room-voice-media.mjs';
import {createRoomVoiceService} from './room-voice-service.mjs';
const binaryPath='/opt/game-room-voice/livekit-server';
const binarySha={arm64:'bab3c72aff938c67c706c6de42a47f938019a3ecd44f78efa9f3c92ac62027e0',x64:'9aab8bee073c67e75691a6e88c881eec339c646e17cd6228177a92fe90cc1f19'};
const delay=ms=>new Promise(r=>setTimeout(r,ms));

/** Each launch owns exactly one direct child.
 * A stop acknowledgement means its close event was observed, including after
 * SIGKILL escalation; the parent unit's control-group remains the final guard. */
export async function launchOwnedVoice({command,args=[],env,probe,startupMs=8000,termMs=1000,killMs=2000}={}) {
 const child=spawn(command,args,{env,stdio:'ignore',detached:false});let ended=false,closeFlight=null;
 const spawned=new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
 const end=new Promise(resolve=>{child.once('close',()=>{ended=true;resolve();});child.once('error',()=>{});});
 const waitEnd=ms=>new Promise(resolve=>{const timer=setTimeout(resolve,ms);end.then(()=>{clearTimeout(timer);resolve();});});
 const stop=()=>{if(closeFlight)return closeFlight;closeFlight=(async()=>{if(ended)return;child.kill('SIGTERM');await waitEnd(termMs);if(!ended){child.kill('SIGKILL');await waitEnd(killMs);}if(!ended)throw Object.assign(Error('Owned voice process stop was not confirmed.'),{code:'VOICE_STOP_UNCONFIRMED'});})();return closeFlight;};
 const owned={get ready(){return !ended;},pid:child.pid,exited:end,stop};
 try{await spawned;const deadline=Date.now()+startupMs;while(Date.now()<deadline&&!ended){if(await probe(owned))return owned;await delay(100);}throw Error('Owned voice process did not become ready.');}
 catch{await stop();throw Object.assign(Error('房间语音服务未启动，游戏配置未改变。'),{code:'VOICE_START_FAILED'});}
}

export async function readVoiceConfiguration(env=process.env) {
 const flag=env.GAME_ROOM_VOICE_ENABLED;if(flag===undefined||flag==='0')return null;if(flag!=='1')throw Error('Invalid voice feature flag.');
 if(process.platform!=='linux'||!binarySha[process.arch])throw Error('Voice requires a verified Linux architecture.');
 const ip=env.GAME_ROOM_VOICE_PUBLIC_IP;if(isIP(ip)!==4||/^(127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(ip))throw Error('Voice requires the inspected public IPv4.');
 const folder=env.CREDENTIALS_DIRECTORY;
 if(!/^\/run\/credentials\/game-room(?:-preflight-[a-f0-9]{20})?\.service$/.test(folder??''))throw Error('Voice key requires the existing service credential directory.');
 const parent=await lstat(folder);if(!parent.isDirectory()||parent.uid!==0||parent.mode&0o022)throw Error('Unsafe voice credential directory.');
 const handle=await open(folder+'/voice-key',constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let key;
 try{const info=await handle.stat();if(!info.isFile()||info.uid!==0||info.mode&0o337||info.size>512||info.size<64)throw Error();key=JSON.parse(await handle.readFile('utf8'));}catch{throw Error('Voice requires its dedicated protected key.');}finally{await handle.close();}
 if(!key||Object.keys(key).sort().join(',')!=='apiKey,secret'||!/^voice_[a-f0-9]{32}$/.test(key.apiKey)||!/^[A-Za-z0-9_-]{64}$/.test(key.secret))throw Error('Invalid dedicated voice key.');
 const owner=await lstat('/opt/game-room-voice');if(!owner.isDirectory()||owner.uid!==0||owner.mode&0o022)throw Error('Unsafe voice binary directory.');
 const info=await lstat(binaryPath);if(!info.isFile()||info.uid!==0||info.mode&0o022||info.size>64*1024*1024||createHash('sha256').update(await readFile(binaryPath)).digest('hex')!==binarySha[process.arch])throw Error('Voice binary differs from the fixed verified version.');
 return {apiKey:key.apiKey,secret:key.secret,ip};
}

// Restart only after an owned worker has actually exited. Shutdown and failed
// permission revocation still close the whole audio service. A replacement
// uses fresh terminals and the same independently authenticated seat streams.
export async function startRecoverableRoomVoice({launch, origin, apiKey, secret}) {
 let current, opening, retryTimer, closing = false, blocked = false, onInterrupted;
 let retryMs = 1000, retryReported = false;
 async function start() {
  const worker = await launch();
  if (closing) { await worker.stop(); return; }
  const media = createRoomVoiceMedia({origin, apiKey, secret, stop:worker.stop});
  const instance = {worker, media, startedAt:Date.now()};
  current = instance;
  worker.exited.then(() => {
   if (current !== instance || closing) return;
   current = null;
   if (Date.now() - instance.startedAt >= 30000) retryMs = 1000;
   onInterrupted?.();
   void media.close().catch(() => {});
   console.warn('Room voice worker exited unexpectedly');
   scheduleRestart();
  });
 }
 function scheduleRestart() {
  if (closing || blocked || retryTimer) return;
  retryTimer = setTimeout(() => {
   retryTimer = null;
   opening = start().then(() => {
    if (current && !closing) {
     console.info('Room voice worker recovered');
     retryReported = false;
    }
   }).catch(error => {
    if (error.code === 'VOICE_STOP_UNCONFIRMED') {
     blocked = true;
     console.warn('Room voice worker stop unconfirmed');
    } else {
     if (!retryReported) console.warn('Room voice worker restart delayed');
     retryReported = true;
     scheduleRestart();
    }
   });
  },retryMs);
  retryTimer.unref?.();
  retryMs = Math.min(retryMs * 2, 30000);
 }
 try { await start(); }
 catch (error) {
  // A failed readiness probe is retryable only after the old worker has
  // definitely stopped. The card table can then start while audio recovers.
  if (error.code !== 'VOICE_START_FAILED') throw error;
  console.warn('Room voice worker restart delayed');
  retryReported = true;
  scheduleRestart();
 }
 return createRoomVoiceService({apiKey,secret,media:{
  get ready(){return Boolean(current?.worker.ready && !closing && !blocked);},
  get recovering(){return !closing && !blocked && !current?.worker.ready;},
  onInterrupted(fn){onInterrupted=fn;},
  async remove(target) {
   const instance = current;
   if (!instance?.worker.ready) return;
   try { await instance.media.remove(target); }
   catch (error) {
    // A confirmed OS exit already disconnected every participant of that
    // generation. An uncertain removal from a running worker stays fatal.
    if (instance.worker.ready) throw error;
   }
  },
  async close() {
   closing = true;
   clearTimeout(retryTimer);
   onInterrupted = null;
   await opening;
   if (blocked) throw Error('Owned voice process stop was not confirmed.');
   await current?.media.close();
  }
 }});
}

export async function startProductionVoice(configuration) {
 if(!configuration)return null;
 const {apiKey,secret,ip}=configuration;
 // The signal port is NEVER a public firewall rule; only the BFF may proxy it.
 // LiveKit needs wildcard media binds because the Lightsail public IP is NATed.
 const config={port:7880,bind_addresses:['0.0.0.0'],rtc:{tcp_port:7881,udp_port:7882,port_range_start:0,port_range_end:0,use_external_ip:false,node_ip:ip},room:{auto_create:true,max_participants:16,enable_remote_unmute:false},keys:{[apiKey]:secret},logging:{level:'error'}};
 const origin='http://127.0.0.1:7880';
 async function launch() {
  const occupied=await new Promise(resolve=>{const socket=createConnection({host:'127.0.0.1',port:7880});socket.setTimeout(500);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(true);});});
  if(occupied)throw Error('Voice private port is already occupied.');
  return launchOwnedVoice({command:binaryPath,env:{PATH:'/usr/bin:/bin',GOMAXPROCS:'1',GOMEMLIMIT:'192MiB',LIVEKIT_CONFIG:JSON.stringify(config)},probe:async()=>{try{const r=await fetch(origin+'/',{signal:AbortSignal.timeout(500),redirect:'error'});return r.ok&&(await r.text())==='OK';}catch{return false;}}});
 }
 return startRecoverableRoomVoice({launch,origin,apiKey,secret});
}
