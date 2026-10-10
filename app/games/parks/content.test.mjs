import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  CONTENT_COUNTS, CONTENT_PROVENANCE, ALL_DEFINITIONS, PARKS, GEAR, PASSIONS, CANTEENS,
  CANTEEN_TOKENS, SEASONS, CAMPING_TILES, CAMPING_FACES, CAMPING_SLOTS, TEDDY_CARDS,
  VOLUNTEER_PROJECTS, TRAIL_SITES, TRAIL_DIE, RESOURCES, SOLO_REFERENCE, SAMPLE_IDS,
  getDefinition, describeResources,
} from './content/catalog.mjs';
import { ASSET_MANIFEST, SUBJECT_MANIFEST, ASSET_COUNTS, getAsset } from './content/asset-manifest.mjs';
import { SYMBOL_IDS, getSymbolSvg } from './content/vector-art.mjs';
import { SAMPLE_ASSETS } from './content/sample-assets.mjs';
import { ORIGINAL_ART_FILES, ORIGINAL_ART_SUBJECTS } from './content/original-art-assets.mjs';

const projectRoot = new URL('../../../', import.meta.url);
const source = name => JSON.parse(fs.readFileSync(new URL(`docs/proposals/parks/${name}-catalog.json`, projectRoot)));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function assertOriginalFields(actual, expected) {
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, `${actual.id}.${key}`);
}

test('the public inventory contains every required definition and physical canteen', () => {
  assert.deepEqual(CONTENT_COUNTS, {
    parks: 63, gear: 37, gearSubjects: 13, passions: 10, canteenDefinitions: 6, canteenTokens: 24,
    seasons: 12, basicDefinitions: 128, basicEntities: 146, campingTiles: 4, campingFaces: 8,
    campingSlots: 32, teddy: 21, volunteerProjects: 9, trailSites: 9, dieFaces: 6, finiteResources: 106,
  });
  assert.equal(new Set(ALL_DEFINITIONS.map(item => item.id)).size, ALL_DEFINITIONS.length);
  assert.equal(new Set(CANTEEN_TOKENS.map(item => item.id)).size, 24);
  for (const canteen of CANTEENS) assert.equal(CANTEEN_TOKENS.filter(token => token.definitionId === canteen.id).length, canteen.copies);
  assert.deepEqual(CANTEEN_TOKENS.map(item => item.referenceNumber), Array.from({ length: 24 }, (_, index) => index + 1));
});

test('all original park rule fields survive the static conversion without reduction', () => {
  const original = source('park');
  assert.deepEqual(PARKS.map(item => item.id), original.cards.map(item => item.id));
  for (const item of original.cards) assertOriginalFields(getDefinition(item.id), item);
  assert.equal(PARKS.reduce((sum, park) => sum + park.points, 0), 271);
  assert.equal(PARKS.filter(park => park.hasInstantAction).length, 27);
  for (const park of PARKS) {
    assert.equal(park.hasInstantAction, park.instantEffect.type !== 'none');
    assert.deepEqual(Object.keys(park.cost).sort(), RESOURCES.map(resource => resource.id).sort());
    assert.ok(Object.values(park.cost).every(amount => Number.isInteger(amount) && amount >= 0));
  }
});

test('equipment, canteens, seasons, sites and dice preserve the complete source definitions', () => {
  const original = source('component');
  for (const list of [original.gear, original.canteens, original.seasons, original.trail.removableTiles, [original.trail.fixedSite]]) {
    for (const item of list) assertOriginalFields(getDefinition(item.id), item);
  }
  for (const item of original.trailDie) assertOriginalFields(getDefinition(`die.${item.face}`), item);
  assert.equal(new Set(GEAR.map(gear => gear.name)).size, 13);
  assert.equal(new Set(GEAR.map(gear => JSON.stringify([gear.name, gear.sunCost, gear.trigger, gear.effectSteps]))).size, 37);
  for (const season of ['spring', 'summer', 'fall']) assert.equal(SEASONS.filter(item => item.season === season).length, 4);
  assert.equal(getDefinition('season.2.1').compareMetric, '已拥有装备的印刷太阳费用合计');
  assert.equal(getDefinition('season.2.3').compareMetric, '已拥有水壶标记数量');
  assert.equal(TRAIL_SITES.filter(site => site.fixed).length, 1);
  assert.equal(TRAIL_SITES.find(site => site.fixed).id, 'site.parks');
  for (const face of TRAIL_DIE) assert.equal(getDefinition(face.shutterbugSite).kind, 'trail-site');
});

