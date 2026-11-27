import { randomBytes } from 'node:crypto';

const rooms = 'noname-open-room';
const seats = 'noname-player-seat';
const history = 'noname-room-history';
export const NONAME_RECOVERY_SCOPES = Object.freeze([rooms,seats,history]);
const chunkLength = 32;
const validKey = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);
const validId = value => typeof value === 'string' && /^[a-f\d]{32}$/.test(value);
const phases = ['waiting', 'playing', 'finished'];
const fresh = () => randomBytes(16).toString('hex');
export const roomIdleMs = 30 * 60_000;

function checkRoom(room) {
  if (room?.schema !== 2 || !validKey(room.key) || !validId(room.id) || !phases.includes(room.phase) ||
      !Number.isSafeInteger(room.count) || room.count < 0 ||
      !Array.isArray(room.players) || !room.players.length || !room.players.includes(room.owner) ||
      !room.players.every(validKey) || new Set(room.players).size !== room.players.length) {
    throw new Error('Unreadable retained room. Keep its records and stop the switch.');
  }
  if (room.formerSeats !== undefined && (!room.formerSeats || Array.isArray(room.formerSeats) ||
      typeof room.formerSeats !== 'object' || Object.entries(room.formerSeats).some(([player,seat]) =>
        !validKey(player) || !validKey(seat) || room.players.includes(player)) ||
      new Set(Object.values(room.formerSeats)).size !== Object.keys(room.formerSeats).length)) {
    throw new Error('Invalid former player seat');
  }
  if (room.roundStart !== undefined && (!Number.isSafeInteger(room.roundStart) || room.roundStart < 0 ||
      room.roundStart > room.count || !Number.isSafeInteger(room.roundStartedAt))) {
    throw new Error('Invalid match history boundary');
  }
  if (room.offlineSince != null && (!Number.isSafeInteger(room.offlineSince) || room.offlineSince < 0)) {
    throw new Error('Invalid retained room offline time');
  }
  return room;
}

function change(scope, id, entry, value) {
  return { scope, id, expectedVersion: entry?.version ?? null, value };
}

export function validateRoomBackup(records, recordKey) {
  const indexed = new Map(records.map(row => [row.key,row.value]));
  const linkedSeats = new Set();
  for (const {key,value,scope} of records) {
    if (scope !== rooms) continue;
    const room = checkRoom(value);
    if (recordKey(rooms,room.key) !== key) throw Error('Invalid saved table identity');
    for (const player of room.players) {
      const address = recordKey(seats,player), seat = indexed.get(address);
      if (linkedSeats.has(address) || seat?.roomId !== room.id || seat.key !== room.key || !validKey(seat.binding) ||
          (room.setup && !validKey(seat.nativeSeat))) {
        throw Error('Incomplete retained seat');
      }
      linkedSeats.add(address);
    }
    const total = Math.ceil(room.count / chunkLength);
    if (total > records.length) throw Error('Incomplete retained game history');
    for (let index=0; index<total; index++) {
      const chunk = indexed.get(recordKey(history,room.id+'/'+index));
      if (chunk?.roomId !== room.id || chunk.index !== index ||
          chunk.events?.length !== Math.min(chunkLength,room.count-index*chunkLength)) {
        throw Error('Incomplete retained game history');
      }
    }
  }
  for (const row of records) {
    if (row.scope === seats && !linkedSeats.has(row.key)) throw Error('Unowned retained seat');
    if (row.scope === history && (!validId(row.value.roomId) || !Number.isSafeInteger(row.value.index) ||
        recordKey(history,row.value.roomId+'/'+row.value.index) !== row.key || !Array.isArray(row.value.events))) {
      throw Error('Invalid native game history');
    }
  }
}

