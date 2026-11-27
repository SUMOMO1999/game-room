// Only the waiting tables whose host opted into discovery appear here.
export async function publicLastHandTables(storage, now) {
  const tables = [];
  for (const { value } of await storage.scan('rooms')) {
    const room = value.snapshot;
    if (room?.gameType !== 'last-hand' || room.phase !== 'waiting' ||
        !room.tableOptions?.public || room.players.length >= room.tableOptions.seats ||
        room.lastActiveAt + 8 * 3600000 <= now) continue;
    tables.push({
      code: room.code, host: room.players.find(p => p.id === room.hostId)?.name || '牌友',
      seats: room.tableOptions.seats, occupied: room.players.length, mode: room.tableOptions.mode,
    });
    if (tables.length === 30) break;
  }
  return tables;
}
