import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicAssetPaths } from '../server/public-assets.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
function moduleImports(source) {
  const imports=[];
  for(const pattern of [
    /^\s*import\s*(?:[^;]*?\bfrom\s*)?(['"])([^'"]+)\1/gm,
    /^\s*export\s+(?:\{[^}]*\}|\*)\s+from\s*(['"])([^'"]+)\1/gm,
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  ])for(const match of source.matchAll(pattern))imports.push(match[2]);
  return imports;
}
async function publicModuleClosure(entry,publicFiles) {
  const visited=new Set();
  async function visit(file,from) {
    assert.ok(publicFiles.has(file),`${from} depends on unpublished ${file}`);
    assert.ok(!/(?:^|\/)(?:server|specs|ops|fixtures)(?:\/|$)|(?:^|\/)games\/draw-and-guess\/rules\.mjs$|(?:^|\/)(?:.*-seed|.*-definition|adapter)\.mjs$/.test(file),`Private/core module reachable: ${file}`);
    if(visited.has(file))return;visited.add(file);
    const source=await readFile(path.join(root,file),'utf8');
    const imports=file.endsWith('.html')?[...source.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/giu)].map(match=>match[1]):moduleImports(source);
    for(const specifier of imports) {
      assert.ok(specifier.startsWith('./')||specifier.startsWith('../'),`Browser module ${file} has non-local dependency ${specifier}`);
      const target=path.posix.normalize(path.posix.join(path.posix.dirname(file),specifier));
      assert.ok(!target.startsWith('../'),`Browser dependency escapes app/: ${target}`);
      await visit(target,file);
    }
  }
  await visit(entry,'entry');return visited;
}
for(const entry of ['drawing.html','drawing-practice.html','words.html'])test(`${entry}: every static and literal dynamic module import is public, present and isolated from rules/answers`,async()=>{
  const visited=await publicModuleClosure(entry,new Set(publicAssetPaths()));
  assert.ok(visited.size>8,'Checks the real common dependencies, not only the entry script');
  if(entry==='drawing-practice.html')assert.ok(visited.has('games/draw-and-guess/practice-engine.mjs'));
});
test('practice dependency closure fails when its engine is omitted from the static asset contract',async()=>{
  const publicFiles=new Set(publicAssetPaths());publicFiles.delete('games/draw-and-guess/practice-engine.mjs');
  await assert.rejects(()=>publicModuleClosure('drawing-practice.html',publicFiles),/practice-page\.mjs depends on unpublished games\/draw-and-guess\/practice-engine\.mjs/);
});
