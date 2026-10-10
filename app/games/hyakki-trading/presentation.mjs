/** Browser-side intent and committed cues. Never receives the hidden deck. */
const fieldsByAction = Object.freeze({
  peek: [], 'keep-peek': [], 'discard-peek': [], 'finish-draw': [], 'end-turn': [],
  buy: ['cardId'], sell: ['cardId'], 'buy-stall': ['cardId'],
  'play-character': ['cardId', 'params'], 'install-tool': ['cardId', 'replaceCardId'],
  'activate-tool': ['cardId', 'params'], respond: ['cardId'], 'decline-response': [],
  'choose-effect': ['selection'], bid: ['amount'], 'pass-bid': [],
});

export function hyakkiCommand(game, type, fields = {}) {
  if (!game || !Object.hasOwn(fieldsByAction, type)) throw new TypeError('当前没有可提交的幽街操作。');
  const body = { matchId: game.matchId, turnId: game.turnId };
  if (game.pending) {
    body.effectId = game.pending.id;
    body.decisionId = game.pending.decisionId;
  }
  for (const key of fieldsByAction[type]) {
    if (fields[key] !== undefined) body[key] = structuredClone(fields[key]);
  }
  return body;
}

export function hyakkiCues(before, game, selfId, role = 'player') {
  if (!before || !game || before.matchId !== game.matchId || game.publicEventSequence <= before.publicEventSequence) return [];
  const events = new Set((game.lastPublicEvents || []).map(event => event.type)), cues = [];
  if (game.result && !before.result) cues.push(game.result.aborted ? 'draw-result'
    : game.result.winnerIds.includes(selfId) ? 'win' : role === 'player' ? 'loss' : 'draw-result');
  else if (game.pending?.actorId === selfId && game.pending.decisionId !== before.pending?.decisionId
    || game.turnPlayerId === selfId && game.turnId !== before.turnId) cues.push('turn');
  if (['character-played', 'tool-installed', 'tool-activated', 'response-played'].some(type => events.has(type))) cues.push('placement');
  else if (['trade-bought', 'trade-sold', 'auction-settled', 'stall-expanded', 'bid-raised'].some(type => events.has(type))) cues.push('placement');
  else if (events.has('draw-peeked')) cues.push('draw');
  return [...new Set(cues)];
}
