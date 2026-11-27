import {createConnection} from 'node:net';
import {isAbsolute} from 'node:path';
import {once} from 'node:events';
import {get} from 'node:http';
import WebSocket from 'ws';
import {localRpc} from './referee-rpc.mjs';

export function checkReferee(socketPath) {
  return new Promise((resolve,reject) => {
    const probe = get({socketPath,path:'/ready',timeout:15000},res => {
      res.resume();
      if (res.statusCode === 204) resolve();
      else reject(Error('Private referee is not ready'));
    });
    probe.on('timeout',()=>probe.destroy(Error('Referee readiness timed out')));
    probe.on('error',reject);
  });
}

export function refereeClient(socketPath) {
  if (!isAbsolute(socketPath)) throw Error('Expected a private referee socket path');
  return async descriptor => {
    const {onLost,send,...setup} = descriptor;
    const socket = new WebSocket('ws://localhost/table', {createConnection:() => createConnection({path:socketPath}),
      handshakeTimeout:5000,maxPayload:16*1024*1024,perMessageDeflate:false});
    await once(socket,'open');
    let intentional = false;
    socket.once('close', () => { if (!intentional) onLost?.(); });
    const call = localRpc(socket, (method, [message]) => {
      if (method !== 'output' || !Array.isArray(message)) throw Error('Unexpected referee output');
      return send(message);
    });
    try { await call('open',setup); } catch (error) { intentional = true; socket.terminate(); throw error; }
    return {join:seat => call('join',seat),receive:(seat,frame) => call('receive',seat,frame),
      state:seat => call('state',seat),match:(seat,state,atStart=false) => call('match',seat,state,atStart),
      expire:(seat,number) => call('expire',seat,number),resume:seat => call('resume',seat),
      depart:(seat,owner) => call('depart',seat,owner),
      async close() { intentional=true; if (socket.readyState !== 1) return;
        try { await call('close'); } finally { socket.close(); } }};
  };
}

