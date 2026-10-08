import { createDrawingPracticeSession } from './practice-engine.mjs';
import { createDrawingGamePage } from './game-page.mjs';

export async function bootDrawingPractice({document:doc=globalThis.document,window:win=globalThis.window}={}) {
  let session,ui;
  try {
    let storage;try{storage=win.localStorage;}catch{storage=null;}
    session=createDrawingPracticeSession({storage});
    ui=createDrawingGamePage({mode:'practice',document:doc,window:win,canvasRequest:async(type,input)=>{
      const response=await session.request(type,input);ui?.applyView(session.view(),{baseline:true});return response;
    },onCanvasError:error=>ui?.setMessage(error.message)});
    ui.applyView(session.view(),{baseline:true});
    const external=event=>{if(event.key===session.storageKey){ui.paint.finishPointer();ui.setMessage('另一标签页更新了练画，正在同步已保存的图。');ui.paint.refresh().catch(()=>{});}};
    win.addEventListener('storage',external);
    win.addEventListener('pagehide',event=>{if(!event.persisted){ui.destroy();session.destroy();win.removeEventListener('storage',external);}});
    await import('../../app-shell.mjs');return ui;
  }catch(error){session?.destroy();ui?.destroy();const root=doc.getElementById('drawing-root');root.replaceChildren();
    const text=doc.createElement('p');text.textContent=error.message||'练画暂时无法打开，已保存的原记录保持。';
    const exit=doc.createElement('a');exit.href='./';exit.dataset.practiceExit='';exit.textContent='返回大厅';root.append(text,exit);
    const {mountPracticeExit}=await import('../../platform/practice-navigation.mjs');mountPracticeExit({document:doc,location:win.location});
  }
}
if(typeof document!=='undefined'&&document.body?.dataset.mode==='drawing-practice')bootDrawingPractice();
