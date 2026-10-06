// Historical room envelope only. Game state and configuration belong to adapters.
// Keep schema 1..8 readable and keep the existing per-feature write versions.
export const snapshotHasRoles = data => [4, 5, 6, 7, 8].includes(data?.schemaVersion);
export function snapshotGameType(data) {
  if (snapshotHasRoles(data)) return data.gameType;
  return data.schemaVersion === 3 ? 'army-flip' : 'rummikub';
}
export function snapshotFormatProblem(data, adapter) {
  const hasRoles = snapshotHasRoles(data);
  return ![1, 2, 3, 4, 5, 6, 7, 8].includes(data?.schemaVersion)
    || adapter.snapshotProblem(data)
    || ![7, 8].includes(data.schemaVersion) && Object.hasOwn(data, 'turnClock')
    || data.schemaVersion === 7 && !Object.hasOwn(data, 'turnClock')
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
