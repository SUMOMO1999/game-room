import { createObjectMotion } from '../../platform/object-motion.mjs';

/** Local layout is visual only; the controller marks authoritative baselines
 * and confirmations. No rack/deck state or private projection is stored here. */
export function mountRummikubMotion({ root = document.body, document: doc = root.ownerDocument,
  window: win = doc.defaultView } = {}) {
  if (!doc.querySelector('[data-rummi-motion-style]')) {
    const style = doc.createElement('link'); style.rel = 'stylesheet';
    style.href = new URL('./motion.css', import.meta.url).href; style.dataset.rummiMotionStyle = '';
    doc.head.append(style);
  }
  root.classList.add('rummi-motion');
  const motion = createObjectMotion({ root, document: doc, window: win, maxObjects: 16 });
  const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)');
  let origins = null, frame = null, quiet = true, quietFrame = null, drop = null, stamp = 0;
  const effects = new Set();
  const groupEffects = new Map();
  const tiles = () => [...root.querySelectorAll('#board [data-tile], #rack [data-tile]')];
  const groups = () => [...root.querySelectorAll('#board .meld[data-group-key]')];
  const publicId = tile => tile.dataset.tile || tile.dataset.previewTile;
  function stopEffects() {
    for (const effect of effects) effect.cancel(); effects.clear();
    for (const [node,effect] of groupEffects) {effect.cancel();node.classList.remove('rummi-group-moving');}
    groupEffects.clear();
  }
  function cancel() {
    stamp++; motion.cancel(); origins = null; drop = null;
    stopEffects();
    if (frame !== null) win.cancelAnimationFrame(frame); frame = null;
  }
  function baseline() {
    cancel(); quiet = true;
    if (quietFrame !== null) win.cancelAnimationFrame(quietFrame);
    quietFrame = win.requestAnimationFrame(() => { quietFrame = null; quiet = false; });
  }
  function begin({publicOnly=false}={}) {
    if (quiet || doc.hidden) return false;
    if (origins) {if(publicOnly)origins.publicOnly=true;return true;}
    // Capture current visual rectangles before cancelling an in-flight move.
    // A newer preview continues from where the previous animation is now.
    const publicGroups=new Map(),publicTiles=new Map();
    for(const group of groups().slice(0,180)) {
      const rect=group.getBoundingClientRect();
      if(rect.width && rect.height)publicGroups.set(group.dataset.groupKey,rect);
      for(const tile of group.querySelectorAll('[data-tile], [data-preview-tile]')) {
        const tileRect=tile.getBoundingClientRect(),id=publicId(tile);
        if(id && tileRect.width && tileRect.height)publicTiles.set(id,tileRect);
      }
    }
    const privateTiles = new Map();
    for (const tile of publicOnly?[]:tiles()) {
      const rect = tile.getBoundingClientRect();
      if (rect.width && rect.height) privateTiles.set(tile.dataset.tile, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }
    if(!publicOnly)motion.cancel();stopEffects();
    origins={publicGroups,publicTiles,privateTiles,publicOnly};
    return true;
  }
  function moveGroups(before) {
    const moved=new Set();
    if(win.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return moved;
    for(const group of groups().slice(0,180)) {
      const children=[...group.querySelectorAll('[data-tile], [data-preview-tile]')];
      let from=before.publicGroups.get(group.dataset.groupKey);
      if(!from) {
        // Split/merge uses the visible original tiles as its spatial anchor.
        const rects=children.map(tile=>before.publicTiles.get(publicId(tile))).filter(Boolean);
        if(!rects.length)continue;
        const x=Math.min(...rects.map(r=>r.x)),y=Math.min(...rects.map(r=>r.y));
        from={x,y,width:Math.max(...rects.map(r=>r.x+r.width))-x,height:Math.max(...rects.map(r=>r.y+r.height))-y};
      }
      const target=group.getBoundingClientRect();
      if(!target.width || !target.height || Math.abs(target.x-from.x)+Math.abs(target.y-from.y)+Math.abs(target.width-from.width)+Math.abs(target.height-from.height)<3)continue;
      // Translate in local units: the table and game viewport may both scale.
      const sx=group.offsetWidth?target.width/group.offsetWidth:1,sy=group.offsetHeight?target.height/group.offsetHeight:1;
      const effect=group.animate?.([
        {transformOrigin:'0 0',transform:`translate(${(from.x-target.x)/sx}px,${(from.y-target.y)/sy}px) scale(${from.width/target.width},${from.height/target.height})`},
        {transformOrigin:'0 0',transform:'translate(0px,0px) scale(1,1)'},
      ],{duration:320,easing:'cubic-bezier(.2,.75,.3,1)'});
      if(!effect)continue;
      group.classList.add('rummi-group-moving');groupEffects.set(group,effect);
      for(const child of children)moved.add(publicId(child));
      effect.finished.catch(()=>{}).finally(()=>{if(groupEffects.get(group)===effect){groupEffects.delete(group);group.classList.remove('rummi-group-moving');}});
    }
    return moved;
  }
  function end(changed) {
    if (!changed || !origins) return;
    if (frame !== null) win.cancelAnimationFrame(frame);
    const current = stamp;
    frame = win.requestAnimationFrame(() => {
      frame = null; if (current !== stamp || doc.hidden) return;
      const before = origins; origins = null;
      const moved=moveGroups(before);if(before.publicOnly)return;
      let count = 0;
      for (const tile of tiles()) {
        if (count >= 16) break;
        const id = tile.dataset.tile, target = tile.getBoundingClientRect();
        if(moved.has(id))continue;
        let from = before.privateTiles.get(id);
        if (drop?.id === id && win.performance.now() - drop.at < 100) from = drop.rect;
        if (!from && tile.closest('#rack') && before.privateTiles.size) {
          const source = root.querySelector('#draw'), captured = motion.capture(source);
          if (!captured) continue;
          const back = doc.createElement('span'); back.className = 'tile rummi-motion-back'; back.textContent = '◆';
          captured.node = back;
          void motion.move({ from: captured, to: '#rack [data-tile="' + id + '"]', duration: 240, flip: true }); count++; continue;
        }
        if (!from || Math.abs(target.x - from.x) + Math.abs(target.y - from.y) < 3) continue;
        const captured = motion.capture(tile, { presentationAttributes: ['data-color', 'data-joker-type'] }); if (!captured) continue;
        captured.rect = from;
        void motion.move({ from: captured, to: (tile.closest('#rack') ? '#rack' : '#board') + ' [data-tile="' + id + '"]', duration: 210 }); count++;
      }
      drop = null;
    });
  }
  function confirmed(ids) {
    // The same real tiles are already in the player's draft. A small settle
    // marks server acceptance without pretending they were played twice.
    const current = stamp;
    win.requestAnimationFrame(() => {
      if (current !== stamp || doc.hidden || quiet || win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      let count = 0;
      for (const tile of root.querySelectorAll('#board [data-tile]')) if (count < 16 && ids.includes(tile.dataset.tile)) {
        count++;
        const effect = tile.animate?.([{ boxShadow: '0 0 0 2px #ffe4a8', transform: 'translateY(-2px)' },
          { boxShadow: '0 0 0 0px transparent', transform: 'translateY(0)' }], { duration: 260, easing: 'ease-out' });
        if (effect) { effects.add(effect); effect.finished.catch(() => {}).finally(() => effects.delete(effect)); }
      }
    });
  }
  const hide = () => { if (doc.hidden) baseline(); };
  doc.addEventListener('visibilitychange', hide); win.addEventListener('resize', baseline);
  win.addEventListener('pagehide', baseline);reduced?.addEventListener?.('change', baseline);
  baseline();
  return { begin, end, baseline, cancel, confirmed, sync: () => motion.sync(),
    dropOrigin(id, rect) { if (id && rect) drop = { id, rect, at: win.performance.now() }; },
    destroy() { cancel(); if (quietFrame !== null) win.cancelAnimationFrame(quietFrame); motion.destroy();
      doc.removeEventListener('visibilitychange', hide); win.removeEventListener('resize', baseline);
      win.removeEventListener('pagehide', baseline);reduced?.removeEventListener?.('change', baseline); } };
}

export function placementCue({ autoSplit = false, merged = false } = {}) {
  return autoSplit ? 'split' : merged ? 'merge' : 'placement';
}
