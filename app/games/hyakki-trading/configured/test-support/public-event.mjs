import assert from 'node:assert/strict';
import {history4EventProblem} from '../../public-history-v4.mjs';
const context={contentVersion:'yousei-content-v3',participantIds:['a','b','c','d','e','f'].map(x=>x.repeat(32))};
export const validateHyakkiPublicEvent=event=>assert.equal(history4EventProblem(event,context),null);