// The active connection binding changes on device takeover. An old tab
// cannot give up the seat or close a room from an earlier round.
export function retainedRooms(store, {now = Date.now} = {}) {
  if (!store?.compareAndSwapMany || !store.scan) throw new Error('Game storage is required for retained rooms');

  async function forPlayer(player) {
    for (;;) {
      const entry = await store.read(seats, player);
      if (!entry) return null;
      const seat = entry.value;
      const room = await store.get(rooms, seat.key);
      if (room && checkRoom(room).id === seat.roomId && room.players.includes(player)) {
        return {key:room.key, id:room.id, phase:room.phase, owner:room.owner === player, nativeSeat:seat.nativeSeat};
      }
      if ((await store.read(seats, player))?.version === entry.version) throw new Error('Seat and retained room disagree');
    }
  }

  async function begin(key, player, binding, nativeSeat = null, setup = null) {
    if (![key, player, binding].every(validKey)) throw new Error('Invalid room or player');
    const id = fresh();
    const room = {schema:2, id, key, owner:player, players:[player], phase:'waiting', createdAt:now(),
      count:0, setup:setup ? {...setup, seed:randomBytes(32).toString('hex')} : null};
    const seat = {roomId:id, key, nativeSeat, binding};
    const accepted = await store.compareAndSwapMany({changes:[change(rooms, key, null, room), change(seats, player, null, seat)]});
    return accepted ? id : null;
  }

  async function takeSeat(key, id, player, nativeSeat, binding) {
    if (![key, player, binding].every(validKey) || !validId(id) || !validKey(nativeSeat)) return false;
    for (;;) {
      const [entry, previous] = await Promise.all([store.read(rooms, key), store.read(seats, player)]);
      if (!entry || checkRoom(entry.value).id !== id) return false;
      const room = entry.value;
      if (previous && (previous.value.roomId !== id || previous.value.nativeSeat !== nativeSeat)) return false;
      const former = Object.hasOwn(room.formerSeats ?? {}, player) ? room.formerSeats[player] : null;
      if (!previous && room.phase !== 'waiting' && !(room.phase === 'playing' && former === nativeSeat)) return false;
      const record = {roomId:id, key, nativeSeat, binding};
      const changes = [change(seats, player, previous, record)];
      const guards = [];
      if (!room.players.includes(player)) {
        const joined = {...room, players:[...room.players, player]};
        if (former) {
          joined.formerSeats = {...room.formerSeats};
          delete joined.formerSeats[player];
        }
        changes.push(change(rooms, key, entry, joined));
      }
      else guards.push({scope:rooms, id:key, expectedVersion:entry.version});
      if (await store.compareAndSwapMany({changes, guards})) return true;
    }
  }

  async function removeHistory(room) {
    for (let index = 0; index < Math.ceil(room.count / chunkLength); index++) {
      await store.remove(history, room.id + '/' + index);
    }
  }

  async function leave(key, id, player, binding, event = null, finishedOnly = false) {
    for (;;) {
      const [entry, previous] = await Promise.all([store.read(rooms, key), store.read(seats, player)]);
      if (!entry || checkRoom(entry.value).id !== id || !previous || previous.value.roomId !== id ||
          !entry.value.players.includes(player) ||
          (finishedOnly ? entry.value.phase !== 'finished' : previous.value.binding !== binding)) return null;
      const room = entry.value;
      const players = room.players.filter(p => p !== player);
      const owner = room.owner === player ? players[0] : room.owner;
      const remaining = players.length ? {...room, owner, players} : null;
      if (remaining && room.phase === 'playing' && room.setup && previous.value.nativeSeat) {
        remaining.formerSeats = {...room.formerSeats, [player]:previous.value.nativeSeat};
      }
      const changes = [change(seats, player, previous, null), change(rooms, key, entry, remaining)];
      if (remaining && event) {
        const next = await historyChange(room, event);
        if (!next) continue;
        changes.push(next);
        remaining.count++;
      }
      if (await store.compareAndSwapMany({changes})) {
        if (!remaining) await removeHistory(room);
        return {closed:!remaining, owner:owner ?? null};
      }
    }
  }

  async function phase(key, id, next, lobbyConfig) {
    if (!phases.includes(next)) throw new TypeError('Invalid room phase');
    for (;;) {
      const entry = await store.read(rooms, key);
      if (!entry || checkRoom(entry.value).id !== id) return false;
      const current = entry.value.phase;
      if (current === next) return true;
      if (phases.indexOf(next) !== phases.indexOf(current) + 1) return false;
      const updated = {...entry.value, phase:next, offlineSince:null};
      if (next === 'finished' && lobbyConfig) updated.lobbyConfig = lobbyConfig;
      if (await store.replaceCAS(rooms, key, entry.version, updated)) return true;
    }
  }

  async function nextMatch(room, owner, binding, roundStart, roster) {
    const entry = await store.read(rooms, room.key);
    const seat = await store.read(seats, owner);
    if (!entry || entry.value.id !== room.id || entry.value.phase !== 'finished' ||
        entry.value.owner !== owner || entry.value.count !== room.count ||
        (entry.value.roundStart ?? 0) !== roundStart || seat?.value.roomId !== room.id ||
        seat.value.binding !== binding || room.count <= roundStart) return null;
    const config = {...(room.lobbyConfig ?? room.setup.config)};
    delete config.gameStarted;
    delete config.observeReady;
    delete config.sumomoFinished;
    const next = {...entry.value, phase:'waiting', formerSeats:{}, offlineSince:null, roundStart:room.count, lobbyConfig:config,
      roundStartedAt:now(), setup:{...entry.value.setup, roster, seed:randomBytes(32).toString('hex'),
        config, nickname:roster[0].frame[2].nickname, avatar:roster[0].frame[2].avatar}};
    const saved = await store.compareAndSwapMany({changes:[change(rooms,room.key,entry,next)],
      guards:[{scope:seats,id:owner,expectedVersion:seat.version}]});
    return saved ? next : null;
  }

  async function endRoom(entry, reason) {
    const room = entry.value;
    const occupants = await Promise.all(room.players.map(async player => [player, await store.read(seats, player)]));
    if (occupants.some(([, seat]) => seat?.value.roomId !== room.id)) return false;
    if (reason.binding && occupants.find(([player]) => player === room.owner)?.[1].value.binding !== reason.binding) return false;
    const changes = [change(rooms, room.key, entry, null), ...occupants.map(([player, seat]) => change(seats, player, seat, null))];
    if (reason.mayExpire && !reason.mayExpire()) return false;
    if (!await store.compareAndSwapMany({changes})) return false;
    await removeHistory(room).catch(() => process.emitWarning('Could not discard closed Noname room history'));
    return true;
  }

  async function closeByOwner(key, id, player, binding, roundStart) {
    const entry = await store.read(rooms, key);
    if (!entry || checkRoom(entry.value).id !== id || entry.value.phase === 'playing' ||
        entry.value.owner !== player || (entry.value.roundStart ?? 0) !== roundStart || !validKey(binding)) return false;
    return endRoom(entry, {binding});
  }

  // A legacy table has no measured offline time. Its grace period starts
  // when the live lobby first observes it empty, never at its creation time.
  async function observePresence(key, id, occupied, mayExpire) {
    for (;;) {
      const entry = await store.read(rooms, key);
      if (!entry || checkRoom(entry.value).id !== id || entry.value.phase === 'playing') return false;
      const {offlineSince} = entry.value;
      if (!occupied && offlineSince != null) {
        if (now() - offlineSince >= roomIdleMs && mayExpire()) return endRoom(entry, {mayExpire});
        return false;
      }
      if (occupied && offlineSince == null) return false;
      const updated = {...entry.value, offlineSince:occupied ? null : now()};
      if (await store.replaceCAS(rooms, key, entry.version, updated)) return false;
    }
  }

  async function unfinished() {
    const entries = await store.scan(rooms);
    for (const {value} of entries) checkRoom(value);
    return entries.length;
  }
  // Commit the next input and its position together before the referee applies
  // it. On recovery every chunk must be present and belong to this room instance.
  async function historyChange(room, event) {
    const chunkId = room.id + '/' + Math.floor(room.count / chunkLength);
    const previous = await store.read(history, chunkId);
    if ((previous?.value.events.length ?? 0) !== room.count % chunkLength) {
      const latest = await store.get(rooms, room.key);
      if (latest?.id !== room.id || latest.count !== room.count) return null;
      throw new Error('Incomplete game history');
    }
    return change(history, chunkId, previous, {roomId:room.id,index:Math.floor(room.count / chunkLength),
      events:[...(previous?.value.events ?? []), event]});
  }
  async function append(key, id, event) {
    for (;;) {
      const entry = await store.read(rooms, key);
      if (!entry || checkRoom(entry.value).id !== id) throw new Error('This room has closed');
      const room = entry.value;
      const next = await historyChange(room, event);
      if (!next) continue;
      if (await store.compareAndSwapMany({changes:[change(rooms,key,entry,{...room,count:room.count+1}),
        next]})) return room.count + 1;
    }
  }
  async function* events(room, from = 0) {
    for (let index = Math.floor(from / chunkLength); index * chunkLength < room.count; index++) {
      const chunk = await store.get(history, room.id + '/' + index);
      const length = Math.min(chunkLength, room.count - index * chunkLength);
      if (!chunk || chunk.roomId !== room.id || chunk.index !== index || !Array.isArray(chunk.events) ||
          chunk.events.length < length) throw new Error('Cannot restore incomplete history');
      yield* chunk.events.slice(Math.max(0, from - index * chunkLength), length);
    }
  }
  async function list() {
    return (await store.scan(rooms)).map(row => checkRoom(row.value));
  }
  return {begin, forPlayer, takeSeat, leave, phase, nextMatch, closeByOwner, observePresence, unfinished, list, append, events,
    async room(key) { const row = await store.get(rooms,key); return row && checkRoom(row); }};
}
