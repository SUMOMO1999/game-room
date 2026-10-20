/** Excalidraw is the actual editor, not a hidden input probe. Only room policy,
 * fixed-paper projection and the existing persisted stroke contract live here.
 * The native freehand renderer and properties UI are used by drawers/viewers. */
import { DRAW_COLORS } from './paint-colors.mjs';

// Pointer-down notification can precede React's committed scene. Bind only to
// this gesture's new object; the previous last stroke is never its input.
export function findGestureElement(elements,gesture) {
  if(gesture.elementId)return elements.find(element=>element.id===gesture.elementId);
  const element=elements.find(element=>element.type==='freedraw'&&!element.isDeleted&&!gesture.existingIds.has(element.id));
  if(element)gesture.elementId=element.id;
  return element;
}

export function createExcalidrawSurface({canvas,host,onBegin,onPoints,onEnd,onStyle,onCommand,onError}) {
  const doc=host.ownerDocument,win=doc.defaultView;
  const mount=doc.createElement('div');mount.className='drawing-editor';host.append(mount);
  canvas.classList.add('drawing-legacy-canvas');
  let api,restore,toViewport,unsubscribe,latest,dead=false,applying=false,gesture=null,projectionKey='',frame=null,suppress=false,unmount=()=>{},viewKey='',propertiesOpen=false;
  const elementsByStroke=new Map();
  // Own only this added color grid. Upstream still owns its native properties,
  // custom picker and all pen input/rendering; never replace its managed nodes.
  let quickPalette=null;
  function refreshPalette(){
    if(dead)return;
    const picker=mount.querySelector('.panelColumn button[aria-label="描边"]')?.closest('.color-picker-container');
    if(!picker){quickPalette?.remove();quickPalette=null;return;}
    if(!quickPalette?.isConnected){
      quickPalette=doc.createElement('div');quickPalette.className='drawing-quick-colors';quickPalette.setAttribute('role','group');quickPalette.setAttribute('aria-label','画笔颜色');
      for(const [color,name] of DRAW_COLORS){
        const button=doc.createElement('button');button.type='button';button.dataset.drawingColor=color;button.title=name;button.setAttribute('aria-label',`${name}色`);button.style.setProperty('--drawing-swatch',color);
        button.addEventListener('click',()=>{if(!api||!latest?.enabled||latest.style.tool!=='pen')return;
          api.updateScene({appState:{currentItemStrokeColor:color},captureUpdate:'NEVER'});onStyle({color});refreshPalette();});
        quickPalette.append(button);
      }
      picker.parentElement.insertBefore(quickPalette,picker);
    }
    for(const button of quickPalette.children){button.disabled=!latest?.enabled;button.setAttribute('aria-pressed',String(button.dataset.drawingColor===latest?.style.color));}
  }
  const paletteObserver=new win.MutationObserver(refreshPalette);paletteObserver.observe(mount,{childList:true,subtree:true});
  // Retain the game's three named pen sizes while using upstream's native
  // thin/bold/extra-bold controls. Eraser sizes remain independent.
  const editorWidth=(width,tool)=>tool==='pen'?({4:1,10:2,22:4}[width]??width/4.25):width/4.25;
  const readNative=()=>{
    if(!gesture||!api||suppress)return;
    const element=findGestureElement(api.getSceneElements(),gesture);
    if(!element)return;
    gesture.elementId=element.id;
    const state=api.getAppState(),box=host.getBoundingClientRect();
    const points=element.points.slice(gesture.count).map(([x,y])=>{
      const point=toViewport({sceneX:element.x+x,sceneY:element.y+y},state);
      return [(point.x-box.left)/box.width,(point.y-box.top)/box.height];
    });
    gesture.count=element.points.length;
    if(points.length){const accepted=onPoints(points),point=points.at(-1),box=host.getBoundingClientRect();gesture.last={clientX:box.left+point[0]*box.width,clientY:box.top+point[1]*box.height};
      if(accepted===false&&!gesture.stopped){const current=gesture;gesture.stopped=true;win.queueMicrotask(()=>{if(gesture===current)finish();});}}
  };
  function pointerDown(event){
    if(dead||!gesture)return;
    findGestureElement(api.getSceneElements(),gesture);
  }
  function pointerUp(){
    if(!gesture||suppress)return;
    const current=gesture;
    // Upstream emits onPointerUp before committing its final coordinate. Read
    // after that same event completes, before the next browser input task.
    win.queueMicrotask(()=>{if(gesture===current&&!suppress)finalize();});
  }
  function finalize(){
    if(!gesture||suppress)return;
    readNative();gesture=null;onEnd();projectionKey='';schedule();
  }
  function change(elements,state){
    if(dead||applying||!api||state.isLoading)return;
    if(elements.some(e=>!e.isDeleted&&e.type!=='freedraw')){projectionKey='';schedule();return;}
    if(gesture){readNative();return;}
    const zoom=host.getBoundingClientRect().width/latest.geometry.width;
    if(Math.abs(state.zoom.value-zoom)>.001||state.scrollX!==0||state.scrollY!==0||latest.enabled&&state.activeTool.type!=='freedraw'||state.openSidebar)schedule();
  }
  function schedule(){if(dead||frame!==null)return;frame=win.requestAnimationFrame(()=>{frame=null;sync();});}
  function sync(){
    if(dead||!api||!latest||api.getAppState().isLoading)return;
    const {geometry,snapshot,pending,active,enabled,style}=latest;
    if(gesture){
      const state=api.getAppState(),zoom=host.getBoundingClientRect().width/geometry.width;
      if(Math.abs(state.zoom.value-zoom)>.001){applying=true;try{api.updateScene({appState:{scrollX:0,scrollY:0,zoom:{value:zoom}},captureUpdate:'NEVER'});}finally{applying=false;}}
      return;
    }
    const merged=new Map();
    for(const item of [...(snapshot?.strokes??[]),...pending,...(active?[active]:[])]){
      let target=merged.get(item.strokeId);if(!target){target={...item,points:[]};merged.set(item.strokeId,target);}target.points.push(...item.points);
    }
    const key=JSON.stringify([snapshot?.canvasId,snapshot?.sequence,[...merged.values()].map(s=>[s.strokeId,s.points.length])]);
    const appState=api.getAppState(),zoom=Math.max(.05,host.getBoundingClientRect().width/geometry.width);
    const patch={openSidebar:null,viewModeEnabled:!enabled,viewBackgroundColor:'#ffffff',scrollX:0,scrollY:0,zoom:{value:zoom},currentItemStrokeColor:style.tool==='eraser'?'#ffffff':style.color,
      currentItemStrokeWidth:editorWidth(style.width,style.tool),currentItemOpacity:100,currentItemRoughness:0};
    const nextViewKey=JSON.stringify(patch);
    applying=true;
    try{
      if(key!==projectionKey){
        const projected=[];
        for(const item of merged.values()){
          if(!item.points.length)continue;
          const id=item.strokeId;
          const previous=elementsByStroke.get(item.strokeId),signature=JSON.stringify([item.tool,item.color,item.width,item.points]);
          if(previous?.signature===signature){projected.push(previous.element);continue;}
          const points=item.points.map(([x,y])=>[x*geometry.width,y*geometry.height]),first=points[0];
          if(points.length===1)points.push([first[0]+.0001,first[1]+.0001]);
          let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
          for(const [x,y]of points){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
          const restored=restore([{id,type:'freedraw',x:first[0],y:first[1],width:maxX-minX,height:maxY-minY,points:points.map(([x,y])=>[x-first[0],y-first[1]]),
            pressures:[],simulatePressure:true,strokeColor:item.tool==='eraser'?'#ffffff':item.color,strokeWidth:editorWidth(item.width,item.tool),
            opacity:100,roughness:0,seed:1,version:(snapshot?.sequence??0)+1,versionNonce:1,updated:1}],null)[0];
          // Keep a stable object when the persisted path hasn't changed. This
          // retains the upstream renderer's path cache across ordinary UI ticks.
          if(!restored)throw new Error('画布笔迹无法转换为编辑器对象。');
          elementsByStroke.set(item.strokeId,{signature,element:restored});projected.push(restored);
        }
        for(const id of elementsByStroke.keys())if(!merged.has(id))elementsByStroke.delete(id);
        api.updateScene({elements:projected,appState:patch,captureUpdate:'NEVER'});projectionKey=key;
        api.history.clear();
      }else if(nextViewKey!==viewKey||Math.abs(appState.zoom.value-zoom)>.001||appState.scrollX!==0||appState.scrollY!==0||appState.openSidebar)api.updateScene({appState:patch,captureUpdate:'NEVER'});
      viewKey=nextViewKey;
      if(enabled&&api.getAppState().activeTool.type!=='freedraw')api.setActiveTool({type:'freedraw',locked:true});
    }finally{applying=false;}
    mount.classList.toggle('drawing-editor-readonly',!enabled);
  }
  import('../../vendor/excalidraw-0.18.1/editor.js').then(({mountEditor})=>{
    if(dead)return;
    unmount=mountEditor(mount,{ready(editor,helpers){
    if(dead)return;api=editor;restore=helpers.restoreElements;toViewport=helpers.sceneCoordsToViewportCoords;unsubscribe=helpers.off;
    const ready=()=>{if(dead)return;if(api.getAppState().isLoading){win.requestAnimationFrame(ready);return;}projectionKey='';sync();if(propertiesOpen)api.updateScene({appState:{openMenu:'shape'},captureUpdate:'NEVER'});};ready();
    },change,pointerDown,pointerUp,error:onError});
  }).catch(error=>{if(!dead){mount.textContent='画笔未能加载，请重新连接。';onError(error);}});
  // Room history is authoritative. Capture native shortcuts before upstream
  // local history can diverge from the saved sequence or a delayed append.
  function keydown(event){
    if(event.target.closest('input,textarea,button,[role=dialog]'))return;
    if((event.metaKey||event.ctrlKey)&&['z','y'].includes(event.key.toLowerCase())){event.preventDefault();event.stopImmediatePropagation();finish();void onCommand(event.shiftKey||event.key.toLowerCase()==='y'?'redo':'undo');}
    else if(event.key!=='Tab'&&event.key!=='Escape'){event.preventDefault();event.stopImmediatePropagation();}
  }
  function authorize(event){
    if(event.target.tagName!=='CANVAS')return;
    if(!latest?.enabled||gesture||event.button!==0||event.isPrimary===false||!onBegin(event)){event.preventDefault();event.stopImmediatePropagation();return;}
    gesture={event,count:0,elementId:null,existingIds:new Set(api.getSceneElements().map(element=>element.id))};
  }
  const wheel=event=>{event.preventDefault();event.stopImmediatePropagation();};
  function nativeStyle(event){
    if(event.target.tagName==='CANVAS'||!latest?.enabled||latest.style.tool==='eraser')return;
    win.requestAnimationFrame(()=>{if(dead||!api||!latest?.enabled)return;const state=api.getAppState();
      const color=state.currentItemStrokeColor,width=({1:4,2:10,4:22}[state.currentItemStrokeWidth]??Math.max(1,Math.min(32,Math.round(state.currentItemStrokeWidth*4.25))));
      if(color!==latest.style.color||width!==latest.style.width)onStyle({color,width});});
  }
  mount.addEventListener('pointerdown',authorize,{capture:true});mount.addEventListener('wheel',wheel,{capture:true,passive:false});
  const blockObjectInput=event=>{if(event.type==='paste'&&event.target.closest('input,textarea'))return;event.preventDefault();event.stopImmediatePropagation();};
  for(const type of ['contextmenu','paste','dragover','drop'])mount.addEventListener(type,blockObjectInput,{capture:true});
  const interrupt=event=>{if(gesture&&(event.type==='blur'||event.pointerId===gesture.event.pointerId))finish();};
  win.addEventListener('pointercancel',interrupt,{capture:true});win.addEventListener('blur',interrupt);
  mount.addEventListener('click',nativeStyle);mount.addEventListener('input',nativeStyle);mount.addEventListener('change',nativeStyle);
  mount.addEventListener('keydown',keydown,{capture:true});
  function finish(){if(!gesture)return;const event=gesture.event,point=gesture.last??event;win.dispatchEvent(new win.PointerEvent('pointerup',{pointerId:event.pointerId,pointerType:event.pointerType,button:0,buttons:0,bubbles:true,clientX:point.clientX,clientY:point.clientY}));finalize();}
  function cancel(){if(gesture){suppress=true;finish();gesture=null;suppress=false;projectionKey='';}schedule();}
  return {
    render(value){
      // Ink points can arrive every frame. Only style/permission changes touch
      // the color controls; the observer handles native panel remounts.
      const controlsChanged=!latest||latest.enabled!==value.enabled||latest.style.tool!==value.style.tool||latest.style.color!==value.style.color;
      latest=value;if(controlsChanged)refreshPalette();schedule();
    },cancel,finish,resize(){api?.refresh();schedule();},
    setProperties(open){propertiesOpen=!!open;api?.updateScene({appState:{openMenu:propertiesOpen?'shape':null},captureUpdate:'NEVER'});},
    destroy(){if(dead)return;cancel();dead=true;paletteObserver.disconnect();quickPalette?.remove();if(frame!==null)win.cancelAnimationFrame(frame);unsubscribe?.();mount.removeEventListener('keydown',keydown,{capture:true});mount.removeEventListener('pointerdown',authorize,{capture:true});mount.removeEventListener('wheel',wheel,{capture:true});for(const type of ['contextmenu','paste','dragover','drop'])mount.removeEventListener(type,blockObjectInput,{capture:true});win.removeEventListener('pointercancel',interrupt,{capture:true});win.removeEventListener('blur',interrupt);for(const type of ['click','input','change'])mount.removeEventListener(type,nativeStyle);unmount();mount.remove();canvas.classList.remove('drawing-legacy-canvas');},
  };
}