test('camping preserves the four explicit physical pairs and all thirty-two costs and effects', () => {
  const original = source('optional');
  assert.deepEqual(CAMPING_TILES.map(tile => tile.sourceFaceIds), [[1, 12], [2, 11], [3, 13], [4, 14]]);
  const allFaces = CAMPING_TILES.flatMap(tile => tile.faceIds);
  assert.equal(new Set(allFaces).size, 8);
  for (const face of original.camping.faces) {
    assertOriginalFields(getDefinition(face.id), face);
    assert.equal(face.slots.length, 4);
    for (const slot of face.slots) {
      assertOriginalFields(getDefinition(slot.id), slot);
      assert.equal(getDefinition(slot.id).faceId, face.id);
      assert.ok(getDefinition(slot.id).detailText.includes(slot.outerCost.descriptionZh));
    }
  }
  for (const face of CAMPING_FACES) assert.ok(getDefinition(face.physicalTileId).faceIds.includes(face.id));
  assert.equal(CAMPING_SLOTS.filter(slot => slot.faceId === 'camp.face.12').length, 4);
});

test('Teddy fronts stay paired with each physical back, and every volunteer remains distinct', () => {
  const original = source('optional');
  for (const item of [...original.rangerTeddy.cards, ...original.volunteers.cards]) assertOriginalFields(getDefinition(item.id), item);
  assert.equal(new Set(TEDDY_CARDS.map(card => JSON.stringify(card.front))).size, 9);
  assert.deepEqual(TEDDY_CARDS.reduce((counts, card) => ({ ...counts, [card.ownBackSelection]: counts[card.ownBackSelection] + 1 }), { front: 0, back: 0 }), { front: 8, back: 13 });
  assert.ok(TEDDY_CARDS.every(card => card.detailText.includes('牌堆新顶牌')));
  assert.equal(VOLUNTEER_PROJECTS.length, 9);
  assert.equal(getDefinition(SAMPLE_IDS.volunteer).ruleZh, '每购买1件装备，背包容量减少1资源。');
  assert.deepEqual(SOLO_REFERENCE.scoreRanks.map(rank => rank.minimumScore), [30, 35, 40, 45, 50]);
  assert.equal(SOLO_REFERENCE.photoRankingBonusUsed, false);
});

test('all ten passions expose mutually exclusive ability and scoring branches with distinct metrics', () => {
  assert.deepEqual(PASSIONS.map(passion => passion.id), [
    'passion.adventure', 'passion.birdwatching', 'passion.botany', 'passion.collecting', 'passion.forestry',
    'passion.kayaking', 'passion.mountaineering', 'passion.rock-climbing', 'passion.swimming', 'passion.wildlife',
  ]);
  for (const passion of PASSIONS) {
    assert.deepEqual(passion.branches.map(branch => branch.id), ['ability', 'scoring']);
    assert.ok(passion.goal.minimum > 0 && passion.score.divisor > 0);
    assert.ok(passion.branches.every(branch => typeof branch.text === 'string' && branch.text.length > 0));
    assert.match(passion.detailText, /只能选择一个分支/);
  }
  assert.notEqual(getDefinition('passion.forestry').goal.metric, getDefinition('passion.botany').goal.metric);
  assert.equal(getDefinition('passion.collecting').score.metric, 'gearPurchases');
  assert.equal(getDefinition('passion.wildlife').score.metric, 'currentPhotos');
  assert.equal(getDefinition('passion.swimming').ability.perTurn, 1);
});

