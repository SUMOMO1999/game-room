/** A voice upgrade owns both sockets. Normal EOF drains queued frames before
 * closing; revocation/error/shutdown destroys immediately. No frame parsing,
 * retries, compression, logging or shared socket ownership. */
export function bridgeVoiceSockets(client,remote,{head=Buffer.alloc(0),remoteHead=Buffer.alloc(0),onClose=()=>{},drainMs=3000}={}) {
 let closed=false,timer=null;const ended=new Set(),finished=new Set();
 client.allowHalfOpen=true;remote.allowHalfOpen=true;
 function close(){if(closed)return;closed=true;clearTimeout(timer);client.destroy();remote.destroy();onClose();}
 function drain(){if(!timer){timer=setTimeout(close,drainMs);timer.unref?.();}}
 function endpointClosed(side,hadError){finished.add(side);if(closed)return;const stream=side==='client'?client:remote,other=side==='client'?remote:client;
  if(hadError||!ended.has(side)||!stream.writableFinished)return close();
  if(finished.size===2)return close();drain();if(other.writableFinished)other.destroy();else{other.once('finish',()=>other.destroy());other.end();}
 }
 for(const [name,stream]of [['client',client],['remote',remote]]){stream.once('error',close);stream.once('end',()=>{ended.add(name);drain();});stream.once('close',error=>endpointClosed(name,error));}
 if(remoteHead.length)client.write(remoteHead);if(head.length)remote.write(head);
 client.pipe(remote);remote.pipe(client);client.resume();remote.resume();return {close};
}
