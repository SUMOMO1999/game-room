/** Fixed local-only dice script from design §5; never a production random source. */
export const PLANE_COMPLETION_DICE = Object.freeze([6, 5, 5, 4, 4, 4, 6]);
export const PLANE_COMPLETION_PROGRESS = Object.freeze([-1, 4, 13, 33, 41, 49, 55]);

export function completeFirstPlayerScript(playerIds, firstPlayerIndex) {
  const steps = [], playerId = playerIds[firstPlayerIndex];
  for (let number = 1; number <= 4; number += 1) {
    for (const die of PLANE_COMPLETION_DICE) {
      steps.push({ playerId, die, number });
      if (die !== 6) {
        for (let offset = 1; offset < playerIds.length; offset += 1) {
          steps.push({ playerId: playerIds[(firstPlayerIndex + offset) % playerIds.length], die: 1, number: null });
        }
      }
    }
  }
  return steps;
}
