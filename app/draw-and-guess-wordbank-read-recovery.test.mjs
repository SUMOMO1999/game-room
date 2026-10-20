import test from 'node:test';import assert from 'node:assert/strict';
import {loadAccount,accountState} from './account-client.mjs';
import {requestWordbank,createWordbankPageController} from './games/draw-and-guess/wordbank-page.mjs';
const realFetch=globalThis.fetch,realTimeout=globalThis.setTimeout;
async function login(){globalThis.fetch=async()=>new Response(JSON.stringify({mode:'cognito',authenticated:true,loginReady:true,userKey:'a'.repeat(64),csrf:'synthetic-read-test',drawingEnabled:true}),{status:200,headers:{'Content-Type':'application/json'}});await loadAccount();}
for(const method of ['GET','POST'])test(`${method} local timeout preserves verified identity and can retry without logging in`,async()=>{
 try{await login();globalThis.fetch=()=>new Promise(()=>{});globalThis.setTimeout=(f,ms,...a)=>realTimeout(f,ms===10000?0:ms,...a);
  await assert.rejects(requestWordbank('/api/wordbanks',method==='GET'?{}:{method,body:{requestId:'synthetic'}}),e=>e.status===504&&e.code===(method==='GET'?'WORD_BANK_READ_TIMEOUT':'UNKNOWN_RESULT'));
  assert.equal(accountState().authenticated,true);assert.equal(accountState().verification,'verified');
  globalThis.fetch=async()=>new Response(JSON.stringify({packs:[{id:'dg-base'}]}),{status:200});assert.equal((await requestWordbank('/api/wordbanks')).packs[0].id,'dg-base');
 }finally{globalThis.fetch=realFetch;globalThis.setTimeout=realTimeout;}
});
for(const [status,code,clears] of [[503,'temporary_storage_unavailable',false],[503,'identity_unavailable',true],[401,'login_required',true]])test(`HTTP${status}/${code} follows the actual identity boundary`,async()=>{
 try{await login();globalThis.fetch=async()=>new Response(JSON.stringify({error:'synthetic failure',code}),{status});await assert.rejects(requestWordbank('/api/wordbanks'));assert.equal(accountState().authenticated,!clears);}finally{globalThis.fetch=realFetch;}
});
test('bootstrap and account notification share one in-flight directory read',async()=>{
 let resolve,calls=0;const gate=new Promise(r=>resolve=r);const c=createWordbankPageController({getAccount:()=>({authenticated:true,verification:'verified',userKey:'a'.repeat(64)}),getGeneration:()=>1,storage:null,request:async()=>{calls++;await gate;return {packs:[]};}});
 const one=c.refreshDirectory(),two=c.refreshDirectory();assert.equal(calls,1);resolve();await Promise.all([one,two]);await c.refreshDirectory();assert.equal(calls,2);c.destroy();
});
