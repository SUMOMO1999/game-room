// The lobby connection represents a person. The original game runs in a
// separate referee with a lifetime owned by this table's seated accounts.
import { acceptsFrame, gameData } from './game-input.mjs';
import { ruleVersion, tableRunner } from './table-runner.mjs';

export function bindManagedTables({rooms, util, bridge, retention, openEngine}) {
  const connections = new Map();
  const bySeat = new Map();
  const active = new Map();
  const tell = (socket, ...args) => util.sendl(socket, ...args);
  let idleTimer, sweeping = false;

  function releaseWire(socket) {
    const entry = connections.get(socket);
    if (!entry) return;
    if (entry.table.wires.get(entry.seat) === socket) entry.table.wires.delete(entry.seat);
    connections.delete(socket);
    return entry;
  }

  function attach(socket, table, seat, player, binding, returning = false) {
    const old = table.wires.get(seat);
    if (old && old !== socket) {
      releaseWire(old);
      bridge.detach(old);
      if (old.supersede) old.supersede();
      else old.close();
    }
    socket.room = table.room;
    socket.owner = table.room.owner;
    table.wires.set(seat, socket);
    connections.set(socket, {table, seat, player, binding, returning});
    tell(socket, 'sumomoSeat', seat, table.room.key, table.roundStart);
  }

  function finishedView(table, socket) {
    const player = connections.get(socket)?.player;
    tell(socket, 'sumomoFinished', table.people.has(player) && table.owner === player, table.roundStart,
      table.people.has(player));
  }

  function runAtTable(table, action) {
    const runner = table.runner;
    return runner.run(() => runner === table.runner ? action() : runAtTable(table,action));
  }

  function hasPlayer(table) {
    return [...table.wires.values()].some(socket => {
      const member = connections.get(socket);
      // A logical seat may remain connected for ten minutes after its real
      // network link is gone. The idle clock follows that link, not the seat.
      return member && table.people.has(member.player) && bridge.identity(socket) &&
        (socket.transportOnline?.() ?? socket.readyState === 1);
    });
  }

  async function observePresence(table) {
    if (!bridge.canCreate() || !active.has(table.id) ||
        (!table.finished && table.room.config?.gameStarted)) return;
    const closed = await retention.observePresence(table.room.key, table.id, hasPlayer(table),
      () => bridge.canCreate() && !hasPlayer(table));
    if (closed) await removeTable(table);
  }

  async function sweepIdle() {
    if (sweeping || !bridge.canCreate()) return;
    sweeping = true;
    try {
      await Promise.all([...active.values()].map(table => runAtTable(table,() => observePresence(table))));
    } finally { sweeping = false; }
  }

  function recordPresence(entry) {
    if (entry) void runAtTable(entry.table,() => observePresence(entry.table))
      .catch(() => process.emitWarning('Could not record Noname player presence'));
  }

  async function removeTable(table) {
    active.delete(table.id);
    bySeat.delete(table.room);
    rooms.delete(table.room.key);
    for (const peer of [...table.wires.values()]) {
      tell(peer, 'sumomoRoomClosed');
      releaseWire(peer);
    }
    bridge.notifySavedTable(table.people.keys(), null);
    bridge.closeManaged(table.room);
    util.updateRooms();
    await table.runner.stop();
  }

  function lobbyConfig(record) {
    // The native create form supplies the mode separately. Older retained
    // rooms have this raw form, not the fully populated native lobby listing.
    const config = record.lobbyConfig ?? record.setup.config;
    return {...config, mode:record.setup.mode, number:config.number ?? config.player_number ?? record.players.length,
      cardPack:Array.isArray(config.cardPack) ? config.cardPack : [],
      ...(record.phase === 'finished' && {gameStarted:true,sumomoFinished:true})};
  }

  async function emit(table, message, replay) {
    if (!active.has(table.id)) return;
    const [prefix, verb, arg, payload] = message;
    if (prefix !== 'server') return;
    if (verb === 'config') {
      if (table.finished) return;
      if (!replay && arg.gameStarted === true) await retention.phase(table.room.key, table.id, 'playing');
      table.room.config = arg;
      util.updateRooms();
      return;
    }
    if (verb === 'changeAvatar') {
      table.room.owner.nickname = util.nickname(arg);
      table.room.owner.avatar = payload;
      util.updateRooms();
      return;
    }
    if (verb === 'finishMatch') {
      if (await retention.phase(table.room.key, table.id, 'finished', table.room.config)) {
        table.finished = true;
        table.room.config = {...table.room.config, gameStarted:true, sumomoFinished:true};
        bridge.notifySavedTable(table.people.keys(), {id:table.id, phase:'finished'});
        util.updateRooms();
        for (const peer of table.wires.values()) finishedView(table, peer);
        await observePresence(table);
      }
      return;
    }
    const socket = table.wires.get(arg);
    if (!socket) return;
    if (verb === 'close') { releaseWire(socket); socket.close(); return; }
    if (verb !== 'send' || typeof payload !== 'string') return;
    const frame = JSON.parse(payload);
    const entry = connections.get(socket);
    if (frame[0] === 'reinit' && frame[5] != null && (entry.returning || table.people.has(entry.player))) {
      // A seated account must never be downgraded to an observer. Keep its
      // reserved seat so re-entry with a verified native state can retry.
      releaseWire(socket);
      socket.close();
      return;
    }
    if (frame[0] === 'init' || (frame[0] === 'reinit' && frame[5] === null)) {
      if (!await retention.takeSeat(table.room.key, table.id, entry.player, arg, entry.binding)) {
        tell(socket,'denied','banned');
        releaseWire(socket);
        socket.close();
        return;
      }
      if (table.wires.get(arg) !== socket) return;
      table.people.set(entry.player, arg);
      table.room.seated = table.people.size;
      bridge.seatManaged(socket, table.room, table.id, arg);
      await observePresence(table);
    }
    socket.send(payload);
  }

  function makeRunner(table, record) {
    return tableRunner({record,retention,openEngine,
      output:(message,replay) => emit(table,message,replay), async restoreWires(engine) {
        for (const [seat,socket] of table.wires) {
          if (bridge.identity(socket)) await engine.resume(seat);
        }
      }});
  }

  async function mount(record) {
    if (active.has(record.id)) return active.get(record.id);
    const {id,key,setup} = record;
    const finished = record.phase === 'finished';
    const room = {key, owner:{nickname:setup.nickname, avatar:setup.avatar},
      config:lobbyConfig(record),
      managed:true, seated:record.players.length};
    const people = new Map();
    for (const player of record.players) people.set(player,(await retention.forPlayer(player)).nativeSeat);
    const table = {id, room, wires:new Map(), people, finished, owner:record.owner, roundStart:record.roundStart ?? 0};
    table.runner = makeRunner(table, record);
    active.set(id,table);
    bySeat.set(room,table);
    rooms.set(key,room);
    return table;
  }
  async function restore() {
    for (const record of await retention.list()) {
      // A pre-referee room has no native history. Preserve the record for
      // maintenance instead of presenting an unrelated new deal to its players.
      if (!record.setup) continue;
      const table = await mount(record);
      if (!table.finished) table.runner.boot().catch(() => {});
    }
    idleTimer = setInterval(() => {
      void sweepIdle().catch(() => process.emitWarning('Could not check idle Noname tables'));
    }, 15000);
    idleTimer.unref();
  }
  const opening = new Set();
  async function create(socket, browserKey, nickname, avatar, config, mode) {
    const identity = bridge.identity(socket);
    if (!identity || !config || !gameData(config) || !bridge.canCreate() ||
        !['identity','guozhan','versus','doudizhu','single'].includes(mode)) return tell(socket, 'enterroomfailed');
    // A former host can open a new table while friends keep the old one and its invitation.
    let key = browserKey;
    while (rooms.has(key) || opening.has(key)) key = util.newId();
    opening.add(key);
    try {
      const previous = await retention.forPlayer(identity.player);
      if (previous && (previous.phase !== 'finished' || !await leaveFinished(socket, previous.id))) {
        return tell(socket, 'enterroomfailed');
      }
      if (!bridge.identity(socket) || !bridge.canCreate()) return tell(socket, 'enterroomfailed');
      const seat = socket.wsid;
      const setup = {ruleVersion,mode,config,nickname:util.nickname(nickname),avatar};
      const id = await retention.begin(key, identity.player, identity.binding, seat, setup);
      if (!id) return tell(socket,'enterroomfailed');
      const table = await mount(await retention.room(key));
      if (bridge.identity(socket)) attach(socket,table,seat,identity.player,identity.binding);
      await observePresence(table);
      await table.runner.run(() => table.runner.execute({op:'join',seat}));
    } finally { opening.delete(key); }
  }

  async function enter(socket, room, nickname, avatar, intent) {
    const table = bySeat.get(room), identity = bridge.identity(socket);
    if (!table || !identity) return tell(socket, 'enterroomfailed');
    return runAtTable(table,async () => {
      if (!bridge.identity(socket)) return;
      const saved = await retention.forPlayer(identity.player);
      if (saved && saved.id !== table.id) return tell(socket, 'enterroomfailed');
      if (intent === 'resume' && !saved) return tell(socket,'enterroomfailed');
      if (table.finished) {
        if (!saved || !await retention.takeSeat(room.key,table.id,identity.player,saved.nativeSeat,identity.binding)) {
          return tell(socket,'enterroomfailed');
        }
        socket.nickname = util.nickname(nickname);
        socket.avatar = avatar;
        attach(socket,table,saved.nativeSeat,identity.player,identity.binding,true);
        bridge.seatManaged(socket,room,table.id,saved.nativeSeat);
        await observePresence(table);
        finishedView(table,socket);
        return;
      }
      const record = saved ? null : await retention.room(room.key);
      const former = record?.id === table.id && record.phase === 'playing' && Object.hasOwn(record.formerSeats ?? {}, identity.player)
        ? record.formerSeats[identity.player] : null;
      const returningSeat = saved?.nativeSeat ?? former;
      if (!returningSeat && room.config?.gameStarted && (!room.config.observe || !room.config.observeReady)) return tell(socket, 'enterroomfailed');
      if (!returningSeat && !room.config?.gameStarted &&
          room.seated >= Number(room.config?.number)) return tell(socket, 'enterroomfailed');
      socket.nickname = util.nickname(nickname);
      socket.avatar = avatar;
      const seat = returningSeat ?? socket.wsid;
      attach(socket, table, seat, identity.player, identity.binding, Boolean(returningSeat));
      if (saved) await observePresence(table);
      await table.runner.execute({op:returningSeat ? 'resume' : 'join',seat});
      util.updateRooms();
    });
  }

  async function myTable(socket) {
    const identity = bridge.identity(socket);
    if (!identity) return;
    const saved = await retention.forPlayer(identity.player);
    if (bridge.identity(socket)) tell(socket, 'sumomoMyTable', saved ? {id:saved.id, phase:saved.phase} : null);
  }

  async function returnToTable(socket, id, nickname, avatar) {
    const identity = bridge.identity(socket);
    if (!identity || socket.room) return;
    const saved = await retention.forPlayer(identity.player);
    const table = saved?.id === id && active.get(id);
    if (!table) {
      await myTable(socket);
      return tell(socket, 'sumomoNoSavedTable');
    }
    return enter(socket,table.room,nickname,avatar,'resume');
  }

  async function leaveFinished(socket, id) {
    const identity = bridge.identity(socket), table = active.get(id);
    if (!identity || socket.room || !table) return false;
    return runAtTable(table,async () => {
      if (!bridge.identity(socket) || !table.finished) return false;
      const outcome = await retention.leave(table.room.key,id,identity.player,null,null,true);
      if (!outcome) return false;
      const nativeSeat = table.people.get(identity.player);
      const old = table.wires.get(nativeSeat);
      if (old) {
        tell(old,'sumomoRoomClosed');
        bridge.detach(old);
      }
      table.people.delete(identity.player);
      table.room.seated = table.people.size;
      bridge.notifySavedTable([identity.player],null);
      if (outcome.closed) await removeTable(table);
      else {
        table.owner = outcome.owner;
        for (const peer of table.wires.values()) finishedView(table,peer);
        await observePresence(table);
      }
      return true;
    });
  }

  async function endByOwner(socket, key, roundStart) {
    const entry = connections.get(socket);
    if (!entry || !bridge.identity(socket)) return;
    const {table, player, binding, seat} = entry;
    return runAtTable(table,async () => {
      if (!bridge.identity(socket) || table.owner !== player || table.wires.get(seat) !== socket ||
          table.room.key !== key || table.roundStart !== roundStart ||
          !await retention.closeByOwner(key,table.id,player,binding,roundStart)) {
        return tell(socket,'sumomoEndRoomRejected');
      }
      await removeTable(table);
    });
  }

  async function nextMatch(socket, marker) {
    const entry = connections.get(socket);
    if (!entry || !bridge.identity(socket)) return;
    const {table,player,binding,seat} = entry;
    return runAtTable(table,async () => {
      if (!table.finished || table.wires.get(seat) !== socket || player !== table.owner || marker !== table.roundStart) return;
      if (!bridge.canCreate()) return finishedView(table,socket);
      const record = await retention.room(table.room.key);
      if (!record || record.id !== table.id || record.phase !== 'finished') return;
      // Carry forward native lobby profiles for authenticated seats only. Old
      // match choices, hands, timers and spectators never enter the new deal.
      const profiles = new Map((record.setup.roster ?? []).map(({seat,frame}) => [seat,frame]));
      for await (const event of retention.events(record, table.roundStart)) {
        if (event.op === 'input' && event.frame?.[0] === 'init' && acceptsFrame(event.frame)) profiles.set(event.seat,event.frame);
      }
      const order = [record.owner,...record.players.filter(id => id !== record.owner)];
      const roster = order.map(id => {
        const nativeSeat = table.people.get(id), profile = profiles.get(nativeSeat);
        if (!profile) throw Error('Retained seat is missing its lobby profile');
        const {nickname,avatar,versionLocal,onlineKey,extension} = profile[2];
        return {seat:nativeSeat, frame:['init',profile[1],{nickname,avatar,versionLocal,onlineKey,extension}]};
      });
      const fresh = await retention.nextMatch(record,player,binding,marker,roster);
      if (!fresh) { finishedView(table,socket); return; }
      const previous = table.runner;
      await previous.stop().catch(() => {});
      table.finished = false;
      table.roundStart = fresh.roundStart;
      table.room.config = lobbyConfig(fresh);
      table.room.owner.nickname = fresh.setup.nickname;
      table.room.owner.avatar = fresh.setup.avatar;
      bridge.notifySavedTable(table.people.keys(), {id:table.id, phase:'waiting'});
      for (const peer of [...table.wires.values()]) {
        const member = table.people.has(connections.get(peer)?.player);
        releaseWire(peer);
        tell(peer, 'sumomoNextMatch', member);
      }
      table.runner = makeRunner(table,fresh);
      await observePresence(table);
      // Queue initial preparation before returning players are admitted.
      table.runner.boot().catch(() => {});
      util.updateRooms();
    });
  }

  async function receive(socket, raw) {
    const entry = connections.get(socket);
    if (!entry || !bridge.identity(socket)) return;
    const {table, seat} = entry;
    const frame = JSON.parse(raw);
    if (Array.isArray(frame) && frame[0] === 'server') {
      if (frame[1] === 'nextMatch' && frame.length === 3 && Number.isSafeInteger(frame[2])) return nextMatch(socket,frame[2]);
      if (frame[1] === 'endRoom' && frame.length === 4 && typeof frame[2] === 'string' &&
          Number.isSafeInteger(frame[3])) return endByOwner(socket,frame[2],frame[3]);
    }
    if (!acceptsFrame(frame)) return;
    return runAtTable(table,async () => {
      if (table.finished || connections.get(socket) !== entry || table.wires.get(seat) !== socket || !bridge.identity(socket)) return;
      await table.runner.execute({op:'input',seat,frame});
    });
  }

  async function leave(socket) {
    const entry = connections.get(socket);
    if (!entry) return true;
    const {table, seat, player, binding} = entry;
    return runAtTable(table,async () => {
      if (table.wires.get(seat) !== socket) return false;
      const record = await retention.room(table.room.key);
      if (!record || record.id !== table.id) return false;
      const nextOwner = record.owner === player ? record.players.find(person => person !== player) : record.owner;
      const event = {op:'depart',seat,owner:table.people.get(nextOwner) ?? null,at:Date.now()};
      const result = await retention.leave(table.room.key, table.id, player, binding, event);
      if (!result && table.people.has(player)) return false;
      releaseWire(socket);
      table.people.delete(player);
      table.room.seated = table.people.size;
      if (result?.closed) {
        await removeTable(table);
      } else {
        if (result) table.owner = result.owner;
        if (table.finished) {
          for (const peer of table.wires.values()) finishedView(table,peer);
        } else if (result) await table.runner.departed(event);
        else await table.runner.execute(event);
        await observePresence(table);
      }
      if (result) bridge.notifySavedTable([player],null);
      util.updateRooms();
      return true;
    });
  }
  return {create, enter, receive, leave, restore, myTable, returnToTable, leaveFinished,
    disconnected(socket) { recordPresence(releaseWire(socket)); },
    transportChanged(socket) { recordPresence(connections.get(socket)); },
    pending:() => opening.size,
    async close() {
      clearInterval(idleTimer);
      await Promise.all([...active.values()].map(table => table.runner.stop()));
    },
  };
}
