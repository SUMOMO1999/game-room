// Historical room envelope only. Game state and configuration belong to adapters.
// Keep schema 1..8 readable; schema9 belongs only to flying-chess. Existing
// games retain their historical per-feature write versions.
export const snapshotHasRoles = data => [4, 5, 6, 7, 8, 9].includes(data?.schemaVersion);
export function snapshotGameType(data) {
  if (snapshotHasRoles(data)) return data.gameType;
  return data.schemaVersion === 3 ? 'army-flip' : 'rummikub';
}
export function snapshotFormatProblem(data, adapter) {
  const hasRoles = snapshotHasRoles(data);
  return ![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(data?.schemaVersion)
    // These historical envelope guards preceded game dispatch. Keep their
    // ordering even for a corrupt snapshot carrying another game's type so
    // the existing INVALID_SNAPSHOT response stays identical.
    || data.schemaVersion !== 8 && data.game?.ruleVersion === 'friends-v4'
    || data.schemaVersion !== 5 && data.game?.ruleVersion === 'army-flip-v2'
    || ![6, 7].includes(data.schemaVersion) && data.game?.ruleVersion === 'army-flip-v3'
    || data.schemaVersion === 9 && (data.gameType !== 'flying-chess' || adapter.gameType !== 'flying-chess')
    || data.schemaVersion !== 9 && data.gameType === 'flying-chess'
    || adapter.snapshotProblem(data)
    || ![7, 8, 9].includes(data.schemaVersion) && Object.hasOwn(data, 'turnClock')
    || [7, 9].includes(data.schemaVersion) && !Object.hasOwn(data, 'turnClock')
    || (hasRoles ? data.gameType !== adapter.gameType || !Array.isArray(data.spectators)
      : data.schemaVersion === 3 ? data.gameType !== adapter.gameType : data.gameType !== undefined && data.gameType !== adapter.gameType)
    || !hasRoles && data.spectators !== undefined;
}
export function serializeRoomSnapshot(room, adapter) {
  const { listeners, players, spectators = [], rolesEnabled = false, gameType, ...data } = room;
  const memberSnapshot = ({ requests, ...player }) => ({ ...player, requests: [...requests] });
  const schemaVersion = adapter.snapshotSchema(room);
  return structuredClone({ ...data, ...(schemaVersion >= 4 ? { gameType, schemaVersion, spectators: spectators.map(memberSnapshot) }
    : schemaVersion === 3 ? { gameType, schemaVersion } : { schemaVersion }), players: players.map(memberSnapshot) });
}
