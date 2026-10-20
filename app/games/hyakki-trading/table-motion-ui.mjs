/** Local presentation only. Every confirmed move is described from the current role projection. */
export function mountTableMotion({root,onError=error=>root.ownerDocument.defaultView.console?.warn('Table presentation interrupted',error)}) {
  const window=root.ownerDocument.defaultView;
  let generation=0,destroyed=false;
  const active=new Set();
  const reduced=()=>window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  function capture(selector) {
    const node=typeof selector==='string'?root.querySelector(selector):selector;
    if(!node)return null;
    const rect=node.getBoundingClientRect();
    if(!rect.width||!rect.height)return null;
    const copy=node.cloneNode(true);
    // A confirmed destination may be temporarily hidden by the previous flight.
    // The travelling copy always paints independently of that presentation state.
    copy.style.visibility='';
    const originals=[node,...node.querySelectorAll('*')];
    const copies=[copy,...copy.querySelectorAll('*')];
    for(const [index,item] of copies.entries()){
      // The flight leaves its hand/source stock. Carry the rendered card budget
      // with it so the face does not revert to a different ancestor's defaults.
      if(originals[index]?.matches?.('.yousei-card')&&window.getComputedStyle){
        const size=window.getComputedStyle(originals[index]);
        item.style.setProperty('--hyakki-card-width',size.width);
        item.style.setProperty('--hyakki-card-height',size.height);
      }
      item.removeAttribute('id');item.removeAttribute('data-entity-id');item.removeAttribute('data-hy-action');
      item.removeAttribute('data-hy-fields');item.removeAttribute('data-card-id');item.setAttribute('tabindex','-1');
    }
    return {rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},node:copy};
  }
  function cancel() {generation++;for(const record of active){record.animation?.cancel();record.ghost.remove();if(record.destination)record.destination.style.visibility=record.previousVisibility;}active.clear();}
  function sync() {
    for(const record of active){
      if(!record.selector)continue;
      const destination=root.querySelector(record.selector);
      if(!destination){cancel();return;}
      if(destination===record.destination)continue;
      record.destination.style.visibility=record.previousVisibility;
      record.destination=destination;record.previousVisibility=destination.style.visibility;
      destination.style.visibility='hidden';
    }
  }
  async function move({from,to,flip=false,duration=240}={}) {
    // There is one local working object. A second deliberate input finishes the
    // previous presentation immediately, then starts from the confirmed table.
    cancel();
    if(destroyed||!from||root.ownerDocument.hidden)return;
    const destination=typeof to==='string'?root.querySelector(to):to;
    const target=capture(destination);if(!target)return;
    if(reduced()||!destination.animate)return;
    const stamp=generation,ghost=root.ownerDocument.createElement('div');
    ghost.className='hy-table-motion';ghost.setAttribute('aria-hidden','true');ghost.append(from.node);
    const a=from.rect,b=target.rect;
    Object.assign(ghost.style,{left:`${a.x}px`,top:`${a.y}px`,width:`${a.width}px`,height:`${a.height}px`});
    root.append(ghost);
    const record={ghost,destination,selector:typeof to==='string'?to:null,previousVisibility:destination.style.visibility,animation:null};active.add(record);
    destination.style.visibility='hidden';
    try{
      record.animation=ghost.animate([{left:`${a.x}px`,top:`${a.y}px`,width:`${a.width}px`,height:`${a.height}px`,transform:'rotate(-4deg)'},{left:`${b.x}px`,top:`${b.y}px`,width:`${b.width}px`,height:`${b.height}px`,transform:'rotate(0deg)'}],{duration,easing:'cubic-bezier(.2,.75,.3,1)',fill:'forwards'});
      await record.animation.finished;
      if(stamp!==generation||destroyed)return;
      if(flip){
        record.animation=ghost.animate([{transform:'rotateY(0deg)'},{transform:'rotateY(90deg)'}],{duration:100,easing:'ease-in',fill:'forwards'});await record.animation.finished;
        if(stamp!==generation||destroyed)return;
        ghost.replaceChildren(target.node);
        record.animation=ghost.animate([{transform:'rotateY(-90deg)'},{transform:'rotateY(0deg)'}],{duration:120,easing:'ease-out',fill:'forwards'});await record.animation.finished;
      }
    }catch(error){if(error?.name!=='AbortError')onError(error);}
    finally{ghost.remove();if(stamp===generation)record.destination.style.visibility=record.previousVisibility;active.delete(record);}
  }
  const hide=()=>{if(root.ownerDocument.hidden)cancel();};
  root.ownerDocument.addEventListener('visibilitychange',hide);window.addEventListener('resize',cancel);
  return {capture,move,cancel,sync,destroy(){if(destroyed)return;destroyed=true;cancel();root.ownerDocument.removeEventListener('visibilitychange',hide);window.removeEventListener('resize',cancel);}};
}
