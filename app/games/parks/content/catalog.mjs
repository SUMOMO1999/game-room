import { PARK_DATA } from './park-data.mjs';
import { COMPONENT_DATA } from './component-data.mjs';
import { OPTIONAL_DATA } from './optional-data.mjs';
import { PASSION_DATA } from './passion-data.mjs';
import { SOURCE_RECORDS, SOURCE_CITATIONS } from './provenance.mjs';
import { deepFreeze } from './immutable.mjs';

export const CONTENT_VERSION = 'parks-content-v1';
export const RULES_VERSION = 'parks-2e-full-v1';
export const CONTENT_PROVENANCE = deepFreeze({
  sources: SOURCE_RECORDS,
  citations: SOURCE_CITATIONS,
  status: 'complete-public-definitions-v1',
  ruleEngineImplemented: true,
  chineseNamesProvisional: true,
  limitations: [
    '规则采用第二版官方1.1及明确记录的项目解释，领域引擎与正式／练习共用。',
    '63张公园已独立核对；装备定义采用明确公开来源与实体照片交叉依据，未声称逐张实体拍照验证。',
    OPTIONAL_DATA.camping.pairingWarning,
  ],
});

for (const source of [PARK_DATA, COMPONENT_DATA, OPTIONAL_DATA, PASSION_DATA]) deepFreeze(source);

export const RESOURCES = deepFreeze([
  { id: 'mountain', nameZh: '山', stock: 16, symbol: 'mountain' },
  { id: 'forest', nameZh: '森林', stock: 16, symbol: 'forest' },
  { id: 'sun', nameZh: '太阳', stock: 30, symbol: 'sun' },
  { id: 'water', nameZh: '水', stock: 30, symbol: 'water' },
  { id: 'wildlife', nameZh: '野生动物', stock: 14, symbol: 'wildlife' },
].map(resource => ({ ...resource, kind: 'resource', shortText: `${resource.nameZh}资源池：${resource.stock}枚。`, detailText: '有限资源；库存、付款和领取由权威规则结算。' })));

const resourceById = new Map(RESOURCES.map(resource => [resource.id, resource]));

/** Display only: this formatter never decides payment legality or substitutions. */
export function describeResources(resources) {
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) throw new TypeError('资源数量必须是对象');
  for (const [id, amount] of Object.entries(resources)) {
    if (!resourceById.has(id) || !Number.isInteger(amount) || amount < 0) throw new RangeError('未知资源或无效数量');
  }
  return RESOURCES.filter(resource => resources[resource.id] > 0)
    .map(resource => `${resource.nameZh} ×${resources[resource.id]}`).join('、') || '无资源费用';
}

const parkNames = {
  "acadia": "阿卡迪亚",
  "arches": "拱门",
  "badlands": "恶地",
  "big-bend": "大弯",
  "biscayne": "比斯坎",
  "black-canyon-of-the-gunnison": "甘尼森黑峡谷国家公园",
  "bryce-canyon": "布赖斯峡谷",
  "canyonlands": "峡谷地",
  "capitol-reef": "圆顶礁",
  "carlsbad-caverns": "卡尔斯巴德洞穴",
  "channel-islands": "海峡群岛",
  "congaree": "康加里",
  "crater-lake": "火山口湖",
  "cuyahoga-valley": "库雅荷加谷",
  "death-valley": "死亡谷",
  "denali": "德纳里",
  "dry-tortugas": "干龟群岛",
  "everglades": "大沼泽",
  "gates-of-the-arctic": "北极之门",
  "gateway-arch": "盖特威拱门",
  "glacier": "冰川",
  "glacier-bay": "冰川湾",
  "grand-canyon": "大峡谷",
  "grand-teton": "大提顿",
  "great-basin": "大盆地",
  "great-sand-dunes": "大沙丘",
  "great-smoky-mountains": "大烟山",
  "guadalupe-mountains": "瓜达卢佩山脉",
  "haleakala": "哈雷阿卡拉",
  "hawaii-volcanoes": "夏威夷火山",
  "hot-springs": "温泉",
  "indiana-dunes": "印第安纳沙丘",
  "isle-royale": "皇家岛",
  "joshua-tree": "约书亚树",
  "katmai": "卡特迈",
  "kenai-fjords": "基奈峡湾",
  "kings-canyon": "国王峡谷",
  "kobuk-valley": "科伯克谷",
  "lake-clark": "克拉克湖",
  "lassen-volcanic": "拉森火山",
  "mammoth-cave": "猛犸洞穴",
  "mesa-verde": "梅萨维德",
  "mount-rainier": "雷尼尔山",
  "american-samoa": "美属萨摩亚国家公园",
  "new-river-gorge": "新河峡谷",
  "north-cascades": "北喀斯喀特",
  "olympic": "奥林匹克",
  "petrified-forest": "石化林",
  "pinnacles": "尖峰",
  "redwood": "红木",
  "rocky-mountain": "落基山",
  "saguaro": "巨人柱",
  "sequoia": "红杉",
  "shenandoah": "仙纳度",
  "theodore-roosevelt": "西奥多·罗斯福",
  "virgin-islands": "维尔京群岛",
  "voyageurs": "航海者",
  "white-sands": "白沙",
  "wind-cave": "风洞",
  "wrangell-st-elias": "兰格尔—圣埃利亚斯",
  "yellowstone": "黄石",
  "yosemite": "优胜美地",
  "zion": "锡安"
};

