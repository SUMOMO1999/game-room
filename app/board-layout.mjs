/**
 * Geometry for the compact public table. Groups wrap as whole units.
 * Scale 0.4 is an overview limit, not a promise of precise touch targets;
 * large=true preserves full-size tiles and lets the table scroll instead.
 */

const MIN_SCALE = 0.4;
const EPSILON = 1e-7;

function viewportSize(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function measure(lengths, width, height, scale) {
  const gap = 38 * scale;
  const headerHeight = scale < 0.7 ? 10 : 14 * scale;
  const groupHeight = 54 * scale + headerHeight + 4 * scale;
  const items = lengths.map((length) => ({
    width: Math.max((length * 38 + (length - 1) * 4) * scale, 80 * scale),
    height: groupHeight,
  }));
  items.push({ width: Math.max(44, 90 * scale), height: Math.max(44, groupHeight) });

  let rows = 0;
  let rowWidth = 0;
  let rowHeight = 0;
  let contentHeight = 0;
  let exceedsWidth = false;

  for (const item of items) {
    if (rowHeight > 0 && rowWidth + gap + item.width > width + EPSILON) {
      contentHeight += rowHeight + gap;
      rows += 1;
      rowWidth = 0;
      rowHeight = 0;
    }
    rowWidth = rowHeight > 0 ? rowWidth + gap + item.width : item.width;
    rowHeight = Math.max(rowHeight, item.height);
    exceedsWidth ||= item.width > width + EPSILON;
  }
  if (rowHeight > 0) {
    contentHeight += rowHeight;
    rows += 1;
  }

  return {
    scale,
    rows,
    overflow: exceedsWidth || contentHeight > height + EPSILON,
    contentHeight: Math.round(contentHeight * 1000) / 1000,
  };
}

/**
 * fitBoard(meldLengths, {width, height, large=false})
 * rows counts wrapped rows including the final "new meld" target.
 * Width/height are the table's usable inner space, after padding/topline.
 * Invalid lengths are ignored; non-finite/non-positive viewport sizes become 0.
 * An empty table stays at scale 1, including when its new-meld target overflows.
 */
export function fitBoard(meldLengths, options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  const width = viewportSize(settings.width);
  const height = viewportSize(settings.height);
  const lengths = Array.isArray(meldLengths)
    ? meldLengths.filter((length) => Number.isSafeInteger(length) && length > 0)
    : [];

  if (!lengths.length || settings.large === true) return measure(lengths, width, height, 1);

  // Integer steps avoid floating-point accumulation: 1, .98, ... .42, .4.
  for (let step = 50; step >= 20; step -= 1) {
    const result = measure(lengths, width, height, step / 50);
    if (!result.overflow) return result;
  }
  return measure(lengths, width, height, MIN_SCALE);
}
