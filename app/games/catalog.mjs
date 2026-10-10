// Browser-safe presentation metadata only. Never import a server game engine here.
const entries = [
  { gameType: 'rummikub', name: '拉密', page: 'room.html', minPlayers: 2, maxPlayers: 7,
    createHint: '每人回合 30 分钟', availabilityFlag: null,
    practicePage: 'practice.html', scoreKind: 'points',
    timeout: { action: '超时摸牌', hint: '时间到后自动摸一张牌；牌池空时按过牌规则处理' },
    assets: ['practice.html', 'room.html', 'app.mjs', 'rules.mjs', 'twist-rules.mjs',
      'table-layout.mjs', 'rack-layout.mjs', 'rummikub-feedback.mjs', 'rummikub-assist.mjs',
      'rummikub-preview-client.mjs', 'assets/joker-mark.png',
      'assets/joker-normal-v2.png', 'assets/joker-mirror-v2.png',
      'assets/joker-color-change-v2.png', 'assets/joker-double-v2.png',
      'games/rummikub/game-page.mjs', 'games/rummikub/rules.mjs', 'games/rummikub/jokers.mjs',
      'games/rummikub/table-layout.mjs', 'games/rummikub/rack-layout.mjs',
      'games/rummikub/feedback.mjs', 'games/rummikub/assist.mjs',
      'games/rummikub/preview-client.mjs', 'games/rummikub/presentation.mjs'] },
  { gameType: 'army-flip', name: '翻棋军棋', page: 'army.html', minPlayers: 2, maxPlayers: 2,
    createHint: '每人回合 30 分钟', availabilityFlag: null,
    practicePage: 'army-practice.html', scoreKind: 'outcome',
    timeout: { action: '超时跳过', hint: '时间到后自动跳过当前回合' },
    assets: ['army.html', 'army-room.mjs', 'army-presentation.mjs', 'army.css', 'army-board.mjs',
      'army-practice.html', 'army-practice.mjs', 'army-practice-engine.mjs',
      'games/army-flip/game-page.mjs', 'games/army-flip/practice-page.mjs',
      'games/army-flip/board.mjs', 'games/army-flip/presentation.mjs',
      'games/army-flip/practice-engine.mjs', 'games/army-flip/ui.css'] },
  { gameType: 'flying-chess', name: '飞行棋', page: 'flying.html', minPlayers: 2, maxPlayers: 4,
    createHint: '每人回合 30 分钟', availabilityFlag: null,
    practicePage: 'flying-practice.html', scoreKind: 'outcome',
    timeout: { action: '超时换人', hint: '时间到弃未使用骰子并换人，已经确认的飞机位置保留' },
    assets: ['flying.html', 'flying-practice.html', 'games/flying-chess/board.mjs',
      'games/flying-chess/routes.mjs', 'games/flying-chess/rules.mjs', 'games/flying-chess/art.mjs',
      'games/flying-chess/presentation.mjs', 'games/flying-chess/ui.css',
      'games/flying-chess/page-ui.mjs', 'games/flying-chess/game-page.mjs',
      'games/flying-chess/practice-engine.mjs', 'games/flying-chess/practice-page.mjs'] },
  { gameType: 'draw-and-guess', name: '你画我猜', page: 'drawing.html', minPlayers: 2, maxPlayers: 8,
    createHint: '一人画，大家同时猜', availabilityFlag: 'drawingEnabled',
    practicePage: 'drawing-practice.html', scoreKind: 'score',
    timeout: { action: '阶段自动继续', hint: '选词、绘画和揭晓按各自倒计时自动推进' },
    assets: ['drawing.html', 'drawing-practice.html', 'words.html', 'games/draw-and-guess/game-page.mjs',
      'games/draw-and-guess/canvas-view.mjs', 'games/draw-and-guess/styles.css',
      'games/draw-and-guess/practice-page.mjs', 'games/draw-and-guess/practice-engine.mjs', 'draw-and-guess-practice.mjs', 'games/draw-and-guess/wordbank-page.mjs',
      'games/draw-and-guess/wordbank.css', 'games/draw-and-guess/matcher.mjs',
      'games/draw-and-guess/request-intent.mjs'] },
  { gameType: 'poker414-2', name: '414 · 两副牌', page: 'poker414.html', minPlayers: 3, maxPlayers: 8,
    createHint: '普通出牌不限时 · 勾叉机会 5 秒', availabilityFlag: 'poker414Enabled',
    practicePage: 'poker414-practice.html', scoreKind: 'score',
    timeout: { action: '阶段自动继续', hint: '发牌及勾叉机会按阶段倒计时，普通出牌不限时' },
    assets: ['poker414.html', 'poker414-practice.html', 'games/poker414-2/practice-page.mjs',
      'games/poker414-2/practice-engine.mjs', 'games/poker414-2/practice-bot.mjs', 'games/poker414-2/rules.mjs', 'games/poker414-2/art.mjs', 'games/poker414-2/cards.mjs', 'games/poker414-2/patterns.mjs',
      'games/poker414-2/presentation.mjs', 'games/poker414-2/page-ui.mjs', 'games/poker414-2/layout.mjs',
      'games/poker414-2/styles.css', 'games/poker414-2/game-page.mjs', 'games/poker414-2/room-controller.mjs'] },
  { gameType: 'hyakki-trading', name: '幽街商人', page: 'hyakki.html', minPlayers: 2, maxPlayers: 2,
    createHint: '双人经营 · 每回合行动可调', availabilityFlag: 'hyakkiEnabled',
    practicePage: 'hyakki-practice.html', scoreKind: 'outcome',
    timeout: { action: '按当前步骤默认选择', hint: '主动回合30分钟，对方回应60秒；掉线保留当前材料并挂起' },
    assets: ['hyakki.html', 'hyakki-practice.html', 'hyakki-catalog.html',
      ...['game-page.mjs', 'room-controller.mjs', 'presentation.mjs', 'game-ui.mjs', 'game-ui-model.mjs', 'game-ui.css',
        'practice-page.mjs', 'practice-engine.mjs', 'practice-bot.mjs', 'rules.mjs', 'model.mjs', 'effects.mjs', 'tools.mjs',
        'auction.mjs', 'decision.mjs', 'lifecycle.mjs', 'validation.mjs', 'view.mjs', 'content/definitions.mjs', 'content/manifest.mjs',
        'digital-page-ui.mjs', 'digital-card-ui.mjs', 'digital-card.css', 'digital-styles.css', 'digital-catalog.mjs', 'digital-catalog-page.mjs', 'digital-catalog.css']
        .map(file => `games/hyakki-trading/${file}`),
      ...['firearms', 'imports', 'curios', 'beasts', 'antiques', 'salt-iron', 'card-back'].map(id => `assets/hyakki/v2/${id}.svg`),
      ...['c01', 'c02', 'c03', 'c04', 'c05', 'c06', 'c07', 'c08', 'c09', 'c10', 'c11', 'c12', 'c13',
        'm01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 't01', 't02', 't03', 't04', 't05', 't06', 't07', 't08', 't09', 't10', 'stall-permit']
        .map(id => `assets/hyakki/v2/${id}.webp`)] },
];

function safePage(page) { return typeof page === 'string' && /^[a-z][a-z0-9-]*\.html$/.test(page); }

/** One presentation registration per game. Execution and private state are server-owned. */
export function createPresentationCatalog(definitions) {
  if (!Array.isArray(definitions) || !definitions.length) throw new TypeError('游戏目录不能为空。');
  const catalog = new Map();
  const fields = new Set(['gameType', 'name', 'page', 'minPlayers', 'maxPlayers', 'practicePage', 'scoreKind', 'timeout', 'assets', 'createHint', 'availabilityFlag']);
  for (const item of definitions) {
    if (!item || Object.keys(item).some(field => !fields.has(field))
      || !/^[a-z][a-z0-9-]*$/.test(item.gameType) || catalog.has(item.gameType)
      || typeof item.name !== 'string' || !item.name.trim() || !safePage(item.page)
      || !Number.isSafeInteger(item.minPlayers) || !Number.isSafeInteger(item.maxPlayers)
      || item.minPlayers < 1 || item.maxPlayers < item.minPlayers
      || item.practicePage !== null && !safePage(item.practicePage)
      || !['points', 'outcome', 'score'].includes(item.scoreKind)
      || typeof item.createHint !== 'string' || !item.createHint.trim()
      || ![null, 'drawingEnabled', 'poker414Enabled', 'hyakkiEnabled'].includes(item.availabilityFlag)
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
export const creatableGamePresentations = (capabilities = {}) => presentationCatalog.list()
  .filter(game => game.availabilityFlag === null || capabilities[game.availabilityFlag] === true);