function instantText(effect) {
  switch (effect.type) {
    case 'none': return '无即时奖励';
    case 'gain_resources': return `立即获得${describeResources(effect.resources)}`;
    case 'gain_canteen': return `立即获得${effect.amount}枚水壶`;
    case 'take_shutterbug_badge': return '立即取得摄影徽章';
    case 'roll_trail_die': return `立即掷${effect.times}次步道骰`;
    default: throw new RangeError('未知公园即时奖励');
  }
}

export const PARKS = deepFreeze(PARK_DATA.map(park => ({
  ...park, kind: 'park', nameZh: parkNames[park.id], contentVersion: CONTENT_VERSION,
  costText: describeResources(park.cost), effectText: instantText(park.instantEffect),
  shortText: `${park.points}分 · ${instantText(park.instantEffect)}`,
  detailText: `游览费用：${describeResources(park.cost)}。游览后得${park.points}分；${instantText(park.instantEffect)}。${park.cost.wildlife ? '印刷的野生动物费用必须用野生动物支付。' : ''}`,
  sourceRefs: ['official-all-63-parks-image', 'official-rules-1-1:p6-7'],
})));

const gearArtIds = {
  'Flint & Tinder': 'flint-and-tinder', 'Wide Angle Lens': 'wide-angle-lens', 'Camp Mug': 'camp-mug',
  'Telephoto Lens': 'telephoto-lens', Compass: 'compass', Journal: 'journal', 'Mystery Cache': 'mystery-cache',
  Sunscreen: 'sunscreen', 'Rain Gear': 'rain-gear', Binoculars: 'binoculars', 'Hiking Boots': 'hiking-boots',
  'Sleeping Bag': 'sleeping-bag', 'Field Guide': 'field-guide',
};

export const GEAR = deepFreeze(COMPONENT_DATA.gear.map(gear => ({
  ...gear, kind: 'gear', nameZh: gear.zhNameProvisional, contentVersion: CONTENT_VERSION,
  artId: gearArtIds[gear.name], costText: `太阳 ×${gear.sunCost}`,
  shortText: `${gear.trigger.description}：${gear.effectSteps.join('，')}`,
  detailText: `购买费用：${gear.sunCost}太阳。${gear.trigger.description}时，依次${gear.effectSteps.join('，')}。每张装备每回合最多使用一次；地点触发与动作触发分别判断。`,
})));

export const PASSIONS = deepFreeze(PASSION_DATA.map(passion => ({
  ...passion, kind: 'passion', copies: 1, contentVersion: CONTENT_VERSION,
  branches: [
    { id: 'ability', nameZh: '能力', text: passion.abilityText, effect: passion.ability },
    { id: 'scoring', nameZh: '终局计分', text: passion.scoringText, formula: passion.score },
  ],
  shortText: passion.goalText,
  detailText: `目标：${passion.goalText}达成后立即选择且只能选择一个分支。能力：${passion.abilityText}计分：${passion.scoringText}已结清的动作不追溯重放。`,
  sourceRefs: ['official-1.1:p10-11', 'project:content.md#3', 'project:decisions.md#D02-D03'],
})));

