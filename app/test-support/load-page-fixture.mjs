import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

// Reuse each existing actual-page VM fixture without registering its test cases
// a second time or copying its DOM/transport implementation into a new suite.
export async function loadPageFixture(url){
  const source=await readFile(url,'utf8'),end=source.indexOf('\ntest(');
  assert(end>0,'The page fixture must be declared before its first test.');
  const prefix=source.slice(0,end)
    .replace(/\bfrom (['"])(\.[^'"]+)\1/g,(_all,_quote,path)=>'from '+JSON.stringify(new URL(path,url).href))
    .replaceAll('import.meta.url',JSON.stringify(url.href));
  return import('data:text/javascript;base64,'+Buffer.from(prefix+'\nexport {fixture};\n').toString('base64'));
}
