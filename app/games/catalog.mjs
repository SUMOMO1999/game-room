// Browser-safe presentation metadata only. Never import a server game engine here.
const entries = [
  { gameType: 'rummikub', name: '拉密', page: 'room.html', minPlayers: 2, maxPlayers: 7,
    practicePage: 'practice.html', scoreKind: 'points',
    timeout: { action: '超时摸牌', hint: '时间到后自动摸一张牌；牌池空时按过牌规则处理' },
    assets: ['practice.html', 'room.html', 'app.mjs', 'rules.mjs', 'twist-rules.mjs',
      'table-layout.mjs', 'rack-layout.mjs', 'rummikub-feedback.mjs', 'rummikub-assist.mjs',
      'rummikub-preview-client.mjs', 'assets/joker-mark.png',
      'games/rummikub/game-page.mjs', 'games/rummikub/rules.mjs', 'games/rummikub/jokers.mjs',
      'games/rummikub/table-layout.mjs', 'games/rummikub/rack-layout.mjs',
      'games/rummikub/feedback.mjs', 'games/rummikub/assist.mjs',
      'games/rummikub/preview-client.mjs', 'games/rummikub/presentation.mjs'] },
  { gameType: 'army-flip', name: '翻棋军棋', page: 'army.html', minPlayers: 2, maxPlayers: 2,
    practicePage: 'army-practice.html', scoreKind: 'outcome',
    timeout: { action: '超时跳过', hint: '时间到后自动跳过当前回合' },
    assets: ['army.html', 'army-room.mjs', 'army-presentation.mjs', 'army.css', 'army-board.mjs',
      'army-practice.html', 'army-practice.mjs', 'army-practice-engine.mjs',
      'games/army-flip/game-page.mjs', 'games/army-flip/practice-page.mjs',
      'games/army-flip/board.mjs', 'games/army-flip/presentation.mjs',
      'games/army-flip/practice-engine.mjs', 'games/army-flip/ui.css'] },
];

function safePage(page) { return typeof page === 'string' && /^[a-z][a-z0-9-]*\.html$/.test(page); }

/** One presentation registration per game. Execution and private state are server-owned. */
export function createPresentationCatalog(definitions) {
  if (!Array.isArray(definitions) || !definitions.length) throw new TypeError('游戏目录不能为空。');
  const catalog = new Map();
  const fields = new Set(['gameType', 'name', 'page', 'minPlayers', 'maxPlayers', 'practicePage', 'scoreKind', 'timeout', 'assets']);
  for (const item of definitions) {
    if (!item || Object.keys(item).some(field => !fields.has(field))
      || !/^[a-z][a-z0-9-]*$/.test(item.gameType) || catalog.has(item.gameType)
      || typeof item.name !== 'string' || !item.name.trim() || !safePage(item.page)
      || !Number.isSafeInteger(item.minPlayers) || !Number.isSafeInteger(item.maxPlayers)
      || item.minPlayers < 1 || item.maxPlayers < item.minPlayers
      || item.practicePage !== null && !safePage(item.practicePage)
      || !['points', 'outcome'].includes(item.scoreKind)
      || !item.timeout || typeof item.timeout.action !== 'string' || !item.timeout.action
      || typeof item.timeout.hint !== 'string' || !item.timeout.hint
      || Object.keys(item.timeout).some(field => !['action', 'hint'].includes(field))
      || !Array.isArray(item.assets) || !item.assets.every(path => typeof path === 'string')) {
      throw new TypeError('游戏公开目录定义无效。');
    }
    const route = Object.freeze({ name: item.name, page: item.page,
      minPlayers: item.minPlayers, maxPlayers: item.maxPlayers });
    catalog.set(item.gameType, Object.freeze({ ...item, route,
      timeout: Object.freeze({ ...item.timeout }), assets: Object.freeze([...item.assets]) }));
  }
  return Object.freeze({
    has: gameType => typeof gameType === 'string' && catalog.has(gameType),
    get(gameType = 'rummikub') {
      if (typeof gameType !== 'string' || !catalog.has(gameType)) throw new TypeError('无法识别这个房间的游戏。');
      return catalog.get(gameType);
    },
    list: () => Object.freeze([...catalog.values()]),
  });
}

export const presentationCatalog = createPresentationCatalog(entries);
export const gamePresentation = (gameType = 'rummikub') => presentationCatalog.get(gameType);
export const gamePresentations = () => presentationCatalog.list();