const canteenNames = { mountain: '山岳水壶', forest: '森林水壶', sun: '日光水壶', parks: '公园水壶', photo: '摄影水壶', 'wildlife-trade': '野生动物水壶' };
export const CANTEENS = deepFreeze(COMPONENT_DATA.canteens.map(canteen => ({
  ...canteen, kind: 'canteen', nameZh: canteenNames[canteen.id.slice(8)],
  shortText: canteen.effect, detailText: `填入所在行后：${canteen.effect}。同一行每季只可填一次；双壶行按自己的选择顺序各结算一次。`,
})));
// Public material inventory, not a shuffled deck or a per-match instance sequence.
export const CANTEEN_TOKENS = deepFreeze(CANTEENS.flatMap(canteen => canteen.referenceNumbers.map(referenceNumber => ({
  id: `canteen.token.${referenceNumber}`, definitionId: canteen.id, referenceNumber,
}))));

const seasonNames = { spring: '春季', summer: '夏季', fall: '秋季' };
export const SEASONS = deepFreeze(COMPONENT_DATA.seasons.map(season => ({
  ...season, kind: 'season', nameZh: `${seasonNames[season.season]} · ${season.compareMetric}`,
  shortText: `比较${season.compareMetric}；奖励：${season.rewardSteps.join('，')}`,
  detailText: `季末比较${season.compareMetric}。多人至少为${season.minimumMetric}才有资格，并列者都得奖励；单人春／夏／秋门槛为3／4／5。奖励依次为：${season.rewardSteps.join('，')}。`,
})));

const siteNames = { forest: '森林', mountain: '山岳', sun: '日光', water: '溪水', 'wildlife-trade': '野生动物交换', 'canteen-or-photo': '水壶或摄影', gear: '装备', 'trail-die': '步道骰', parks: '公园' };
export const TRAIL_SITES = deepFreeze([...COMPONENT_DATA.trail.removableTiles, COMPONENT_DATA.trail.fixedSite].map(site => ({
  ...site, kind: 'trail-site', nameZh: siteNames[site.id.slice(5)],
  fixed: site.id === 'site.parks', shortText: site.action, detailText: site.action,
})));
export const TRAIL_DIE = deepFreeze(COMPONENT_DATA.trailDie.map(face => ({
  ...face, id: `die.${face.face}`, kind: 'die-face', nameZh: `${resourceById.get(face.face)?.nameZh || '水壶'}骰面`,
  shortText: face.effect, detailText: `${face.effect}。仅开局设置掷骰时，摄影地点标记放到“${siteNames[face.shutterbugSite.slice(5)]}”；普通回合掷骰不移动摄影地点标记。`,
})));

export const CAMPING_FACES = deepFreeze(OPTIONAL_DATA.camping.faces.map(face => ({
  ...face, kind: 'camping-face', nameZh: `露营板 ${face.physicalTileId.split('.').at(-1)} · 面 ${face.sourceFaceId}`,
  shortText: '四个营位，各有独立费用与效果。',
  detailText: face.slots.map(slot => `${slot.position}号营位：${slot.outerCost.descriptionZh}；${slot.effectSteps.map(step => step.descriptionZh).join('，')}。`).join(''),
})));
export const CAMPING_SLOTS = deepFreeze(CAMPING_FACES.flatMap(face => face.slots.map(slot => ({
  ...slot, kind: 'camping-slot', faceId: face.id, physicalTileId: face.physicalTileId,
  nameZh: `${face.nameZh} · 营位 ${slot.position}`,
  shortText: `${slot.outerCost.descriptionZh}；${slot.effectSteps.map(step => step.descriptionZh).join('，')}`,
  detailText: `外层费用：${slot.outerCost.descriptionZh}。依次执行：${slot.effectSteps.map(step => step.descriptionZh).join('，')}。内部购买或拍照费用仍须支付；占用后本季不可再用。`,
}))));
export const CAMPING_TILES = deepFreeze(OPTIONAL_DATA.camping.physicalPairing.map(tile => ({
  ...tile, id: tile.physicalTileId, kind: 'camping-tile', nameZh: `双面露营板 ${tile.physicalTileId.split('.').at(-1)}`,
  faceIds: tile.sourceFaceIds.map(id => `camp.face.${id}`),
  shortText: `正反两面：${tile.sourceFaceIds.join('／')}`,
  detailText: '实体只抽一次，再选其一面。配对采用公开数字对象证据；逐板实物翻面独立核对仍待完成。',
})));

