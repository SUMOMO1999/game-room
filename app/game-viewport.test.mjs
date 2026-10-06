import test from 'node:test';
import assert from 'node:assert/strict';
import {gameViewport} from './game-viewport.mjs';
test('portrait-landscape-portrait ignores stale normal-scale offsets and transitional old dimensions',()=>{
  assert.deepEqual(gameViewport({width:390,height:844,visual:{width:390,height:844,offsetTop:70,offsetLeft:12,scale:1}}),{width:390,height:844,top:0,left:0,resetScroll:true});
  assert.equal(gameViewport({width:844,height:390,visual:{width:390,height:844,offsetTop:70,scale:1}}).height,390);
  assert.equal(gameViewport({width:390,height:844,visual:{width:844,height:390,scale:1}}).height,844);
});
test('keyboard and deliberate zoom keep the visible viewport without forcibly moving the document',()=>{
  const keyboard=gameViewport({width:390,height:844,editing:true,visual:{width:390,height:430,offsetTop:112,scale:1}});
  assert.deepEqual(keyboard,{width:390,height:430,top:112,left:0,resetScroll:false});
  const zoom=gameViewport({width:390,height:844,visual:{width:195,height:422,offsetLeft:25,offsetTop:40,scale:2}});
  assert.deepEqual(zoom,{width:195,height:422,top:40,left:25,resetScroll:false});
});
