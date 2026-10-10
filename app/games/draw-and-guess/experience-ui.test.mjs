import test from 'node:test';
import assert from 'node:assert/strict';
import {drawingFeedbackTransition,createDrawingExperience} from './experience-ui.mjs';
import {drawingTestDOM} from '../../test-support/drawing-page-dom.mjs';

const view=(revision=1,extra={})=>({roomId:'room',matchId:'match',selfId:'guess',selfRole:'player',phase:'playing',
  game:{revision,turnId:'one',turnPlayerId:'draw',stage:'drawing',players:[{id:'draw',score:0},{id:'guess',score:0}],...extra}});
test('feedback follows new public score increases, never private answer/receipt text or restored snapshots',()=>{
  const before=view(),after=view(2,{stage:'reveal',players:[{id:'draw',score:25},{id:'guess',score:180}]});
  assert.deepEqual(drawingFeedbackTransition(before,after),{gains:[{id:'draw',points:25,drawer:true},{id:'guess',points:180,drawer:false}],stage:'reveal'});
  for(const options of [{baseline:true},{hidden:true}])assert.deepEqual(drawingFeedbackTransition(before,after,options),{gains:[],stage:null});
  for(const next of [after, {...after,roomId:'other'},{...after,selfId:'other'},{...after,selfRole:'spectator'}])
    assert.deepEqual(drawingFeedbackTransition(after,next),{gains:[],stage:null});
  const nextTurn=view(3,{turnId:'two',stage:'choosing',players:after.game.players});
  assert.deepEqual(drawingFeedbackTransition(after,nextTurn),{gains:[],stage:'choosing'});
});
test('seat cue is interrupted, hidden, reduced and destroyed without touching paper/input',()=>{
  const doc=drawingTestDOM('<head></head><body><main id="root"><div class="drawing-player" data-player-id="guess"><span class="drawing-score-gain" hidden></span></div><p id="drawing-stage"></p><p id="drawing-guess-feedback"></p><canvas id="paper"></canvas></main></body>');
  const win=new EventTarget(),media=new EventTarget(),timers=new Map();let serial=0,animated=0,cancelled=0;
  Object.assign(win,{setTimeout(fn){const id=++serial;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);},matchMedia:()=>media});media.matches=false;
  const root=doc.getElementById('root'),seat=root.querySelector('.drawing-player'),badge=seat.querySelector('.drawing-score-gain');
  seat.animate=()=>{animated++;return {cancel(){cancelled++;}};};
  const experience=createDrawingExperience({root,document:doc,window:win}),before=view(),after=view(2,{players:[{id:'draw',score:25},{id:'guess',score:175}]});
  experience.apply(before,after);assert.equal(animated,1);assert.equal(badge.textContent,'+175');assert.equal(badge.hidden,false);
  experience.apply(after,after);assert.equal(animated,1);
  doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));assert.equal(badge.hidden,true);assert.equal(timers.size,0);assert.equal(cancelled,1);
  doc.hidden=false;media.matches=true;experience.apply(before,after);assert.equal(animated,1);assert.equal(badge.textContent,'+175');
  win.dispatchEvent(new Event('resize'));assert.equal(badge.hidden,true);
  experience.apply(before,after,{baseline:true});assert.equal(badge.hidden,true);
  experience.apply(before,after);experience.apply(after,{...after,matchId:'new-match'});assert.equal(badge.hidden,true);assert.equal(timers.size,0);
  experience.apply(before,after);win.dispatchEvent(new Event('pagehide'));assert.equal(badge.hidden,true);assert.equal(timers.size,0);
  experience.apply(before,after);experience.destroy();assert.equal(timers.size,0);assert.equal(badge.hidden,true);
  assert.equal(doc.getElementById('paper').children.length,0);
});
