import { gamePath } from '../../../entry-path.mjs';
import { CARDS, GOODS, CONTENT_VERSION } from './definitions.mjs';

export const ART_VERSION = 'yousei-art-v2';
const makeAsset = (id, label, kind, file) => Object.freeze({
  id, label, kind, file,
  source: '自制数字版美术；不含原商业照片',
  cardIds: Object.freeze(CARDS.filter(card => card.artId === id || Object.hasOwn(card.goods, id)).map(card => card.id)),
  scenes: Object.freeze(id === 'card-back' ? ['hidden-hand', 'draw-pile'] : kind === 'goods' ? ['card-face', 'public-stock', 'player-shop', 'catalog'] : ['card-face', 'card-details', 'catalog']),
});

export const ASSETS = Object.freeze([
  ...GOODS.map(good => makeAsset(good.id, good.name, 'goods', `${good.id}.svg`)),
  ...CARDS.filter(card => card.artId).map(card => makeAsset(card.artId, card.name, card.category, `${card.artId}.webp`)),
  makeAsset('card-back', '统一牌背', 'back', 'card-back.svg'),
]);
const assetsById = new Map(ASSETS.map(asset => [asset.id, asset]));

export const CARD_FACES = Object.freeze(CARDS.map(card => Object.freeze({
  cardId: card.id,
  contentVersion: CONTENT_VERSION,
  artVersion: ART_VERSION,
  sourceCode: card.sourceCode,
  assetIds: Object.freeze(card.artId ? [card.artId] : Object.keys(card.goods)),
  textFallback: card.summary,
  scenes: Object.freeze(['catalog', 'details', 'hand', ...(card.category === 'tool' ? ['tool-zone', 'tapped-tool'] : []), 'public-selection']),
})));

export function getAsset(id) {
  const asset = assetsById.get(id);
  if (!asset) throw new RangeError('未知的幽街商人美术资源');
  return asset;
}

export function assetPath(id, entryModuleUrl) {
  return gamePath(`/assets/hyakki/v2/${getAsset(id).file}`, entryModuleUrl);
}

/** Captured image errors cover later DOM replacements too; only this root owns the listeners. */
export function mountArtFallback(root) {
  if (!root?.addEventListener || !root?.querySelectorAll) throw new TypeError('美术回退需要页面根节点');
  const update = (image, missing) => {
    if (!image?.matches?.('img[data-yousei-art]')) return;
    image.classList.toggle('is-missing', missing);
    image.closest('.yousei-art')?.classList.toggle('is-missing', missing);
    image.closest('.yousei-art')?.classList.toggle('is-loaded', !missing);
  };
  const onError = event => update(event.target, true);
  const onLoad = event => update(event.target, false);
  root.addEventListener('error', onError, true);
  root.addEventListener('load', onLoad, true);
  for (const image of root.querySelectorAll('img[data-yousei-art]')) {
    if (image.complete) update(image, image.naturalWidth === 0);
  }
  return () => {
    root.removeEventListener('error', onError, true);
    root.removeEventListener('load', onLoad, true);
  };
}
