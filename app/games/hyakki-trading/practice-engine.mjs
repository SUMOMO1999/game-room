import {createPracticeSession} from './practice-session.mjs';
import {configuredPracticeRuntime,decodeConfiguredPractice,encodeConfiguredPractice} from './configured/practice-runtime.mjs';
export {PRACTICE_SELF,PRACTICE_BOT,PRACTICE_BOTS,PRACTICE_STORAGE_KEY,PRACTICE_JOURNAL_MAX_BYTES,PRACTICE_SAVE_MAX_BYTES} from './practice-legacy.mjs';
export const decodeHyakkiPractice=decodeConfiguredPractice,encodeHyakkiPractice=encodeConfiguredPractice;
export const createHyakkiPracticeSession=options=>createPracticeSession(configuredPracticeRuntime,options);
