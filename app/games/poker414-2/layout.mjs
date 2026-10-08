/** Geometry only: every selectable card keeps a non-overlapping 44px target. */
export function handLayout(width, count, { short = false, maxHeight = Infinity } = {}) {
  if (!Number.isFinite(width) || width < 44 || !Number.isInteger(count) || count < 0 || count > 108 || typeof short !== 'boolean' || !(maxHeight === Infinity || Number.isFinite(maxHeight) && maxHeight >= 0)) {
    throw new RangeError('手牌布局需要有效宽度和牌数。');
  }
  const gap = 2, maxColumns = Math.max(1, Math.floor((width + gap) / (44 + gap)));
  const columns = Math.min(Math.max(1, count), maxColumns, short ? 24 : 18);
  const rows = Math.ceil(count / columns);
  const cardWidth = Math.min(short ? 50 : 62, (width - gap * (columns - 1)) / columns);
  const preferredHeight = short ? 51 : Math.round(cardWidth * 1.35);
  const cardHeight = Math.max(44, Math.min(preferredHeight, Math.floor((maxHeight - Math.max(0, rows - 1) * gap) / Math.max(1, rows))));
  return { columns, rows, cardWidth, cardHeight, gap, height: rows ? rows * cardHeight + (rows - 1) * gap : 0 };
}

/** Public history may be smaller; the latest actionable target stays full size. */
export function publicLayout(width, height, groups, { compact = false } = {}) {
  const counts = groups.map(group => group.length);
  function fit(cardWidth) {
    const cardHeight = Math.round(cardWidth * 1.35), gap = Math.max(5, cardWidth * .55);
    let x = 0, rows = counts.length ? 1 : 0;
    for (const count of counts) {
      const groupWidth = count * cardWidth + Math.max(0, count - 1);
      if (groupWidth > width) return null;
      if (x && x + gap + groupWidth > width) { rows++; x = 0; }
      x += (x ? gap : 0) + groupWidth;
    }
    return rows * (cardHeight + (compact ? 0 : 14)) + Math.max(0, rows - 1) * 8 <= height ? { cardWidth, cardHeight, gap } : null;
  }
  for (let size = 36; size >= 12; size--) { const result = fit(size); if (result) return result; }
  return { cardWidth: 12, cardHeight: 16, gap: 6 };
}
