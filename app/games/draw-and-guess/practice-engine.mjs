import { entryStorageKey } from '../../entry-path.mjs';
import { drawingPacketProblem } from './canvas-view.mjs';
const key=entryStorageKey('game-room.drawing-practice.v1');
const clone=value=>structuredClone(value);
const id='local-drawing-practice',match='local-free-paint',turn='free-paint';
const packet=()=>({bootId:'drawing-practice-v1',canvasId:id,roomId:id,matchId:match,turnId:turn,stage:'drawing',deadline:null,paused:false,
  geometry:{width:1024,height:576},
  sequence:0,clearGeneration:0,leaseGeneration:0,strokes:[],pointCount:0});
export function practiceCanvasProblem(value) {
  if(!value||value.version!==1||Object.keys(value).some(field=>!['version','canvas','undone'].includes(field))
    ||!Array.isArray(value.undone)||value.undone.length>1500||drawingPacketProblem(value.canvas)
    ||value.canvas.canvasId!==id||value.canvas.roomId!==id||value.canvas.matchId!==match||value.canvas.turnId!==turn
    ||value.canvas.bootId!=='drawing-practice-v1'||value.canvas.stage!=='drawing'||value.canvas.deadline!==null||value.canvas.paused!==false
    ||drawingPacketProblem({...value.canvas,strokes:value.undone})
    ||value.canvas.strokes.length+value.undone.length>1500
    ||new Set([...value.canvas.strokes,...value.undone].map(stroke=>stroke.strokeId)).size!==value.canvas.strokes.length+value.undone.length
    ||[...value.canvas.strokes,...value.undone].reduce((n,stroke)=>n+stroke.points.length,0)>50000
    ||value.canvas.pointCount!==value.canvas.strokes.reduce((n,stroke)=>n+stroke.points.length,0))return '本机练画保存格式无效。';
  return null;
}
/** Local paint has no words, server, account, seats, score or chat. A compare
 * before save prevents another tab's artwork from being silently overwritten. */
export function createDrawingPracticeSession({storage=globalThis.localStorage,now=()=>Date.now()}={}) {
  let value={version:1,canvas:packet(),undone:[]},stored=null,available=!!storage?.getItem&&!!storage?.setItem,leaseUntil=0,leaseDevice=null,destroyed=false;
  try{stored=storage?.getItem(key)??null;if(stored){const saved=JSON.parse(stored);if(practiceCanvasProblem(saved))throw new Error('本机练画存档无效，未覆盖旧记录。');value=saved;}}
  catch(error){if(stored!==null)throw error;available=false;}
  function view(){return {gameType:'draw-and-guess',roomId:id,roomCode:'本机',matchId:match,phase:'playing',selfId:'local',selfRole:'player',players:[],spectators:[],storageAvailable:available,
    game:{matchId:match,turnId:turn,stage:'drawing',status:'playing',turnPlayerId:'local',players:[],guessedPlayerIds:[],revision:value.canvas.sequence,settings:{rounds:1,drawingSeconds:120},round:1,totalTurns:1,turnNumber:1,canDraw:true}};}
  function save(next){
    if(destroyed)throw new Error('练画已关闭。');
    if(available){let current;try{current=storage.getItem(key);}catch{available=false;}
      if(available&&current!==stored)throw Object.assign(new Error('另一标签页更新了练画。先重新同步，再继续。'),{code:'PRACTICE_CONFLICT',status:409});
      if(available){const text=JSON.stringify(next);try{storage.setItem(key,text);stored=text;}catch{available=false;}}}
    value=next;
  }
  function reload(){if(available){const text=storage.getItem(key);if(text!==stored){const saved=text===null?{version:1,canvas:packet(),undone:[]}:JSON.parse(text);
      if(practiceCanvasProblem(saved))throw new Error('另一标签页的存档无法恢复。');value=saved;stored=text;leaseUntil=0;leaseDevice=null;}}return clone(value.canvas);}
  const ack=()=>({bootId:value.canvas.bootId,canvasId:id,sequence:value.canvas.sequence,clearGeneration:value.canvas.clearGeneration,
    leaseGeneration:value.canvas.leaseGeneration,leaseValidUntil:leaseUntil,persisted:true,localOnly:true});
  async function request(type,input={}) {
    if(destroyed)throw new Error('练画已关闭。');if(type==='read')return reload();
    if(input.canvasId!==value.canvas.canvasId||input.bootId!==value.canvas.bootId)throw Object.assign(new Error('画布已经变化，请重新同步。'),{status:409});
    if(type==='acquire'){const next=clone(value);next.canvas.leaseGeneration++;save(next);leaseDevice=input.deviceId;leaseUntil=now()+24*60*60*1000;return {...ack(),validUntil:leaseUntil};}
    if(input.deviceId!==leaseDevice||input.leaseGeneration!==value.canvas.leaseGeneration||now()>=leaseUntil)throw Object.assign(new Error('请先在这里拿起画笔。'),{status:409});
    if(input.expectedSequence!==value.canvas.sequence||input.clearGeneration!==value.canvas.clearGeneration)throw Object.assign(new Error('画布已更新，请同步后继续。'),{status:409});
    const next=clone(value),canvas=next.canvas;
    if(type==='append') {
      if(drawingPacketProblem({...canvas,operations:input.operations},{snapshot:false}))throw new Error('笔画格式无效。');
      for(const part of input.operations){const existing=canvas.strokes.find(stroke=>stroke.strokeId===part.strokeId);
        if(existing){if(existing.tool!==part.tool||existing.color!==part.color||existing.width!==part.width||existing.points.length+part.points.length>4096)throw new Error('单笔格式或长度无效。');existing.points.push(...clone(part.points));}
        else canvas.strokes.push(clone(part));}next.undone=[];
    }else if(type==='undo'){if(canvas.strokes.length)next.undone.push(canvas.strokes.pop());}
    else if(type==='redo'){if(next.undone.length)canvas.strokes.push(next.undone.pop());}
    else if(type==='clear'){canvas.strokes=[];next.undone=[];canvas.clearGeneration++;}
    else throw new Error('练画操作无效。');
    canvas.pointCount=canvas.strokes.reduce((count,stroke)=>count+stroke.points.length,0);canvas.sequence++;
    if(drawingPacketProblem(canvas)||JSON.stringify(next).length>2*1024*1024)throw new Error('本机练画已达到上限，请撤销或清空。');
    save(next);return {ack:ack(),duplicate:false};
  }
  return {view,request,storageKey:key,storageAvailable:()=>available,destroy(){destroyed=true;leaseUntil=0;}};
}
