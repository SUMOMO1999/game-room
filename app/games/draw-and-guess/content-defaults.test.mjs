import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultDrawingCategoryIds} from './content-defaults.mjs';

test('legacy releases retain server defaults; explicit metadata wins without enabling disabled categories',()=>{
 const categories=['daily','home','screen','idiom-abstract','friends'].map(id=>({id,status:'active'}));
 assert.deepEqual(defaultDrawingCategoryIds(categories),['daily','home']);
 assert.deepEqual(defaultDrawingCategoryIds(categories,'my-pack'),categories.map(c=>c.id));
 const changed=categories.map(c=>({...c,defaultSelected:c.id!=='daily',...(c.id==='friends'?{status:'disabled'}:{})}));
 assert.deepEqual(defaultDrawingCategoryIds(changed),['home','screen','idiom-abstract']);
 assert.deepEqual(categories.map(c=>Object.hasOwn(c,'defaultSelected')),[false,false,false,false,false]);
});