test('every definition has Chinese readable fallback content and an explicit honest asset mapping', () => {
  assert.equal(ASSET_MANIFEST.length, ALL_DEFINITIONS.length);
  assert.equal(SUBJECT_MANIFEST.length, 76);
  assert.equal(ASSET_COUNTS.readySubjects, 76);
  assert.equal(ASSET_COUNTS.pendingSubjects, 0);
  assert.equal(ASSET_COUNTS.readyDefinitions, 100);
  assert.equal(new Set(ASSET_MANIFEST.map(asset => asset.id)).size, ALL_DEFINITIONS.length);
  for (const definition of ALL_DEFINITIONS) {
    for (const field of ['nameZh', 'shortText', 'detailText']) assert.ok(typeof definition[field] === 'string' && definition[field].length > 0, `${definition.id}.${field}`);
    const asset = getAsset(definition.id);
    assert.equal(asset.fallbackTitle, definition.nameZh);
    assert.ok(['ready', 'svg'].includes(asset.status));
    assert.ok(asset.symbols.length > 0);
    assert.ok(asset.symbols.every(symbol => SYMBOL_IDS.includes(symbol)));
    if (asset.status === 'ready') {
      const bytes = fs.readFileSync(new URL(`app${asset.path}`, projectRoot));
      assert.equal(sha256(bytes), asset.sha256);
      assert.equal(bytes.length, asset.bytes);
      assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
      assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP');
      assert.ok(asset.cropRect.x >= 0 && asset.cropRect.y >= 0);
      assert.ok(asset.cropRect.x + asset.width <= asset.atlasSize.width);
      assert.ok(asset.cropRect.y + asset.height <= asset.atlasSize.height);
      assert.ok(fs.existsSync(new URL(`app${asset.thumbnailPath}`, projectRoot)));
      assert.ok(asset.source.includes('imagegen'));
    } else {
      assert.equal(asset.file, null);
      assert.equal(asset.path, null);
    }
  }
  assert.notEqual(getDefinition('arches').nameZh, getDefinition('gateway-arch').nameZh);
});

test('all original park and gear subjects have separate image regions and bounded transfer assets', () => {
  assert.equal(ORIGINAL_ART_SUBJECTS.length, 76);
  assert.equal(ORIGINAL_ART_FILES.length, 15);
  const regions = ORIGINAL_ART_SUBJECTS.map(asset => `${asset.atlasPath}:${JSON.stringify(asset.cropRect)}`);
  assert.equal(new Set(regions).size, 76);
  for (const park of PARKS) assert.equal(getAsset(park.id).subjectId, `park.${park.id}`);
  for (const gear of GEAR) assert.equal(getAsset(gear.id).subjectId, `gear.${gear.artId}`);
  for (const file of ORIGINAL_ART_FILES) {
    const bytes = fs.readFileSync(new URL(`app${file.thumbnailPath}`, projectRoot));
    assert.equal(sha256(bytes), file.thumbnail.sha256);
    assert.equal(bytes.length, file.thumbnail.bytes);
    assert.ok(file.full.bytes < 1024 * 1024);
  }
  assert.ok(ORIGINAL_ART_FILES.reduce((sum, file) => sum + file.full.bytes, 0) <= 8 * 1024 * 1024);
  assert.ok(ORIGINAL_ART_FILES.reduce((sum, file) => sum + file.thumbnail.bytes, 0) <= 1.5 * 1024 * 1024);
});

test('the six reviewed original PNG samples remain unchanged alongside their transfer derivatives', () => {
  assert.equal(SAMPLE_ASSETS.length, 6);
  for (const sample of SAMPLE_ASSETS) {
    const bytes = fs.readFileSync(new URL(`app/assets/parks/v1/${sample.file}`, projectRoot));
    assert.equal(sha256(bytes), sample.sha256);
    assert.equal(bytes.length, sample.bytes);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), sample.width);
    assert.equal(bytes.readUInt32BE(20), sample.height);
  }
});

