const integer = value => Number.isSafeInteger(value) && value >= 0;
const clone = value => structuredClone(value);
const turnNumber = value => /^turn-[1-9]\d*$/.test(value ?? '') ? Number(value.slice(5)) : null;

/** Transport pages are not turn pages. The caller supplies a captured public
 * game/participant context and merges every transport page before claiming
 * complete coverage. This model never changes the game or invents an actor. */
export function buildBattleReport(groups, { game = {}, players = [], coverage = null } = {}) {
  const people = players.map((player, index) => ({ id: player.id, name: player.name || `玩家${index + 1}`, turns: [] }));
  const ids = people.map(player => player.id), issues = [], turns = [], unassigned = [], byId = new Map(), unique = new Map();
  const issue = reason => { if (!issues.includes(reason)) issues.push(reason); };
  for (const group of groups ?? []) {
    if (!integer(group?.sequence) || group.sequence < 1 || ![1, 2, 3].includes(group.schemaVersion)
      || !Array.isArray(group.events)) { issue('invalid-group'); continue; }
    const previous = unique.get(group.sequence);
    if (previous && JSON.stringify(previous) !== JSON.stringify(group)) issue('conflicting-sequence');
    else unique.set(group.sequence, clone(group));
  }
  const ordered = [...unique.values()].sort((a, b) => a.sequence - b.sequence);
  const headSequence = integer(game.publicEventSequence) ? game.publicEventSequence : ordered.at(-1)?.sequence ?? 0;
  const currentTurnId = game.turnId ?? null, currentPlayerId = game.turnPlayerId ?? null;
  let number = coverage?.firstTurn?.number ?? 1, ownerId = coverage?.firstTurn?.ownerId ?? game.firstPlayerId;
  if (!ids.includes(ownerId) && ordered[0]?.sequence === 1) {
    ownerId = ordered.flatMap(group => group.events).find(event => event.type === 'turn-ended')?.actorSeatId;
  }
  let anchored = ids.includes(ownerId), expectedSequence = coverage?.startSequence ?? 1;
  let partialStart = coverage?.partialStart === true;
  function obtain(turnId, turnNo, owner, partial = false) {
    if (!byId.has(turnId)) {
      const value = { id: turnId, number: turnNo, ownerId: owner, round: Math.ceil(turnNo / Math.max(1, ids.length)),
        playerTurnNumber: Math.floor((turnNo - 1) / Math.max(1, ids.length)) + 1,
        entries: [], groups: [], ended: false, ongoing: false, complete: false, partial };
      byId.set(turnId, value); turns.push(value); people.find(player => player.id === owner)?.turns.push(turnId);
    }
    const value = byId.get(turnId); value.partial ||= partial; return value;
  }
  for (const group of ordered) {
    if (group.sequence > headSequence) continue;
    if (group.sequence !== expectedSequence) { issue('missing-sequence'); anchored = false; }
    expectedSequence = group.sequence + 1;
    const explicit = [2, 3].includes(group.schemaVersion) && group.turn;
    if (explicit && ids.includes(explicit.ownerSeatId) && turnNumber(explicit.id) === explicit.number) {
      const matchesCursor = anchored && explicit.number === number && explicit.ownerSeatId === ownerId;
      number = explicit.number; ownerId = explicit.ownerSeatId; anchored = true;
      if (!matchesCursor) partialStart = true;
    }
    if (!anchored) { unassigned.push(group); issue('unknown-turn-owner'); continue; }
    if (byId.has(`turn-${number}`) && byId.get(`turn-${number}`).ownerId !== ownerId) {
      byId.get(`turn-${number}`).partial = true; unassigned.push(group); issue('conflicting-turn-owner'); anchored = false; continue;
    }
    const turn = obtain(`turn-${number}`, number, ownerId, partialStart);
    const boundaries = group.events.filter(event => event.type === 'turn-ended');
    if (boundaries.length > 1 || boundaries.some(event => event.actorSeatId !== ownerId)) {
      // A recovery batch can cross multiple turns. Aggregate resource deltas
      // cannot be divided reliably, so do not assign the batch to one player.
      turn.partial = true; unassigned.push(group); issue('ambiguous-turn-boundary'); anchored = false; continue;
    }
    turn.groups.push(group);
    group.events.forEach((event, index) => turn.entries.push({ sequence: group.sequence, index, committedAt: group.committedAt, event: clone(event) }));
    if (boundaries.length === 1) {
      turn.ended = true; number++; ownerId = ids[(ids.indexOf(ownerId) + 1) % ids.length]; partialStart = false;
    }
    if (group.events.some(event => event.type === 'match-ended')) turn.ended = true;
  }
  if (expectedSequence <= headSequence) issue('missing-tail');
  if (currentTurnId && ids.includes(currentPlayerId) && integer(game.turnNumber) && game.turnNumber > 0) {
    const current = obtain(currentTurnId, game.turnNumber, currentPlayerId,
      issues.includes('missing-tail') || !anchored || partialStart && number === game.turnNumber);
    current.ongoing = game.status === 'playing';
    if (game.status === 'finished' || game.status === 'aborted') current.ended = true;
  }
  if (coverage?.complete === false) issue('incomplete-coverage');
  const fullTail = !issues.some(value => ['missing-tail', 'incomplete-coverage', 'conflicting-sequence'].includes(value));
  for (const turn of turns) {
    if (issues.includes('conflicting-sequence') || issues.includes('invalid-group')) turn.partial = true;
    if (turn.ongoing && !fullTail) turn.partial = true;
    turn.complete = !turn.partial && (turn.ended || turn.ongoing && fullTail);
  }
  turns.sort((a, b) => a.number - b.number);
  for (const player of people) player.turns.sort((a, b) => turnNumber(a) - turnNumber(b));
  return { players: people, turns, currentTurnId, currentPlayerId, partial: issues.length > 0 || turns.some(turn => turn.partial),
    issues, headSequence, unassigned };
}

/** Rebuild only explicit public discard position edits. A legacy group or an
 * uncertain position breaks provenance; equal card definitions never repair
 * that break and never become a claim about an internal card copy. */
export function discardProvenance(groups, currentDiscard) {
  let positions = null, previousSequence = null;
  for (const group of [...(groups ?? [])].sort((a, b) => a.sequence - b.sequence)) {
    if (previousSequence !== null && group.sequence !== previousSequence + 1) positions = null;
    previousSequence = group.sequence;
    const delta = [2, 3].includes(group.schemaVersion) ? group.discard : null;
    if (!delta) { positions = null; continue; }
    if (!positions || positions.length !== delta.beforeCount) positions = Array.from({ length: delta.beforeCount }, () => null);
    for (const item of [...delta.removed].sort((a, b) => b.index - a.index)) {
      if (positions[item.index] && positions[item.index].cardId !== item.cardId) positions = Array.from({ length: positions.length }, () => null);
      positions.splice(item.index, 1);
    }
    for (const item of [...delta.added].sort((a, b) => a.index - b.index)) positions.splice(item.index, 0, clone(item));
    if (positions.length !== delta.afterCount) positions = null;
  }
  return (currentDiscard ?? []).map((card, index) => {
    const cardId = card.definitionId ?? card.id, known = positions?.length === currentDiscard.length ? positions[index] : null;
    return known?.cardId === cardId ? { ...known, index, known: known.reason !== 'unknown' }
      : { index, cardId, actorSeatId: null, reason: 'unknown', sourceCardId: null, known: false };
  });
}
