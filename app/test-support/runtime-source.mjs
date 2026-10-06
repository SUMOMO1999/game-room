import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// UI VM fixtures must execute the implementation, while HTTP tests still check
// the actual bytes of compatibility entries. Do not publish or package this helper.
function canonicalImport(location, data) {
  const url = location instanceof URL ? location : pathToFileURL(String(location));
  if (!/\.(?:mjs|css)$/.test(url.pathname)) return null;
  const source = String(data).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '').trim();
  const match = source.match(/^(?:export \* from|import)\s+['"]([^'"]+)['"];?$/)
    ?? source.match(/^@import\s+['"]([^'"]+)['"];?$/);
  return match?.[1].startsWith('.') ? new URL(match[1], url) : null;
}

export async function readRuntimeSource(location, options, visited = new Set()) {
  const key = String(location);
  if (visited.has(key) || visited.size > 12) throw new Error('Compatibility source cycle.');
  visited.add(key);
  const data = await readFile(location, options), next = canonicalImport(location, data);
  return next ? readRuntimeSource(next, options, visited) : data;
}

export function readRuntimeSourceSync(location, options, visited = new Set()) {
  const key = String(location);
  if (visited.has(key) || visited.size > 12) throw new Error('Compatibility source cycle.');
  visited.add(key);
  const data = readFileSync(location, options), next = canonicalImport(location, data);
  return next ? readRuntimeSourceSync(next, options, visited) : data;
}
