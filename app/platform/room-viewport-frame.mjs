import {gameViewport} from '../game-viewport.mjs';

// A window owns geometry only. No game/view/draft is stored in this registry.
const owners = new WeakMap();
const same = (a,b) => a && b && ['width','height','top','left','resetScroll','keyboard','layoutWidth','layoutHeight'].every(key=>a[key]===b[key]);

export function measureRoomViewport(window,document) {
  const width=window.innerWidth,height=window.innerHeight,visual=window.visualViewport;
  const snapshot=visual&&Object.fromEntries(['width','height','scale','offsetTop','offsetLeft'].map(key=>[key,visual[key]]));
  const field=document.activeElement;
  const editing=!!field?.matches?.('input,textarea,select,[contenteditable="true"]')
    && !field?.matches?.('input[type="checkbox"],input[type="radio"],input[type="range"],input[type="button"],input[type="submit"]');
  const normal=!snapshot||Math.abs((snapshot.scale??1)-1)<=.025;
  let usable=snapshot;
  if(normal&&snapshot)usable=Math.abs(snapshot.width-width)<=2?{...snapshot,height:Math.min(height,snapshot.height)}:null;
  const frame=gameViewport({width,height,visual:usable,editing});
  return {...frame,keyboard:editing&&!!usable&&height-usable.height>80,
    // Pinch zoom and active editing retain the existing layout viewport rules.
    // Their visual crop is handled by the game's established input/zoom owner.
    layoutWidth:editing||!normal?width:frame.width,layoutHeight:editing||!normal?height:frame.height};
}

/** A committed pair for layout; before opt-in mount, use the original reader. */
export function roomViewportFrame(window,document) {
  return owners.get(window)?.frame ?? gameViewport({width:window.innerWidth,height:window.innerHeight,
    visual:window.visualViewport,editing:!!document.activeElement?.matches?.('input,textarea,select,[contenteditable="true"]')});
}

function mountSizeContext(window,document) {
  const root=document.documentElement;
  const supported=!!window.CSS?.supports?.('container-type','size');
  if(!supported)return {apply(){},destroy(){}};
  const keys=['container-type','container-name','width','height','--room-vw','--room-vh'];
  const saved=keys.map(key=>[key,root.style.getPropertyValue(key),root.style.getPropertyPriority?.(key)??'']);
  const marker=root.getAttribute('data-room-viewport');
  return {apply(frame){
    if(!supported)return;
    root.setAttribute('data-room-viewport','');
    root.style.setProperty('container-type','size');root.style.setProperty('container-name','room-viewport');
    root.style.setProperty('width',frame.layoutWidth+'px');root.style.setProperty('height',frame.layoutHeight+'px');
    root.style.setProperty('--room-vw',frame.layoutWidth/100+'px');root.style.setProperty('--room-vh',frame.layoutHeight/100+'px');
  },destroy(){
    for(const [key,value,priority]of saved){if(value)root.style.setProperty(key,value,priority);else root.style.removeProperty(key);}
    if(marker===null)root.removeAttribute('data-room-viewport');else root.setAttribute('data-room-viewport',marker);
  }};
}

/** Opt-in coherent geometry shared by actual game entries. A bounded polling
 * tail handles late iOS handoffs even if their last update has no resize event.
 * Explicit recovery hooks run once per recovery event, never on each poll.
 */
export function mountCoherentViewport({window,document,sync,onRecover=()=>{},
  setTimeout=globalThis.setTimeout,clearTimeout=globalThis.clearTimeout,now=()=>performance.now(),recoverKeyboardCompression=false}={}) {
  if(owners.has(window))throw new Error('A game viewport owner is already mounted in this window.');
  const state={frame:null};owners.set(window,state);
  const context=mountSizeContext(window,document),removers=[];
  let candidate=null,repeats=0,timer=null,until=0,destroyed=false,keyboardWidth=null;
  function measure(){
    const frame=measureRoomViewport(window,document),visual=window.visualViewport;
    const normal=!visual||Math.abs((visual.scale??1)-1)<.01;
    const compressed=frame.height<window.innerHeight*.78;
    if(recoverKeyboardCompression&&normal){
      if(!frame.resetScroll&&compressed)keyboardWidth=frame.width;
      if(frame.resetScroll&&keyboardWidth!==null&&Math.abs(keyboardWidth-frame.width)<4&&compressed){
        const restored=gameViewport({width:window.innerWidth,height:window.innerHeight,editing:false});
        return {...restored,keyboard:false,layoutWidth:restored.width,layoutHeight:restored.height};
      }
      if(frame.resetScroll&&(!compressed||keyboardWidth!==null&&Math.abs(keyboardWidth-frame.width)>=4))keyboardWidth=null;
    }
    return frame;
  }
  function commit(frame){
    if(same(state.frame,frame))return;
    state.frame=frame;context.apply(frame);sync(frame);
    window.dispatchEvent(new (window.Event??Event)('roomviewportchange'));
  }
  function sample(){
    const next=measure();
    repeats=same(candidate,next)?repeats+1:0;candidate=next;
    if(repeats>=2)commit(next);
  }
  function poll(){
    timer=null;if(destroyed)return;sample();
    if(now()<until||!same(candidate,state.frame)&&repeats<2&&now()<until+120)timer=setTimeout(poll,40);
  }
  function schedule(pin=true){
    if(destroyed)return;until=now()+1200;
    const next=measure();
    // Input/zoom must track the actual visual crop immediately. Normal rotation
    // waits for a stable pair, while pinning structural scroll with the old pair.
    if(!next.resetScroll||state.frame?.resetScroll===false)commit(next);else if(pin)sync(state.frame);
    sample();
    if(timer===null)timer=setTimeout(poll,40);
  }
  function recover(){if(destroyed)return;onRecover();schedule();}
  function update(){if(destroyed)return;if(!same(measure(),state.frame))schedule();else sync(state.frame);}
  function listen(target,type,handler){target?.addEventListener?.(type,handler);removers.push(()=>target?.removeEventListener?.(type,handler));}
  listen(window,'resize',schedule);listen(window.visualViewport,'resize',schedule);listen(window.visualViewport,'scroll',schedule);
  listen(window,'orientationchange',recover);listen(window.screen?.orientation,'change',recover);listen(window,'pageshow',recover);listen(window,'focus',recover);
  listen(document,'focusin',schedule);
  listen(document,'focusout',event=>{if(event.target?.matches?.('input,textarea,select,[contenteditable="true"]'))recover();});
  listen(document,'visibilitychange',()=>{if(!document.hidden)recover();});
  commit(measure());schedule(false);
  return {sync:update,recover,destroy(){
    if(destroyed)return;destroyed=true;if(timer!==null)clearTimeout(timer);
    removers.forEach(remove=>remove());context.destroy();owners.delete(window);
  }};
}
