// Every viewer follows the same reveal. Longer ties get one full throw per recorded round.
export function awardTiming(award) {
  const rolls = (award?.lots || []).flatMap((lot) =>
    lot.rolls.flatMap((round, index) =>
      round.map(({ id, die }) => ({ card: lot.card, id, die, attempt: index + 1 })),
    ),
  );
  const compare = 1400, diceStart = 3200, throwMs = 2100;
  const winner = diceStart + rolls.length * throwMs;
  return { compare, diceStart, throwMs, landed: 1250, rolls, winner, collect: winner + 2300, home: winner + 3900, duration: winner + 5700 };
}

export function awardBeat(plan, ms) {
  if (ms < plan.compare) return 'approach';
  if (ms < plan.diceStart) return 'compare';
  if (ms < plan.winner) return 'dice';
  if (ms < plan.collect) return 'winner';
  if (ms < plan.home) return 'collect';
  return 'home';
}
