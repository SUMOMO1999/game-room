import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoomSystemDriver} from './room-system-driver.mjs';

test('system driver coalesces wakes and yields after exactly sixteen authority attempts',async()=>{
  let attempts=0,release;const queued=[];
  const gate=new Promise(resolve=>{release=resolve;});
  const driver=createRoomSystemDriver({advance:async()=>{await gate;return ++attempts<20;},schedule:callback=>{queued.push(callback);return callback;},cancel:handle=>queued.splice(queued.indexOf(handle),1)});
  const first=driver.wake('one');assert.equal(driver.wake('one'),first);release();await first;
  assert.equal(attempts,16);assert.equal(queued.length,1);queued.shift()();await driver.wake('one');
  assert.equal(attempts,20);assert.equal(queued.length,0);await driver.close();
});
test('unknown commit stops without auto replay; a later explicit wake reads new authority',async()=>{
  let calls=0,schedules=0;
  const driver=createRoomSystemDriver({advance:async()=>{if(++calls===1)throw new Error('commit result unknown');return false;},schedule:()=>{schedules++;}});
  await assert.rejects(driver.wake('one'),/unknown/);assert.equal(calls,1);assert.equal(schedules,0);
  await driver.wake('one');assert.equal(calls,2);await driver.close();assert.equal(await driver.wake('one'),false);
});
test('closing cancels queued continuation and never performs another system attempt',async()=>{
  let calls=0,cancelled=0;
  const driver=createRoomSystemDriver({advance:async()=>{calls++;return true;},schedule:()=>7,cancel:handle=>{assert.equal(handle,7);cancelled++;}});
  await driver.wake('one');await driver.close();assert.equal(calls,16);assert.equal(cancelled,1);await driver.wake('one');assert.equal(calls,16);
});
