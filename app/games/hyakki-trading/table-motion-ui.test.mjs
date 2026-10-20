import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mountTableMotion } from './table-motion-ui.mjs';

// This fixture controls animation completion. Real geometry and artwork are
// independently checked in Chrome; these tests protect interrupted lifetimes.
function fixture({reduced=false}={}) {
  const animations=[],window=new EventTarget(),document=new EventTarget(),targets=new Map();
  Object.assign(window,{matchMedia:()=>({matches:reduced})});
  Object.assign(document,{defaultView:window,hidden:false});
  class Node {
    constructor(){this.style={visibility:'',setProperty(name,value){this[name]=value;}};this.attributes=new Map();this.children=[];this.parentNode=null;this.ownerDocument=document;}
    setAttribute(name,value){this.attributes.set(name,String(value));}
    getAttribute(name){return this.attributes.get(name)??null;}
    removeAttribute(name){this.attributes.delete(name);}
    querySelectorAll(){return this.children.flatMap(child=>[child,...child.querySelectorAll()]);}
    querySelector(selector){return targets.get(selector)??null;}
    getBoundingClientRect(){return {x:10,y:20,width:100,height:160};}
    cloneNode(){const copy=new Node();copy.style={...this.style};copy.attributes=new Map(this.attributes);this.children.forEach(child=>copy.append(child.cloneNode()));return copy;}
    append(child){child.remove();child.parentNode=this;this.children.push(child);}
    replaceChildren(child){this.children.forEach(entry=>{entry.parentNode=null;});this.children=[];this.append(child);}
    remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child=>child!==this);this.parentNode=null;}
    animate(){let resolve,reject;const finished=new Promise((yes,no)=>{resolve=yes;reject=no;});const animation={finished,resolve,cancel(){reject(new DOMException('cancelled','AbortError'));}};animations.push(animation);return animation;}
  }
  document.createElement=()=>new Node();
  const root=new Node(),source=new Node(),destination=new Node();
  root.append(source);root.append(destination);targets.set('.destination',destination);
  const errors=[],motion=mountTableMotion({root,onError:error=>errors.push(error)});
  return {root,source,destination,targets,animations,motion,window,document,Node,errors};
}

test('capture paints a visible copy and strips all private identities and action hooks',()=>{
  const f=fixture();f.source.style.visibility='hidden';
  f.source.setAttribute('data-entity-id','secret-copy');f.source.setAttribute('data-hy-action','confirm-card');
  const child=new f.Node();child.setAttribute('data-card-id','visible-definition');child.setAttribute('id','button-id');f.source.append(child);
  const snapshot=f.motion.capture(f.source);
  assert.equal(snapshot.node.style.visibility,'');
  assert.equal(snapshot.node.getAttribute('data-entity-id'),null);
  assert.equal(snapshot.node.getAttribute('data-hy-action'),null);
  assert.equal(snapshot.node.children[0].getAttribute('data-card-id'),null);
  assert.equal(snapshot.node.children[0].getAttribute('id'),null);
  f.motion.destroy();
});

test('a travelling card keeps its actual face budget after leaving the original stock',()=>{
  const f=fixture();f.source.matches=selector=>selector==='.yousei-card';
  f.window.getComputedStyle=()=>({width:'80px',height:'112px'});
  const snapshot=f.motion.capture(f.source);
  assert.equal(snapshot.node.style['--hyakki-card-width'],'80px');
  assert.equal(snapshot.node.style['--hyakki-card-height'],'112px');
  assert.equal(f.source.style['--hyakki-card-width'],undefined,'capture cannot change the live hand');
  f.motion.destroy();
});

test('a pending status rerender rebinds the destination and always reveals the final card',async()=>{
  const f=fixture(),flight=f.motion.move({from:f.motion.capture(f.source),to:'.destination'});
  assert.equal(f.destination.style.visibility,'hidden');
  const replacement=new f.Node();f.root.append(replacement);f.targets.set('.destination',replacement);f.motion.sync();
  assert.equal(f.destination.style.visibility,'');assert.equal(replacement.style.visibility,'hidden');
  f.animations[0].resolve();await flight;
  assert.equal(replacement.style.visibility,'');assert.equal(f.root.children.length,3);assert.deepEqual(f.errors,[]);
  f.motion.destroy();
});

test('rapid second input cancels the first flight without restoring hidden over the next destination',async()=>{
  const f=fixture(),first=f.motion.move({from:f.motion.capture(f.source),to:'.destination'});
  const second=f.motion.move({from:f.motion.capture(f.destination),to:'.destination'});
  assert.equal(f.root.children.at(-1).children[0].style.visibility,'');
  await first;assert.equal(f.destination.style.visibility,'hidden');
  f.animations[1].resolve();await second;
  assert.equal(f.destination.style.visibility,'');assert.deepEqual(f.errors,[]);f.motion.destroy();
});

test('reduced motion uses the confirmed final face and lifecycle interruption cleans listeners',async()=>{
  const reduced=fixture({reduced:true});await reduced.motion.move({from:reduced.motion.capture(reduced.source),to:'.destination',flip:true});
  assert.equal(reduced.animations.length,0);assert.equal(reduced.destination.style.visibility,'');reduced.motion.destroy();
  const f=fixture(),flight=f.motion.move({from:f.motion.capture(f.source),to:'.destination'});
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));await flight;
  assert.equal(f.destination.style.visibility,'');f.motion.destroy();f.motion.destroy();
  assert.equal(getEventListeners(f.document,'visibilitychange').length,0);assert.equal(getEventListeners(f.window,'resize').length,0);
});