test('the representative selection actually covers ordinary, instant, wildlife-cost and long-name parks and different gear triggers', () => {
  const [ordinary, instant, wildlife, longName] = SAMPLE_IDS.parks.map(getDefinition);
  assert.equal(ordinary.hasInstantAction, false);
  assert.equal(ordinary.cost.wildlife, 0);
  assert.equal(instant.hasInstantAction, true);
  assert.equal(instant.instantEffect.type, 'roll_trail_die');
  assert.ok(wildlife.cost.wildlife > 0);
  assert.ok(longName.name.length >= 25);
  assert.deepEqual(SAMPLE_IDS.gear.map(id => getDefinition(id).trigger.kind), ['visitTrailSite', 'performAction']);
  assert.deepEqual(getDefinition(SAMPLE_IDS.campingTile).faceIds, SAMPLE_IDS.campingFaces);
  assert.notEqual(...SAMPLE_IDS.teddy.map(id => getDefinition(id).ownBackSelection));
});

test('content sources retain exact recorded digests and every source reference resolves', () => {
  for (const record of CONTENT_PROVENANCE.sources) assert.equal(sha256(fs.readFileSync(new URL(record.path, projectRoot))), record.sha256, record.path);
  function inspect(value) {
    if (!value || typeof value !== 'object') return;
    for (const ref of value.sourceRefs || []) assert.ok(Object.hasOwn(CONTENT_PROVENANCE.citations, ref.split(':')[0]), ref);
    Object.values(value).forEach(inspect);
  }
  ALL_DEFINITIONS.forEach(inspect);
  assert.equal(CONTENT_PROVENANCE.ruleEngineImplemented, true);
});

test('shared definitions and asset metadata are deeply immutable and unknown identifiers reject', () => {
  for (const mutate of [
    () => { PARKS[0].cost.water = 99; }, () => { GEAR[0].trigger.kind = 'changed'; },
    () => { PASSIONS[0].branches.pop(); }, () => { CAMPING_FACES[0].slots[0].effectSteps.pop(); },
    () => { TEDDY_CARDS[0].front.trailEnd = 'changed'; }, () => { ASSET_MANIFEST[0].symbols.push('unknown'); },
    () => { CANTEEN_TOKENS[0].definitionId = 'unknown'; },
  ]) assert.throws(mutate, TypeError);
  for (const id of [undefined, '__proto__', 'unknown', {}, 1]) {
    assert.throws(() => getDefinition(id), RangeError);
    assert.throws(() => getAsset(id), RangeError);
  }
  assert.equal(describeResources({ wildlife: 1, sun: 2, mountain: 0 }), '太阳 ×2、野生动物 ×1');
  for (const vector of [{ unknown: 1 }, { water: -1 }, { water: 1.5 }, { water: NaN }]) assert.throws(() => describeResources(vector), RangeError);
  assert.throws(() => describeResources(null), TypeError);
});

test('original vector symbols render safely with explicit labels and reject malformed options', () => {
  for (const symbol of SYMBOL_IDS) {
    const svg = getSymbolSvg(symbol, { title: '规则图标', size: 48 });
    assert.match(svg, /^<svg/);
    assert.match(svg, /viewBox="0 0 64 64"/);
    assert.match(svg, /<title>规则图标<\/title>/);
    assert.doesNotMatch(svg, /<script|href=|onload=/i);
  }
  assert.match(getSymbolSvg('water', { title: '<img onerror="x">&' }), /&lt;img onerror=&quot;x&quot;&gt;&amp;/);
  assert.match(getSymbolSvg('water'), /aria-hidden="true"/);
  for (const id of ['__proto__', 'unknown', undefined]) assert.throws(() => getSymbolSvg(id), RangeError);
  assert.throws(() => getSymbolSvg('water', { size: 0 }), RangeError);
});

test('the public content module graph has no runtime filesystem, research-document or third-party dependency', () => {
  const directory = new URL('./content/', import.meta.url);
  for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.mjs'))) {
    const code = fs.readFileSync(new URL(name, directory), 'utf8');
    for (const match of code.matchAll(/(?:import|export)\s+[^;]*?from\s+['"]([^'"]+)['"]/g)) {
      assert.match(match[1], /^\.\/[a-z-]+\.mjs$/, `${name}: ${match[1]}`);
      assert.ok(fs.existsSync(new URL(match[1], directory)));
    }
    assert.doesNotMatch(code, /\b(?:fetch|readFileSync|readFile|require)\s*\(/, name);
  }
});
