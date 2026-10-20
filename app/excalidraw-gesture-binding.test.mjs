import test from 'node:test';
import assert from 'node:assert/strict';
import {findGestureElement} from './games/draw-and-guess/excalidraw-surface.mjs';

test('a delayed editor commit never binds an erase gesture to the previous pen object',()=>{
  const old={id:'previous-pen',type:'freedraw',points:[[0,0],[100,0]]};
  const gesture={elementId:null,existingIds:new Set([old.id])};
  assert.equal(findGestureElement([old],gesture),undefined);
  assert.equal(gesture.elementId,null);
  const eraser={id:'new-eraser',type:'freedraw',points:[[0,0],[0,100]]};
  assert.equal(findGestureElement([old,eraser],gesture),eraser);
  assert.equal(gesture.elementId,eraser.id);
  const replacement={...eraser,points:[[0,0],[0,200]]};
  assert.equal(findGestureElement([old,replacement,{id:'unrelated',type:'freedraw'}],gesture),replacement);
  assert.equal(findGestureElement([old],gesture),undefined);
});

test('repeated pen and eraser gestures bind only to their own new live freedraw element',()=>{
  const scene=[{id:'saved-ink',type:'freedraw'},{id:'deleted',type:'freedraw',isDeleted:true}];
  for(let n=0;n<40;n++){
    const gesture={elementId:null,existingIds:new Set(scene.map(e=>e.id))};
    assert.equal(findGestureElement(scene,gesture),undefined);
    const current={id:`gesture-${n}`,type:'freedraw'};
    scene.push({id:`unsupported-${n}`,type:'image'},current);
    assert.equal(findGestureElement(scene,gesture),current);
  }
});
