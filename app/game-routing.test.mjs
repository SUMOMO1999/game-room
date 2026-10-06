import test from 'node:test';
import assert from 'node:assert/strict';
import { gameDetails, gameName, roomHref } from './game-routing.mjs';

test('old rooms keep the Rummikub route and military rooms use their own page', () => {
  assert.equal(roomHref('001234'), './room.html?code=001234');
  assert.equal(roomHref('001234', 'army-flip'), './army.html?code=001234');
  assert.equal(gameName('army-flip'), '翻棋军棋');
  assert.deepEqual(gameDetails('army-flip'), { name: '翻棋军棋', page: 'army.html', minPlayers: 2, maxPlayers: 2 });
  assert.ok(Object.isFrozen(gameDetails()));
});
test('unknown game types and untrusted paths never silently route to another game', () => {
  for (const type of ['mahjong', '', null, {}, '__proto__']) assert.throws(() => roomHref('123456', type));
  for (const code of ['../army.html', '123456&token=secret', '12345', 'ABCDEF', 123456]) assert.throws(() => roomHref(code, 'army-flip'));
});
