import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createCanvasLab } from './transport-experiment.mjs';
import { DRAW_AND_GUESS_CATEGORIES, DRAW_AND_GUESS_SEED } from '../../server/content/draw-and-guess-seed.mjs';
import { normalizeDrawAndGuessAnswer, validateDrawAndGuessWordbank } from '../../server/content/draw-and-guess-definition.mjs';

const directory = dirname(fileURLToPath(import.meta.url)), root = resolve(directory, '../..');
const assets = new Map([
  ['/preview.css', resolve(directory,'preview.css')], ['/preview.mjs', resolve(directory,'preview.mjs')],
  ...['styles.css','room-chat.mjs','account-client.mjs','game-viewport.mjs','entry-path.mjs','lobby-model.mjs',
    'games/types.mjs','games/catalog.mjs','game-audio.mjs','platform/room-settings.css','platform/room-settings.mjs','platform/game-theme.mjs','platform/game-theme.css']
    .map(name => ['/'+name, resolve(root,'app',name)]),
]);
const mime = file => file.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8';
const clone = value => structuredClone(value);
export async function createDrawingPreview({ directory: dataDirectory } = {}) {
  const lab = await createCanvasLab({ directory:dataDirectory });
  let categories=clone(DRAW_AND_GUESS_CATEGORIES), words=clone(DRAW_AND_GUESS_SEED), revision=1;
  const versions=[{id:'sample-1',name:'基础词库样稿',at:Date.now(),categories:clone(categories),words:clone(words)}];
  const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
  async function body(req) {
    const chunks=[];let bytes=0;for await(const part of req){bytes+=part.length;if(bytes>65536)throw Object.assign(new Error('单次输入太多，请分批添加。'),{status:413});chunks.push(part);}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(new Error('无法读取操作内容。'),{status:400});}
  }
  function view(){return {prototype:true,persistence:'memory-reset-on-server-restart',revision,categories:clone(categories),words:clone(words),versions:versions.map(({id,name,at,words})=>({id,name,at,total:words.length}))};}
  function merged(data) {
    if(!categories.some(c=>c.id===data.category) || !['easy','normal','hard'].includes(data.difficulty) || typeof data.lines!=='string')throw Object.assign(new Error('请选择分类、难度并输入词条。'),{status:400});
    const lines=data.lines.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    if(!lines.length || lines.length>200)throw Object.assign(new Error('一次输入1～200行词条。'),{status:400});
    const additions=lines.map((line,i)=>{const [answer,...aliases]=line.split(/[|｜]/).map(s=>s.trim());return {id:`dg-sample-${randomUUID()}`,answer,aliases,category:data.category,tags:[],difficulty:data.difficulty,language:'zh',packId:'dg-base',definitionVersion:1,source:'本机样稿录入',status:'reviewed',hintLength:[...answer.normalize('NFC')].length,drawingCue:'待共同试画'};});
    const report=validateDrawAndGuessWordbank([...words,...additions],{categories,requireBaseMinimums:false});
    return {report,additions};
  }
  const server=createServer(async(req,res)=>{
    const expected=`http://127.0.0.1:${server.address()?.port}`;
    if(req.headers.host!==new URL(expected).host){json(res,403,{error:'本机样板只允许本机入口。'});return;}
    if(req.method==='POST' && req.headers.origin!==expected){json(res,403,{error:'请从本机样板页面操作。'});return;}
    const url=new URL(req.url,expected);
    try{
      if(url.pathname==='/lab/words' && req.method==='GET'){json(res,200,view());return;}
      if(url.pathname.startsWith('/lab/words/') && req.method==='POST'){
        const data=await body(req);
        if(data.expectedRevision!==revision){json(res,409,{error:'另一窗口修改了样稿。保留你的输入，重新读取并预览后再保存。',revision});return;}
        if(url.pathname==='/lab/words/preview' || url.pathname==='/lab/words/save'){
          const {report,additions}=merged(data);
          if(!report.valid){json(res,422,{error:'请修正冲突词条。',report});return;}
          if(url.pathname.endsWith('/save')){words.push(...additions);revision++;json(res,200,view());}
          else json(res,200,{prototype:true,revision,report,added:additions.length});
          return;
        }
        if(url.pathname==='/lab/words/category'){
          let name;
          try { name=normalizeDrawAndGuessAnswer(data.name); }
          catch { json(res,422,{error:'分类名需为1～32个可见字符，不能含标记或不可见符号。'});return; }
          if(categories.some(c=>c.name===name) || categories.length>=64){json(res,422,{error:'分类名不能重复；本样稿最多64类。'});return;}
          categories.push({id:`custom-${randomUUID()}`,name,status:'active'});revision++;json(res,200,view());return;
        }
        if(url.pathname==='/lab/words/publish'){
          if(versions.length>=20){json(res,429,{error:'本机样稿最多20个版本。正式清理与引用保护将在内容服务实现。'});return;}
          versions.push({id:`sample-${versions.length+1}`,name:`样稿版本 ${versions.length+1}`,at:Date.now(),words:clone(words),categories:clone(categories)});revision++;json(res,200,view());return;
        }
        if(url.pathname==='/lab/words/restore'){
          const version=versions.find(v=>v.id===data.versionId);if(!version){json(res,404,{error:'样稿版本不存在。'});return;}
          words=clone(version.words);categories=clone(version.categories);revision++;json(res,200,view());return;
        }
        json(res,404,{error:'没有这个操作。'});return;
      }
      if(await lab.handle(req,res))return;
      if(req.method==='GET' && ['/','/start','/paint','/wordbank'].includes(url.pathname)){
        const file=resolve(directory,'preview.html');res.writeHead(200,{'content-type':mime(file),'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});res.end(await readFile(file));return;
      }
      const file=assets.get(url.pathname);
      if(req.method==='GET' && file){res.writeHead(200,{'content-type':mime(file),'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(await readFile(file));return;}
      json(res,404,{error:'本机样板没有这个入口。'});
    }catch(error){json(res,error.status||500,{error:error.status?error.message:'操作样板暂时不可用。'});}
  });
  return {server,lab, async close(){server.closeAllConnections();await new Promise(accept=>server.close(accept));await lab.close();}};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const preview=await createDrawingPreview();const port=Number(process.env.DRAWING_LAB_PORT||4357);
  if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('Invalid local preview port');
  preview.server.listen(port,'127.0.0.1',()=>console.log(`Drawing Step 0: http://127.0.0.1:${port}/start (synthetic, local only)`));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await preview.close();process.exit(0);});
}
