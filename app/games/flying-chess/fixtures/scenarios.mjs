// Synthetic, fixed local-prototype inputs only. Build packaging excludes fixtures.
// These are not rooms, accounts, real dice results or persisted game states.
const allSides = ['red', 'blue', 'yellow', 'green'];

function planesFor(changes = {}, sides = allSides) {
  return sides.flatMap(side => Array.from({ length: 4 }, (_, index) => {
    const id = `${side}-${index + 1}`;
    return { id, side, number: index + 1, progress: changes[id] ?? -2 };
  }));
}

function scenario(id, title, note, die, changes = {}, options = {}) {
  const participatingSides = options.participatingSides || allSides;
  return {
    id, title, note, side: 'red', die,
    planes: planesFor(changes, participatingSides),
    role: 'player', paused: false, participatingSides: [...participatingSides], ...options,
  };
}

export const SCENARIOS = [
  scenario('launch', '六点起飞', '选择任意红机：六点只放到起飞点，不继续走六格。', 6),
  scenario('no-launch', '五点无法起飞', '红机都在机库，五点没有合法飞机；这个小样不会替你重掷。', 5),
  scenario('jump-fly', '跳后飞', '红 1 普通落 C13 → 跳 C17 → 飞 C29，各实际落点撞机；飞过黄方 H3 不攻击归航飞机。', 2, {
    'red-1': 11, 'blue-1': 0, 'yellow-1': 43, 'green-1': 42, 'yellow-2': 52,
  }),
  scenario('fly-jump', '飞后跳', '红 1 直接落 C17 → 飞 C29 → 跳 C33，与“跳后飞”的终点不同。', 2, {
    'red-1': 15, 'blue-1': 4, 'yellow-1': 3, 'green-1': 46,
  }),
  scenario('four-stack', '四架同格', '四架红机叠在 C07，每架都在大尺寸列表中独立可选；一次只移动一架。', 1, {
    'red-1': 7, 'red-2': 7, 'red-3': 7, 'red-4': 7,
  }),
  scenario('enemy-stack', '落点击退整叠', '红 1 越过 C07 的黄机不撞，落在 C08 后四架蓝机全部返库。', 2, {
    'red-1': 6, 'blue-1': 47, 'blue-2': 47, 'blue-3': 47, 'blue-4': 47, 'yellow-1': 33,
  }),
  scenario('bounce', '终点反弹', 'H4 掷四：先两步到 H6，再反弹两步回 H4。途经终点不算完成。', 4, { 'red-1': 53 }),
  scenario('finish', '精确完成', 'H4 掷二精确到 H6；其余三架已完成，完成飞机不可再选。此处只验证呈现，不进行正式结算。', 2, {
    'red-1': 53, 'red-2': 55, 'red-3': 55, 'red-4': 55,
  }),
  scenario('home-entrance', '归航入口不越界跳', '红 1 到 C49 后停住，不额外跳四格进入归航；下次骰子再正常前进。', 2, { 'red-1': 47 }),
  scenario('observer', '观战模式', '观众可看棋盘、固定骰面和公开信息，不能选机、预览或确认。', 2, {
    'red-1': 11, 'blue-1': 9, 'yellow-1': 22, 'green-1': 34,
  }, { role: 'observer' }),
  scenario('paused', '暂停模式', '保留棋盘与固定骰面，关闭行动。这是只读暂停示例，切换其他局面后再试操作。', 2, {
    'red-1': 11, 'red-2': -1, 'blue-1': 9, 'yellow-1': 22,
  }, { paused: true }),
  scenario('two-sides', '两人相对阵营', '红、黄各四架，共八架；未参赛阵营只有底图，没有飞机。', 3, {
    'red-1': -1, 'yellow-1': 8,
  }, { participatingSides: ['red', 'yellow'] }),
  scenario('three-sides', '三人阵营', '红、蓝、黄各四架，共十二架；未参赛的绿方没有飞机。', 4, {
    'red-1': 44, 'blue-1': 13, 'yellow-1': 25,
  }, { participatingSides: ['red', 'blue', 'yellow'] }),
];