export const TEDDY_CARDS = deepFreeze(OPTIONAL_DATA.rangerTeddy.cards.map(card => ({
  ...card, kind: 'teddy', nameZh: `巡护员 Teddy ${card.referenceNumber}`,
  shortText: `${card.front.movement.descriptionZh}；${card.front.trailEndDescriptionZh}`,
  detailText: `正面：${card.front.movement.descriptionZh}；终点选择${card.front.trailEndDescriptionZh}。本张背面：${card.ownBackDescriptionZh}。移动时使用翻牌后牌堆新顶牌的背面选择徒步者，不能拿翻出牌自己的背面决定本次移动。`,
})));
export const TEDDY_DRAW_CONTRACT = deepFreeze(OPTIONAL_DATA.rangerTeddy.drawContract);
export const VOLUNTEER_PROJECTS = deepFreeze(OPTIONAL_DATA.volunteers.cards.map(project => ({
  ...project, kind: 'volunteer', nameZh: project.zhNameProvisional,
  shortText: project.ruleZh, detailText: `${project.ruleZh}${project.interpretationNote || ''}`,
})));

const soloReference = OPTIONAL_DATA.fixedComponents.soloReference;
const rankNames = { Dayhiker: '一日行者', Trekker: '远足者', Explorer: '探索者', Adventurer: '探险家', Trailblazer: '开拓者' };
export const SOLO_REFERENCE = deepFreeze({
  ...soloReference, kind: 'solo-reference', nameZh: '官方单人参考',
  scoreRanks: soloReference.scoreRanks.map(rank => ({ ...rank, nameZh: rankNames[rank.label] })),
  shortText: '三季达标门槛：春3、夏4、秋5；不计算照片排名奖。',
  detailText: soloReference.actionSummary.map(item => `${item.condition}：${item.effect}`).join('') + '终局30／35／40／45／50分依次对应五个等级。',
});
export const TENTS = deepFreeze(OPTIONAL_DATA.fixedComponents.tents.ids.map((id, index) => ({
  id, kind: 'tent', nameZh: `帐篷 ${index + 1}`, initialTrailPosition: OPTIONAL_DATA.fixedComponents.tents.initialTrailPositions[index],
  shortText: '可选择进入本季空营位。', detailText: OPTIONAL_DATA.fixedComponents.tents.effectZh,
})));

