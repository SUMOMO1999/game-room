import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_DEFINITIONS, PARKS, GEAR, SAMPLE_IDS, getDefinition } from './content/catalog.mjs';
import { getAsset, SUBJECT_MANIFEST } from './content/asset-manifest.mjs';
import { renderCard, renderDetail, renderArtwork, escapeHtml } from './card-ui.mjs';

const visibleText = html => html.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim();
const imagePaths = html => [...html.matchAll(/<(?:img|image)\b[^>]*\b(?:src|href)="([^"]+)"/gu)].map(match => match[1]);

test('all 245 public definitions render readable identities and their complete details', () => {
  assert.equal(ALL_DEFINITIONS.length, 245);
  for (const definition of ALL_DEFINITIONS) {
    const face = renderCard(definition.id);
    const detail = renderDetail(definition.id);
    assert.match(face, /^<button\b/u);
    assert.equal((face.match(/<button\b/gu) || []).length, 1);
    assert.ok(face.includes(`data-card-id="${definition.id}"`));
    assert.ok(visibleText(face).includes(escapeHtml(definition.nameZh)), definition.id);
    assert.ok(detail.includes(escapeHtml(definition.detailText)), `${definition.id}: full detail`);
    assert.doesNotMatch(face + detail, /undefined|\[object Object\]|<script\b/u);
  }
});

test('cost-bearing park and gear faces retain instant effects and triggers alongside their prices', () => {
  for (const park of PARKS) {
    const face = renderCard(park.id);
    assert.ok(visibleText(face).includes(escapeHtml(park.effectText)), `${park.id}: effect`);
    for (const [resource, amount] of Object.entries(park.cost).filter(([, amount]) => amount > 0)) {
      assert.ok(face.includes(`>${amount}</b>`), `${park.id}: ${resource} count`);
    }
    assert.ok(face.includes(`>${park.points}<small>分</small>`));
  }
  for (const gear of GEAR) {
    const face = renderCard(gear.id);
    assert.ok(visibleText(face).includes(escapeHtml(gear.shortText)), `${gear.id}: trigger and effect`);
    assert.ok(face.includes(`>${gear.sunCost}</b>`));
  }
  assert.match(visibleText(renderCard('grand-teton')), /立即掷1次步道骰/u);
  assert.match(visibleText(renderCard('gear.01')), /到访2水地点：重新点燃营火/u);
  assert.match(visibleText(renderCard('gear.10')), /执行“预订1公园”：获得1水壶标记/u);
});

test('complete independent illustrations and SVG definitions use exact image or atlas mappings', () => {
  const paths = new Set();
  let svgCount = 0;
  for (const definition of ALL_DEFINITIONS) {
    const asset = getAsset(definition.id), face = renderCard(definition.id);
    if (asset.status === 'ready') {
      assert.deepEqual(imagePaths(face), [asset.atlasPath || asset.path]);
      paths.add(asset.subjectId);
      if(asset.renderer==='atlas')assert.ok(face.includes(`viewBox="${asset.cropRect.x} ${asset.cropRect.y} ${asset.cropRect.width} ${asset.cropRect.height}"`));
    } else {
      assert.deepEqual(imagePaths(face), []);
      if (asset.status === 'svg') {
        svgCount++;
        assert.match(face, /class="pk-vector-art"/u);
        assert.match(face, /<svg\b/u);
      }
    }
  }
  assert.equal(paths.size, 76);
  assert.equal(SUBJECT_MANIFEST.length, 76);
  assert.equal(svgCount, 145);
  for (const id of [...SAMPLE_IDS.parks, ...SAMPLE_IDS.gear]) assert.equal(getAsset(id).status, 'ready');
});

test('gear containment clips its own atlas cell and thumbnails retain the identical subject', () => {
  for (const gear of GEAR) {
    const asset = getAsset(gear.id);
    for (const thumbnail of [false, true]) {
      const face = renderCard(gear.id, { thumbnail });
      assert.match(face, /class="pk-art pk-art--gear"/u);
      const rect = thumbnail ? asset.thumbnailCropRect : asset.cropRect;
      assert.deepEqual(imagePaths(face), [thumbnail ? asset.thumbnailPath : asset.atlasPath]);
      if (asset.renderer === 'atlas') {
        assert.match(face, /preserveAspectRatio="xMidYMid meet"/u);
        assert.ok(face.includes(`class="pk-atlas-window" x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}"`));
        assert.match(face, /preserveAspectRatio="none" overflow="hidden"><image/u);
        assert.ok(face.includes(`x="${-rect.x}" y="${-rect.y}"`));
      }
    }
  }
  const park = getAsset('badlands');
  assert.match(renderArtwork(park), /preserveAspectRatio="xMidYMid slice"/u);
  for (const cropRect of [
    { ...park.cropRect, x: -1 }, { ...park.cropRect, width: 0 },
    { ...park.cropRect, y: NaN }, { ...park.cropRect, width: park.atlasSize.width + 1 },
  ]) assert.throws(() => renderArtwork({ ...park, cropRect }), TypeError);
});

test('forced image failure preserves actual costs, effects and accessible identity while details remain read-only', () => {
  for (const id of [...SAMPLE_IDS.parks, ...SAMPLE_IDS.gear]) {
    const definition = getDefinition(id);
    const face = renderCard(id, { missing: true, selected: true });
    assert.deepEqual(imagePaths(face), []);
    assert.match(visibleText(face), /插画未能加载/u);
    assert.ok(visibleText(face).includes(escapeHtml(definition.kind === 'park' ? definition.effectText : definition.shortText)));
    assert.match(face, /aria-pressed="true"/u);
    assert.ok(face.includes(escapeHtml(definition.costText)));
    const detail = renderDetail(id, { missing: true });
    assert.doesNotMatch(detail, /<button\b|data-card-id=|aria-pressed=/u);
    assert.ok(detail.includes(escapeHtml(definition.detailText)));
  }
  for (const id of ['unknown', '__proto__', undefined]) {
    assert.throws(() => renderCard(id), RangeError);
    assert.throws(() => renderDetail(id), RangeError);
  }
});
