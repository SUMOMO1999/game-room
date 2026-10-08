import { randomInt } from 'node:crypto';
import { RoomError } from '../../../app/rooms.mjs';
import { drawConfigProblem } from './adapter.mjs';

const fail = (status, code, message) => { throw new RoomError(status, code, message); };
const actor = userKey => ({ userKey, member: true, displayName: '伙伴' });
const defaults = version => ({ packId: 'dg-base', version,
  categoryIds: ['daily', 'nature', 'food', 'action-job', 'place-transport'], difficulties: ['easy', 'normal'] });

// Content is assembled on the server before a room CAS. A frozen match never
// follows later edits or depends on the current head of its original word pack.
export function createDrawingContentAssembly({ wordbanks, ready, enabled = false, now = Date.now, serverRandomInt = randomInt }) {
  async function selected(snapshot, userKey, config, expiresAt) {
    const invalid = drawConfigProblem(config, { allowUnselected: false });
    if (invalid) fail(400, 'INVALID_CONFIG', invalid);
    const selection = config.contentSelection;
    const release = await wordbanks.retainRelease(actor(userKey), selection.packId, selection.version,
      { referenceId: `room-${snapshot.roomId}`, expiresAt });
    const categories = new Map(release.categories.filter(category => category.status === 'active').map(category => [category.id, category.name]));
    if (selection.categoryIds.some(id => !categories.has(id))) fail(400, 'CATEGORY_UNAVAILABLE', '请选择发布版本中的有效分类。');
    const pool = release.words.filter(word => word.status === 'reviewed' && selection.categoryIds.includes(word.category) && selection.difficulties.includes(word.difficulty));
    if (pool.length < 3) fail(400, 'WORD_POOL_SMALL', '所选分类和难度需要至少三个有效词条。');
    return { pool, categories, selection };
  }
  return {
    async prepareRoom(snapshot, userKey, context) {
      if (snapshot.gameType !== 'draw-and-guess') return snapshot;
      if (!enabled) fail(503, 'DRAWING_PREPARING', '你画我猜正在准备，验收后开放。');
      await ready;
      const base = await wordbanks.get(actor(userKey), 'dg-base');
      if (!base.publishedHead) fail(503, 'CONTENT_UNAVAILABLE', '基础词库还未完成发布。');
      snapshot.drawConfig.contentSelection = defaults(base.publishedHead);
      await selected(snapshot, userKey, snapshot.drawConfig, context.expiresAt);
      return snapshot;
    },
    async prepareAction(snapshot, userKey, input, context) {
      if (snapshot.gameType !== 'draw-and-guess') return {};
      if (!enabled) fail(503, 'DRAWING_PREPARING', '你画我猜正在准备，验收后开放。');
      const member = [...snapshot.players, ...(snapshot.spectators || [])].find(player => player.userKey === userKey);
      // Recovered receipts must not be invalidated by later pack retirement.
      if (member?.requests.some(([id]) => id === input.requestId)) return {};
      if (input.type === 'rematch') {
        if (member?.id !== snapshot.hostId) fail(403, 'HOST_REQUIRED', '只有房主可以发起下一局。');
        if (!['finished','aborted'].includes(snapshot.phase)) return {};
        if (input.expectedRevision !== snapshot.revision) fail(409, 'REVISION_CONFLICT', '房间已更新，请同步后重试。');
        await ready;
        try {
          await selected(snapshot, userKey, snapshot.drawConfig, context.expiresAt);
          return {};
        } catch (error) {
          // A private former host's pack or a collected/retired release cannot
          // trap the room in its finished phase. Explicit reselection is needed.
          if (![403,404].includes(error.status) && error.code !== 'PACK_RETIRED') throw error;
          return {drawRematchConfig:{...snapshot.drawConfig,contentSelection:null}};
        }
      }
      if (!['configure', 'start'].includes(input.type)) return {};
      if (member?.id !== snapshot.hostId) fail(403, 'HOST_REQUIRED', '只有房主可以更改或开始对局。');
      if (snapshot.phase !== 'waiting') fail(409, 'ROOM_LOCKED', '开局后不能改变本局词库。');
      if (input.expectedRevision !== snapshot.revision) fail(409, 'REVISION_CONFLICT', '房间已更新，请同步后重试。');
      if (input.type === 'start' && (snapshot.players.length < 2 || !snapshot.players.every(player => player.ready))) return {};
      await ready;
      const { pool, categories, selection } = await selected(snapshot, userKey, input.type === 'configure' ? input.drawConfig : snapshot.drawConfig, context.expiresAt);
      if (input.type === 'configure') return {};
      const required = snapshot.players.length * snapshot.drawConfig.rounds * 3;
      if (pool.length < required) fail(400, 'WORD_POOL_SMALL', `本局需要至少 ${required} 个词条，请增加分类或降低轮数。`);
      const shuffled = [...pool];
      for (let index = 0; index < required; index++) {
        const offset = serverRandomInt(shuffled.length - index);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset >= shuffled.length - index) fail(503, 'RANDOM_UNAVAILABLE', '抽词暂时不可用。');
        const target = index + offset;
        [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
      }
      return { frozenCandidates: shuffled.slice(0, required).map(word => ({ ...word,
        packVersion: String(selection.version), categoryName: categories.get(word.category) })) };
    },
  };
}
