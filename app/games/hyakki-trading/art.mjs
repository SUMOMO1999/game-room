import { gamePath } from '../../entry-path.mjs';
import { GOODS, ACTIONS } from './content.mjs';

export const ART_VERSION = 'hyakki-art-v1';
const assets = new Map([
  ...GOODS.map(good => [good.id, { file: `${good.id}.svg`, label: good.name }]),
  ...ACTIONS.map(action => [action.id, { file: `${action.id}.webp`, label: action.name }]),
  ['card-back', { file: 'card-back.webp', label: '未公开的牌' }],
]);

export function assetPath(id) {
  const asset = assets.get(id);
  if (!asset) throw new RangeError('未知的百鬼商会资源');
  return gamePath(`/assets/hyakki/v1/${asset.file}`);
}

/** Capture is needed because image errors do not bubble. Text remains present. */
export function mountArtFallback(root) {
  const mark = image => {
    if (image?.matches?.('img[data-hyakki-art]')) image.classList.add('hyakki-art--missing');
  };
  const onError = event => mark(event.target);
  root.addEventListener('error', onError, true);
  for (const image of root.querySelectorAll('img[data-hyakki-art]')) {
    if (image.complete && image.naturalWidth === 0) mark(image);
  }
  return () => root.removeEventListener('error', onError, true);
}