export const PLAYER_STYLES = deepFreeze([
  { id: 'player.amber', nameZh: '琥珀', color: '#b56c19', shape: 'circle' },
  { id: 'player.teal', nameZh: '青绿', color: '#247f76', shape: 'triangle' },
  { id: 'player.blue', nameZh: '湖蓝', color: '#326bb2', shape: 'square' },
  { id: 'player.rose', nameZh: '玫红', color: '#a84970', shape: 'diamond' },
  { id: 'player.purple', nameZh: '紫罗兰', color: '#73559a', shape: 'pentagon' },
].map(style => ({ ...style, kind: 'player-style', hikerCount: 2, shortText: '两名徒步者与一个营火。', detailText: '颜色与轮廓双重区分玩家；图形大小不决定点击目标。' })));
export const FIXED_COMPONENTS = deepFreeze([
  { id: 'campfire.lit', nameZh: '点燃的营火', symbol: 'campfire', shortText: '可用于停靠已占用地点。' },
  { id: 'campfire.extinguished', nameZh: '熄灭的营火', symbol: 'campfire-off', shortText: '当前不能再次用于占位；按规则重新点燃。' },
  { id: 'marker.shutterbug-site', nameZh: '摄影地点标记', symbol: 'camera-site', shortText: '标出可取得摄影徽章的地点。' },
  { id: 'marker.shutterbug-badge', nameZh: '摄影徽章', symbol: 'camera-badge', shortText: '与摄影地点标记独立；拍照时有额外付费机会。' },
  { id: 'marker.first-player', nameZh: '先手标记', symbol: 'first-player', shortText: '指示下一季先手。' },
  { id: 'photo', nameZh: '照片', symbol: 'photo', physicalCount: 20, shortText: '数字版用非负整数计数，不设原盒标记数量上限。' },
  { id: 'album', nameZh: '相册', symbol: 'album', physicalCount: 8, shortText: '每本显示5张照片，不额外增加分数。' },
  { id: 'board.trail', nameZh: '步道主板', symbol: 'trail', shortText: '八块随机地点和第五位固定公园地点。' },
  { id: 'board.player', nameZh: '个人板', symbol: 'backpack', copies: 5, shortText: '展示背包、三行水壶（每行两槽）、营火与个人收藏。' },
  { id: 'marker.photo-ranking', nameZh: '照片排名奖励', symbol: 'photo-ranking', shortText: '多人按净持有照片排名；单人不用排名奖。' },
].map(item => ({ ...item, kind: 'fixed-component', detailText: item.shortText })));
export const CARD_BACKS = deepFreeze([
  { id: 'back.park', nameZh: '公园牌背', symbol: 'mountain' },
  { id: 'back.gear', nameZh: '装备牌背', symbol: 'gear' },
  { id: 'back.passion', nameZh: '热忱牌背', symbol: 'passion' },
  { id: 'back.volunteer', nameZh: '项目牌背', symbol: 'volunteer' },
].map(item => ({ ...item, kind: 'card-back', shortText: '未公开的牌', detailText: '同一牌堆的隐藏面一致，不展示定义编号、正面内容或牌序。' })));

export const ALL_DEFINITIONS = deepFreeze([
  ...PARKS, ...GEAR, ...PASSIONS, ...CANTEENS, ...SEASONS, ...TRAIL_SITES, ...TRAIL_DIE,
  ...CAMPING_FACES, ...CAMPING_SLOTS, ...CAMPING_TILES, ...TEDDY_CARDS, ...VOLUNTEER_PROJECTS,
  SOLO_REFERENCE, ...TENTS, ...RESOURCES, ...PLAYER_STYLES, ...FIXED_COMPONENTS, ...CARD_BACKS,
]);
const definitionsById = new Map(ALL_DEFINITIONS.map(definition => [definition.id, definition]));
if (definitionsById.size !== ALL_DEFINITIONS.length) throw new Error('PARKS定义编号重复');

export function getDefinition(id) {
  if (typeof id !== 'string' || !definitionsById.has(id)) throw new RangeError('未知的 PARKS 内容定义');
  return definitionsById.get(id);
}

export const SAMPLE_IDS = deepFreeze({
  parks: ['arches', 'grand-teton', 'acadia', 'black-canyon-of-the-gunnison'],
  gear: ['gear.01', 'gear.10'], passion: 'passion.adventure',
  canteens: ['canteen.mountain', 'canteen.sun', 'canteen.photo'],
  campingTile: 'camp.tile.1', campingFaces: ['camp.face.1', 'camp.face.12'],
  teddy: ['teddy.1', 'teddy.4'], volunteer: 'volunteer.responsible-consumption', soloReference: 'solo-reference',
});

export const CONTENT_COUNTS = deepFreeze({
  parks: PARKS.length, gear: GEAR.length, gearSubjects: new Set(GEAR.map(item => item.artId)).size,
  passions: PASSIONS.length, canteenDefinitions: CANTEENS.length, canteenTokens: CANTEEN_TOKENS.length,
  seasons: SEASONS.length, basicDefinitions: PARKS.length + GEAR.length + PASSIONS.length + CANTEENS.length + SEASONS.length,
  basicEntities: PARKS.length + GEAR.length + PASSIONS.length + CANTEEN_TOKENS.length + SEASONS.length,
  campingTiles: CAMPING_TILES.length, campingFaces: CAMPING_FACES.length, campingSlots: CAMPING_SLOTS.length,
  teddy: TEDDY_CARDS.length, volunteerProjects: VOLUNTEER_PROJECTS.length, trailSites: TRAIL_SITES.length,
  dieFaces: TRAIL_DIE.length, finiteResources: RESOURCES.reduce((sum, resource) => sum + resource.stock, 0),
});
