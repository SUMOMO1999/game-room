import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPracticeExit, replacePracticeWithLobby } from './platform/practice-navigation.mjs';

test('explicit exit replaces the practice entry at root and mounted entry, retaining ordinary back/forward', () => {
  for (const base of ['https://game.example/', 'https://agora.example/game/']) {
    for (const page of ['practice.html', 'army-practice.html', 'flying-practice.html']) {
      const entries = [base, new URL(page, base).href]; let index = 1;
      const location = { replace(value) { entries[index] = new URL(value, entries[index]).href; } };
      replacePracticeWithLobby(location);
      assert.deepEqual(entries, [base, base]);
      index--; assert.equal(entries[index], base);
      index++; assert.equal(entries[index], base);
    }
  }
});

test('only the explicit unmodified practice exit click is intercepted, and unmount releases it', () => {
  const listeners = new Map(), anchor = { hasAttribute:()=>true, addEventListener:(type,callback)=>listeners.set(type,callback), removeEventListener:(type,callback)=>{assert.equal(listeners.get(type),callback);listeners.delete(type);} };
  const replacements = [], dispose = mountPracticeExit({ document:{querySelectorAll:()=>[anchor]}, location:{replace:value=>replacements.push(value)} });
  let prevented = 0;
  const click = listeners.get('click'), event = {button:0,preventDefault(){prevented++;}};
  for (const fields of [{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1},{defaultPrevented:true}]) click({...event,...fields});
  assert.equal(prevented,0);assert.deepEqual(replacements,[]);
  click(event);assert.equal(prevented,1);assert.deepEqual(replacements,['./']);
  dispose();assert.equal(listeners.size,0);
  assert.doesNotThrow(()=>mountPracticeExit({document:{querySelectorAll:()=>[]}})());
});

test('marked course switches replace one practice entry; other origins and paths are untouched', () => {
  for (const base of ['https://game.example/', 'https://agora.example/game/']) {
    const entries=[base,new URL('practice.html',base).href], handlers=[];let prevented=0;
    const controls=[['exit','./'],['exit','./'],['mode','practice.html?lesson=joker'],['mode','https://elsewhere.example/practice.html'],['mode','army-practice.html']].map(([kind,href])=>({
      href:new URL(href,base).href,hasAttribute:name=>name==='data-practice-exit'&&kind==='exit',
      addEventListener:(type,handler)=>handlers.push(handler),removeEventListener:()=>{},
    }));
    const location={get href(){return entries[1];},replace(value){entries[1]=new URL(value,entries[1]).href;}};
    const dispose=mountPracticeExit({document:{querySelectorAll:()=>controls},location});
    const event={button:0,preventDefault(){prevented++;}};
    handlers[3](event);handlers[4](event);assert.equal(prevented,0);
    handlers[2](event);assert.equal(entries[1],new URL('practice.html?lesson=joker',base).href);
    handlers[1](event);assert.deepEqual(entries,[base,base]);assert.equal(prevented,2);
    handlers[0](event);assert.equal(entries[1],base);
    dispose();
  }
});
