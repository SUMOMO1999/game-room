// All player decisions and timers for one room pass through this queue. The
// encrypted input history, stable shuffle seed and saved deadlines survive the
// loss of the renderer or the entire relay. Recovery verifies native checkpoints
// before applying choices or allowing players to see the recovered table.
const ruleVersion = 'noname-v1.11.6.1-playwright-1.62.1-retained-1';
const transient = new Set(['chat', 'emotion', 'throwEmotion', 'cardPile']);
const decision = new Set(['result', 'tempResult']);
export { ruleVersion };

export function tableRunner({record, retention, openEngine, output, restoreWires, now = Date.now}) {
  const {key, id, setup} = record;
  if (setup?.ruleVersion !== ruleVersion) throw Error('Unsupported retained game rules');
  const deadlines = new Map();
  let engine, recovering = false, stopped = false, completed = false, generation = 0, retryTimer, resultTimer;
  let tail = Promise.resolve(), delivery = Promise.resolve(), lastSave = record.createdAt;

  function serialize(action) {
    const job = tail.then(action);
    tail = job.catch(() => {});
    return job;
  }
  async function commit(event) {
    lastSave = now();
    await retention.append(key, id, {...event, at:lastSave});
  }
  function removeClock(seat) {
    clearTimeout(deadlines.get(seat)?.timer);
    deadlines.delete(seat);
  }
  function alarm(seat, clock) {
    if (stopped || recovering || deadlines.get(seat) !== clock) return;
    clock.timer = setTimeout(() => {
      serialize(async () => {
        if (stopped || deadlines.get(seat) !== clock || !engine) return;
        const checkpoint = await engine.state(seat);
        if (checkpoint.number !== clock.number) return;
        await commit({op:'timeout', seat, checkpoint});
        await engine.expire(seat, clock.number);
      }).catch(failed);
    }, Math.max(0, clock.due - now()));
    clock.timer.unref?.();
  }

  async function publish(message, epoch) {
    if (epoch !== generation || stopped) return;
    if (message[0] === 'server' && message[1] === 'finishMatch') {
      completed = true;
      for (const seat of deadlines.keys()) removeClock(seat);
    }
    if (completed) {
      // Native clients receive their original win/loss screens before the
      // idle renderer is released. The durable room and its seats outlive it.
      clearTimeout(resultTimer);
      resultTimer = setTimeout(() => { void serialize(stop).catch(() => {}); }, 15000);
      resultTimer.unref?.();
    }
    if (message[0] !== 'clock') {
      // While rebuilding, the lobby still needs the native room configuration.
      // Player frames describe history until all checkpoints have been verified.
      if (!recovering || message[0] === 'server' && ['config','changeAvatar','finishMatch'].includes(message[1])) {
        await output(message, recovering);
      }
      return;
    }
    if (completed) return;
    const [, action, seat, number, duration, checkpoint] = message;
    if (action === 'answered') {
      if (deadlines.get(seat)?.number === number) removeClock(seat);
      return;
    }
    if (action !== 'start' || !Number.isSafeInteger(number) || !Number.isFinite(duration) || duration <= 0) {
      throw Error('Invalid game decision deadline');
    }
    removeClock(seat);
    const clock = {number, checkpoint, due:(recovering ? lastSave : now()) + duration, saved:false};
    deadlines.set(seat, clock);
    if (!recovering) {
      await commit({op:'clock', seat, checkpoint, due:clock.due});
      clock.saved = true;
      alarm(seat, clock);
    }
  }
  function failed(error) {
    if (stopped || completed || retryTimer) return;
    generation++;
    for (const clock of deadlines.values()) clearTimeout(clock.timer);
    const stale = engine;
    engine = null;
    stale?.close().catch(() => {});
    if (process.env.NONAME_LOCAL_DIAGNOSTICS === '1') console.error('Room retained for recovery:', error?.message);
    else process.emitWarning('A retained table will retry native recovery');
    retryTimer = setTimeout(() => {
      retryTimer = null;
      serialize(start).catch(failed);
    }, 4000);
    retryTimer.unref?.();
  }
  async function apply(event) {
    const {seat, checkpoint} = event;
    switch (event.op) {
      case 'clock': {
        await engine.match(seat, checkpoint, true);
        await delivery;
        const clock = deadlines.get(seat);
        if (!clock || clock.number !== checkpoint.number) throw Error('Restored clock does not match saved decision');
        clock.due = event.due;
        clock.saved = true;
        break;
      }
      case 'join': await engine.join(seat); break;
      case 'resume': await engine.resume(seat); break;
      case 'depart': await engine.depart(seat,event.owner); break;
      case 'input':
        if (checkpoint) await engine.match(seat, checkpoint);
        await engine.receive(seat,event.frame);
        break;
      case 'timeout':
        await engine.match(seat,checkpoint);
        if (!await engine.expire(seat,checkpoint.number)) throw Error('Recorded timeout was not outstanding');
        break;
      default: throw Error('Unknown game history event');
    }
  }
  async function start() {
    if (stopped || engine) return;
    const current = await retention.room(key);
    if (!current || current.id !== id) throw Error('Room no longer active');
    if (current.phase === 'finished') { completed = true; return; }
    const epoch = ++generation;
    const from = current.roundStart ?? 0;
    recovering = current.count > from || Boolean(setup.roster?.length);
    for (const seat of deadlines.keys()) removeClock(seat);
    lastSave = current.roundStartedAt ?? current.createdAt;
    delivery = Promise.resolve();
    const {roster, ...engineSetup} = setup;
    const instance = await openEngine({id,key,...engineSetup, send(message) {
      const next = delivery.then(() => publish(message, epoch));
      delivery = next.catch(failed);
      return next;
    }, onLost() { if (epoch === generation && !stopped) failed(Error('Native game process closed')); }});
    if (epoch !== generation || stopped) { await instance.close(); throw Error('Room service changed'); }
    engine = instance;
    if (recovering) {
      // Restore the same people to the new native preparation room, including
      // offline seats. Only the new match's inputs, choices and clocks replay.
      for (const {seat,frame} of roster ?? []) {
        await engine.join(seat);
        await engine.receive(seat, structuredClone(frame));
        await engine.receive(seat, ['inited']);
      }
      for await (const event of retention.events(current, from)) {
        lastSave = event.at;
        try { await apply(event); }
        catch (error) { throw Error('Cannot restore '+event.op+' '+(event.frame?.[0] ?? event.checkpoint?.number ?? '')+': '+error.message); }
      }
      await delivery;
      if (engine !== instance) throw Error('Referee changed during recovery');
      recovering = false;
      if (completed) return;
      for (const [seat,clock] of deadlines) {
        if (!clock.saved) await commit({op:'clock',seat,checkpoint:clock.checkpoint,due:clock.due});
        alarm(seat,clock);
      }
      await restoreWires(instance);
    }
  }
  async function execute(event) {
    await start();
    if (!engine) throw Error('Room referee is recovering');
    if (event.op === 'input') {
      if (transient.has(event.frame[0])) return engine.receive(event.seat,event.frame);
      if (decision.has(event.frame[0])) {
        event.checkpoint = await engine.state(event.seat);
        // A late choice for a completed turn must not replay into another turn.
        if (event.checkpoint.number === null || event.frame.at(-1) !== event.checkpoint.number) return;
        event.frame = event.frame.slice(0,-1);
      }
    }
    await delivery;
    await commit(event);
    await apply(event);
  }

  async function stop() {
    stopped = true;
    generation++;
    clearTimeout(retryTimer);
    clearTimeout(resultTimer);
    for (const seat of deadlines.keys()) removeClock(seat);
    const instance = engine;
    engine = null;
    await instance?.close();
    await delivery;
  }

  return {
    run(action) { return serialize(action); },
    boot() { return serialize(start).catch(error => { failed(error); throw error; }); },
    execute(event) { return execute(event).catch(error => { failed(error); throw error; }); },
    async departed(event) {
      // Participant removal and this event were committed in the same transaction.
      if (engine) try { await engine.depart(event.seat,event.owner); } catch (error) { failed(error); }
    },
    stop,
  };
}

