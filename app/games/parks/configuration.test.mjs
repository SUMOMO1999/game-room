import test from 'node:test';
import assert from 'node:assert/strict';
import { parksCreationConfiguration,DEFAULT_PARKS_CONFIGURATION } from './configuration.mjs';
test('creation defaults tolerate a cached old lobby while explicit choices remain typed and complete',()=>{
  assert.deepEqual(parksCreationConfiguration({getElementById:()=>null}),{parksConfig:{...DEFAULT_PARKS_CONFIGURATION}});
  const nodes={'create-parks-mode':{value:'solo'},'create-parks-camping':{checked:true},'create-parks-volunteers':{value:'4'},'create-parks-passion':{value:'choose'}};
  assert.deepEqual(parksCreationConfiguration({getElementById:id=>nodes[id]}),{parksConfig:{mode:'solo',camping:true,volunteerCount:4,passionChoice:'choose'}});
});
