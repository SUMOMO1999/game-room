// A record contains only menu choices. A one-element entry removes an old
// choice, so an older copy cannot bring it back on the next launch.
export const emptyOptions = () => ({ reset: 0, choices: {} });
export const optionName = name => typeof name === "string" &&
  /^[\p{L}\p{N}_.-]{1,120}$/u.test(name) && !["__proto__", "constructor", "prototype"].includes(name);

const limit = 256 * 1024;
const timestamp = value => Number.isSafeInteger(value) && value >= 0;

export function decodeOptions(text) {
  if (typeof text !== "string" || text.length > limit) return null;
  try {
    const record = JSON.parse(text, (name, value) => {
      if (["__proto__", "constructor", "prototype"].includes(name)) throw Error("Invalid option data");
      return value;
    });
    if (!record || !timestamp(record.reset) || !record.choices || Array.isArray(record.choices) ||
        typeof record.choices !== "object") return null;
    for (const [name, entry] of Object.entries(record.choices)) {
      if (!optionName(name) || !Array.isArray(entry) || entry.length < 1 || entry.length > 2 ||
          !timestamp(entry[0]) || entry[0] <= record.reset) return null;
    }
    return record;
  } catch { return null; }
}

export function mergeOptions(first, second) {
  const reset = Math.max(first.reset, second.reset);
  const choices = {};
  for (const source of [first, second]) {
    for (const [key, entry] of Object.entries(source.choices)) {
      if (entry[0] > reset && entry[0] >= (choices[key]?.[0] ?? 0)) choices[key] = entry;
    }
  }
  return { reset, choices };
}

export function readOptions(key) {
  try { return decodeOptions(localStorage.getItem(key)) ?? emptyOptions(); }
  catch { return emptyOptions(); }
}

export function writeOptions(key, record) {
  try {
    const text = JSON.stringify(record);
    if (!decodeOptions(text)) return null;
    try { if (localStorage.getItem(key) !== text) localStorage.setItem(key, text); } catch {}
    return text;
  } catch { return null; }
}
