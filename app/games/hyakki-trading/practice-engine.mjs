import {EXPANSION_TWO_PACK_ID} from './content/expansion-two.mjs';
import {expansionTwoMode} from './expansion-two-mode.mjs';
import {createPracticeSession} from './practice-session.mjs';
import {configuredPracticeRuntime,decodeConfiguredPractice,encodeConfiguredPractice} from './configured/practice-runtime.mjs';
export {PRACTICE_SELF,PRACTICE_BOT,PRACTICE_BOTS,PRACTICE_STORAGE_KEY,PRACTICE_JOURNAL_MAX_BYTES,PRACTICE_SAVE_MAX_BYTES} from './practice-legacy.mjs';
export const decodeHyakkiPractice=decodeConfiguredPractice,encodeHyakkiPractice=encodeConfiguredPractice;
const runtime=expansionTwoMode==='resume-only'?{
  ...configuredPracticeRuntime,
  fresh(options){
    if(options.packId===EXPANSION_TWO_PACK_ID)throw new Error('商路风云暂只可续玩已有练习。');
    return configuredPracticeRuntime.fresh(options);
  },
}:configuredPracticeRuntime;
export const createHyakkiPracticeSession=options=>createPracticeSession(runtime,options);
