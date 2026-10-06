import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readSettings } from '../server/config.mjs';
import { createServer } from '../app/server.mjs';
if(process.env.NODE_ENV==='production') throw new Error('Synthetic preview cannot run in production');
const directory=new URL('../.local/',import.meta.url);await mkdir(directory,{recursive:true,mode:0o700});
const keyFile=new URL('preview-key',directory);let key;
try {key=(await readFile(keyFile,'utf8')).trim();} catch(error) {
  if(error.code!=='ENOENT') throw error;
  key=randomBytes(32).toString('base64url');await writeFile(keyFile,key,{mode:0o600,flag:'wx'});
}
const port=process.env.GAME_ROOM_PORT || '4187';
const settings=readSettings({...process.env,GAME_ROOM_AUTH_MODE:'mock',GAME_ROOM_ORIGIN:`http://127.0.0.1:${port}`,GAME_ROOM_PORT:port,GAME_ROOM_HOST:'127.0.0.1',GAME_ROOM_STORE_PATH:fileURLToPath(new URL('preview.sqlite',directory)),GAME_ROOM_STORE_KEY:key});
const server=createServer({settings});
server.on('error',()=>{console.error('本机隔离预览启动失败。');process.exitCode=1;});
server.listen(settings.port,settings.host,()=>console.log(`棋牌室虚构身份预览: ${settings.origin} · 本机加密保存`));
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>server.shutdown());
