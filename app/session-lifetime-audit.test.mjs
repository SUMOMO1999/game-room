import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readSettings } from '../server/config.mjs';
import { IdentityFailure } from '../server/auth.mjs';
import { SessionService } from '../server/session-service.mjs';
import { EncryptedStore,MemoryAdapter,identityKey,opaqueId } from '../server/storage.mjs';

// Only synthetic state and an injected online verifier. These tests exercise the
// production SessionService lifetime rules without contacting Cognito or Agora.
async function fixture() {
  let clock=Date.UTC(2026,9,4);
  const settings=readSettings({GAME_ROOM_AUTH_MODE:'cognito',GAME_ROOM_CLIENT_ID:'fixtureclient12345'});
  const store=new EncryptedStore(new MemoryAdapter({now:()=>clock}),randomBytes(32),()=>clock);
  const provider={checks:0,status:200,async check(identity){++this.checks;if(this.status!==200)throw new IdentityFailure(this.status);return {...identity};}};
  const service=new SessionService(settings,{store,provider,now:()=>clock}),id=opaqueId(),userKey=identityKey(settings.issuer,'fictional-player');
  const session={phase:'active',issuer:settings.issuer,sub:'fictional-player',userKey,accessToken:'fictional-server-only-token',
    authTime:Math.floor(clock/1000),clientId:settings.clientId,csrf:opaqueId(),createdAt:clock,
    expiresAt:clock+3600000,idleUntil:clock+1800000,lastIdentityCheck:clock};
  await store.put('sessions',id,session,session.idleUntil);
  const game={seatId:'fictional-stable-seat',userKey,matchId:'fictional-match',rack:['fictional-private-card']};
  await store.put('rooms','fictional-room',game);
  const request=new Request(`${settings.origin}/api/state`,{headers:{cookie:`${settings.cookieName}=${id}`}});
  return {service,provider,store,settings,request,id,session,game,now:()=>clock,advance(ms){clock+=ms;}};
}
const status=expected=>error=>error instanceof IdentityFailure && error.status===expected;

test('continuous active checks preserve the same seat but cannot renew the existing 60 minute token lifetime',async()=>{
  const f=await fixture(),initial=await f.service.authorize(f.request);
  assert.equal(f.settings.absoluteMs,3600000);assert.equal(f.settings.idleMs,1800000);
  for(let index=0;index<239;index++) {
    f.advance(15000);const session=await f.service.authorize(f.request);
    assert.equal(session.id,initial.id);assert.equal(session.csrf,initial.csrf);assert.equal(session.expiresAt,initial.expiresAt);
  }
  f.advance(14999);assert.equal((await f.service.authorize(f.request)).expiresAt,f.session.expiresAt);
  f.advance(1);await assert.rejects(f.service.authorize(f.request),status(401));
  assert.equal(await f.store.get('sessions',f.id),null);
  assert.deepEqual(await f.store.get('rooms','fictional-room'),f.game);
});

test('read-only SSE watchdog checks do not count as activity or prevent 30 minute idle expiry',async()=>{
  const f=await fixture(),idleUntil=f.session.idleUntil;
  for(let index=0;index<119;index++) {
    f.advance(15000);const session=await f.service.authorize(f.request,{touch:false});assert.equal(session.idleUntil,idleUntil);
  }
  f.advance(15000);await assert.rejects(f.service.authorize(f.request,{touch:false}),status(401));
  assert.deepEqual(await f.store.get('rooms','fictional-room'),f.game);
});

test('temporary identity 503 preserves the exact server session and a later valid check restores it without registration',async()=>{
  const f=await fixture(),before=await f.store.get('sessions',f.id),events=[];
  f.service.subscribeInvalidation(event=>events.push(event));f.provider.status=503;f.advance(60000);
  await assert.rejects(f.service.authorize(f.request),status(503));
  assert.deepEqual(await f.store.get('sessions',f.id),before);
  assert.equal(events.at(-1).status,503);assert.equal(events.at(-1).sessionId,f.id);
  f.provider.status=200;const restored=await f.service.authorize(f.request);
  assert.equal(restored.id,f.id);assert.equal(restored.userKey,f.session.userKey);assert.equal(restored.csrf,f.session.csrf);
  assert.equal(restored.expiresAt,f.session.expiresAt);assert.ok(restored.idleUntil>before.idleUntil);
  assert.deepEqual(await f.store.get('rooms','fictional-room'),f.game);
});

test('a temporary fault does not extend expiry and a genuine 401 removes only this project session',async()=>{
  const f=await fixture();f.provider.status=503;f.advance(1799999);
  await assert.rejects(f.service.authorize(f.request),status(503));assert.ok(await f.store.get('sessions',f.id));
  f.advance(1);await assert.rejects(f.service.authorize(f.request),status(401));
  assert.deepEqual(await f.store.get('rooms','fictional-room'),f.game);
  const denied=await fixture();denied.provider.status=401;
  await assert.rejects(denied.service.authorize(denied.request),status(401));assert.equal(await denied.store.get('sessions',denied.id),null);
  assert.deepEqual(await denied.store.get('rooms','fictional-room'),denied.game);
});
