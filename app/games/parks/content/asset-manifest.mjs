import { ALL_DEFINITIONS, GEAR, SAMPLE_IDS } from './catalog.mjs';
import { SAMPLE_ASSETS } from './sample-assets.mjs';
import { ORIGINAL_ART_SUBJECTS } from './original-art-assets.mjs';
import { SYMBOL_IDS } from './vector-art.mjs';
import { deepFreeze } from './immutable.mjs';

export const ASSET_VERSION = 'parks-art-v2-complete';
const samplesByFile = new Map(SAMPLE_ASSETS.map(asset => [asset.file, asset]));
const artBySubject = new Map(ORIGINAL_ART_SUBJECTS.map(asset => [asset.subjectId, asset]));
const symbolIds = new Set(SYMBOL_IDS);

function definitionSymbols(definition) {
  if (definition.symbol) return [definition.symbol];
  switch (definition.kind) {
    case 'park': return ['mountain'];
    case 'gear': return ['gear'];
    case 'passion': return ['passion'];
    case 'canteen': return ['canteen'];
    case 'season': return ['season'];
    case 'camping-face':
    case 'camping-slot':
    case 'camping-tile':
    case 'tent': return ['tent'];
    case 'teddy': return ['teddy', `teddy-${definition.ownBackSelection}`];
    case 'volunteer': return ['volunteer'];
    case 'solo-reference': return ['solo-reference'];
    case 'die-face': return ['die', definition.face];
    case 'player-style': return ['hiker', definition.shape];
    case 'trail-site': {
      const symbol = definition.id.slice(5);
      return [symbolIds.has(symbol) ? symbol : ({ parks: 'mountain', 'wildlife-trade': 'exchange', 'canteen-or-photo': 'canteen', 'trail-die': 'die' })[symbol]];
    }
    default: throw new RangeError(`PARKS资源类别尚未映射：${definition.kind}`);
  }
}

function mapAsset(definition) {
  const originalFile = definition.kind === 'park' ? `park-${definition.id}.png`
    : definition.kind === 'gear' ? `gear-${definition.artId}.png` : null;
  const subjectId = definition.kind === 'park' ? `park.${definition.id}`
    : definition.kind === 'gear' ? `gear.${definition.artId}` : null;
  const art = subjectId ? artBySubject.get(subjectId) : null;
  if (subjectId && !art) throw new Error(`PARKS资源缺少独立插画：${subjectId}`);
  const sample = originalFile ? samplesByFile.get(originalFile) : null;
  const symbols = definitionSymbols(definition);
  if (symbols.some(symbol => !symbolIds.has(symbol))) throw new Error(`PARKS资源缺少图形：${definition.id}`);
  return {
    id: definition.id, definitionId: definition.id, kind: definition.kind,
    assetVersion: ASSET_VERSION, status: art ? 'ready' : 'svg',
    subjectId, file: art?.file ?? null, path: art?.path ?? null,
    atlasPath: art?.atlasPath ?? null, cropRect: art?.cropRect ?? null,
    atlasSize: art?.atlasSize ?? null,
    thumbnailPath: art?.thumbnailPath ?? null,
    thumbnailCropRect: art?.thumbnailCropRect ?? null,
    thumbnailSize: art?.thumbnailSize ?? null,
    fallbackTitle: definition.nameZh, symbols,
    renderer: art?.renderer ?? 'svg-with-rule-text',
    vectorModule: 'vector-art.mjs',
    source: art?.source ?? 'original-code-drawn',
    geographicReference: art?.geographicReference ?? null,
    width: art?.width ?? null, height: art?.height ?? null,
    sha256: art?.sha256 ?? null, bytes: art?.bytes ?? null,
    sourceSha256: art?.sourceSha256 ?? null,
    frontBackCoupled: definition.kind === 'teddy',
    // A sample subject may be reused by same-name gear, without merging their effects.
    sampleSubject: Boolean(sample), sampleCard: [...SAMPLE_IDS.parks, ...SAMPLE_IDS.gear].includes(definition.id),
  };
}

export const ASSET_MANIFEST = deepFreeze(ALL_DEFINITIONS.map(mapAsset));
const assetsById = new Map(ASSET_MANIFEST.map(asset => [asset.id, asset]));

export function getAsset(id) {
  if (typeof id !== 'string' || !assetsById.has(id)) throw new RangeError('未知的 PARKS 资源');
  return assetsById.get(id);
}

export const SUBJECT_MANIFEST = deepFreeze([
  ...ASSET_MANIFEST.filter(asset => asset.kind === 'park'),
  ...[...new Set(GEAR.map(gear => gear.artId))].map(artId => ASSET_MANIFEST.find(asset => asset.subjectId === `gear.${artId}`)),
]);

export const ASSET_COUNTS = deepFreeze({
  definitions: ASSET_MANIFEST.length,
  subjectsRequired: SUBJECT_MANIFEST.length,
  sampleSubjects: SUBJECT_MANIFEST.filter(asset => asset.sampleSubject).length,
  readySubjects: SUBJECT_MANIFEST.filter(asset => asset.status === 'ready').length,
  readyDefinitions: ASSET_MANIFEST.filter(asset => asset.status === 'ready').length,
  pendingSubjects: SUBJECT_MANIFEST.filter(asset => asset.status === 'pending').length,
  svgDefinitions: ASSET_MANIFEST.filter(asset => asset.status === 'svg').length,
});
