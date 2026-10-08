// Content contracts only. This module owns no room, account or publication state.
import { DRAW_AND_GUESS_MATCHER_VERSION, drawAndGuessCharacterLength,
  checkDrawAndGuessText as checkText, normalizeDrawAndGuessAnswer, normalizeDrawAndGuessGuess
} from '../../app/games/draw-and-guess/matcher.mjs';
export { DRAW_AND_GUESS_MATCHER_VERSION, drawAndGuessCharacterLength,
  normalizeDrawAndGuessAnswer, normalizeDrawAndGuessGuess };
export const DRAW_AND_GUESS_DEFINITION_VERSION = 1;
export const DRAW_AND_GUESS_BASE_CATEGORY_IDS = Object.freeze([
  'daily', 'nature', 'food', 'action-job', 'place-transport', 'screen', 'idiom-abstract',
]);
export const DRAW_AND_GUESS_LIMITS = Object.freeze({
  answerCharacters: 32, answerBytes: 128, aliases: 8, tags: 8,
  guessCharacters: 64, guessBytes: 256,
});

const difficulties = new Set(['easy', 'normal', 'hard']);
const statuses = new Set(['draft', 'reviewed', 'retired']);
const identifier = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function diagnostic(code, path, message, wordId, extra = {}) {
  return { code, path, message, ...(typeof wordId === 'string' ? { wordId } : {}), ...extra };
}

export function validateDrawAndGuessDefinition(word, { categoryIds, path = 'word' } = {}) {
  const errors = [];
  const add = (code, field, message) => errors.push(diagnostic(code, `${path}.${field}`, message, word?.id));
  if (!word || typeof word !== 'object' || Array.isArray(word)) {
    return [diagnostic('word-type', path, '词条必须是对象。')];
  }
  for (const field of ['id', 'packId', 'category']) {
    if (typeof word[field] !== 'string' || word[field].length > 80 || !identifier.test(word[field])) {
      add('identifier', field, '编号须为 1～80 位小写字母、数字和单个连字符。');
    }
  }
  if (categoryIds && !categoryIds.has(word.category)) add('category-missing', 'category', '主分类不存在。');
  if (!difficulties.has(word.difficulty)) add('difficulty', 'difficulty', '难度须为 easy、normal 或 hard。');
  if (!statuses.has(word.status)) add('status', 'status', '状态须为 draft、reviewed 或 retired。');
  if (word.language !== 'zh') add('language', 'language', '当前定义仅支持 zh；新增语言须扩展合同。');
  if (!Number.isSafeInteger(word.definitionVersion) || word.definitionVersion < 1) {
    add('definition-version', 'definitionVersion', '定义版本须为正安全整数。');
  }
  function inspect(value, field) {
    try {
      const display = normalizeDrawAndGuessAnswer(value);
      if (display !== value) add('display-normalization', field, '先预览并保存 NFC 单行规范化文字。');
      if (!normalizeDrawAndGuessGuess(display)) add('empty-match', field, '判词规范化后不能为空。');
      return display;
    } catch (error) {
      add('text-invalid', field, error.message);
      return null;
    }
  }
  const answer = inspect(word.answer, 'answer');
  if (answer !== null && word.hintLength !== drawAndGuessCharacterLength(answer)) {
    add('hint-length', 'hintLength', '字数须等于正文 NFC 后的 Unicode 码点数；别名不改变提示。');
  }
  if (!Array.isArray(word.aliases) || word.aliases.length > 8) {
    add('aliases-limit', 'aliases', '别名须为至多 8 个字符串的数组。');
  } else {
    const terms = new Set();
    if (answer !== null) terms.add(normalizeDrawAndGuessGuess(answer));
    word.aliases.forEach((alias, index) => {
      const display = inspect(alias, `aliases[${index}]`);
      if (display === null) return;
      const term = normalizeDrawAndGuessGuess(display);
      if (terms.has(term)) add('alias-redundant', `aliases[${index}]`, '别名与本条正文或其他别名判词相同。');
      terms.add(term);
    });
  }
  if (!Array.isArray(word.tags) || word.tags.length > 8) {
    add('tags-limit', 'tags', '维护标签须为至多 8 个字符串的数组。');
  } else {
    const seen = new Set();
    word.tags.forEach((tag, index) => {
      const display = inspect(tag, `tags[${index}]`);
      if (display !== null && seen.has(display)) add('tag-redundant', `tags[${index}]`, '维护标签重复。');
      seen.add(display);
    });
  }
  try {
    checkText(word.source, { maxCharacters: 160, maxBytes: 640 });
    if (word.source !== word.source.normalize('NFC').trim()) add('source-normalization', 'source', '来源须为 NFC 单行文字。');
  } catch (error) { add('source-invalid', 'source', error.message); }
  return errors;
}

export function summarizeDrawAndGuessWordbank(words) {
  const stats = { total: words.length, reviewed: 0, draft: 0, retired: 0,
    byDifficulty: { easy: 0, normal: 0, hard: 0 }, byCategory: Object.create(null) };
  for (const word of words) {
    if (!word || typeof word !== 'object' || Array.isArray(word)) continue;
    if (statuses.has(word.status)) stats[word.status]++;
    if (difficulties.has(word.difficulty)) stats.byDifficulty[word.difficulty]++;
    if (typeof word.category !== 'string') continue;
    const category = stats.byCategory[word.category] ||= { total: 0, reviewed: 0, easy: 0, normal: 0, hard: 0 };
    category.total++;
    if (word.status === 'reviewed') category.reviewed++;
    if (difficulties.has(word.difficulty)) category[word.difficulty]++;
  }
  return stats;
}

// Include every selected pack in the same call to detect cross-pack ambiguity.
// Retired definitions retain their history but do not block future active terms.
export function validateDrawAndGuessWordbank(words, { categories = [], requireBaseMinimums = false,
  baseCategoryIds = DRAW_AND_GUESS_BASE_CATEGORY_IDS } = {}) {
  if (!Array.isArray(words)) {
    return { valid: false, errors: [diagnostic('words-type', 'words', '词库须为数组。')], stats: null };
  }
  const errors = [], categoryIds = new Set(), ids = new Set(), terms = new Map();
  if (!Array.isArray(categories) || !categories.length) errors.push(diagnostic('categories-required', 'categories', '须提供分类目录。'));
  if (Array.isArray(categories)) categories.forEach((category, index) => {
    if (!category || typeof category.id !== 'string' || !identifier.test(category.id) || category.id.length > 80) {
      errors.push(diagnostic('category-id', `categories[${index}].id`, '分类编号格式无效。'));
      return;
    }
    if (categoryIds.has(category.id)) errors.push(diagnostic('category-duplicate', `categories[${index}].id`, '分类编号重复。'));
    categoryIds.add(category.id);
    try { normalizeDrawAndGuessAnswer(category.name); }
    catch (error) { errors.push(diagnostic('category-name', `categories[${index}].name`, error.message)); }
    if (!['active', 'disabled'].includes(category.status)) errors.push(diagnostic('category-status', `categories[${index}].status`, '分类状态须为 active 或 disabled。'));
  });
  words.forEach((word, index) => {
    const wordErrors = validateDrawAndGuessDefinition(word, { categoryIds, path: `words[${index}]` });
    errors.push(...wordErrors);
    if (!word || typeof word !== 'object' || Array.isArray(word)) return;
    if (ids.has(word.id)) errors.push(diagnostic('id-duplicate', `words[${index}].id`, '稳定编号重复。', word.id));
    ids.add(word.id);
    if (word.status === 'retired') return;
    const candidates = [['answer', word.answer], ...(Array.isArray(word.aliases)
      ? word.aliases.map((alias, i) => [`aliases[${i}]`, alias]) : [])];
    for (const [field, value] of candidates) {
      try {
        normalizeDrawAndGuessAnswer(value);
        const term = normalizeDrawAndGuessGuess(value);
        if (!term) continue;
        const existing = terms.get(term);
        if (existing && existing.index !== index) {
          errors.push(diagnostic('term-ambiguous', `words[${index}].${field}`,
            `判词与 ${existing.wordId} 的正文或别名重合，请合并概念或修正认可别名。`, word.id,
            { otherWordId: existing.wordId, otherPath: existing.path }));
        } else terms.set(term, { index, wordId: word.id, path: `words[${index}].${field}` });
      } catch { /* Definition diagnostics above retain the exact field. */ }
    }
  });
  const stats = summarizeDrawAndGuessWordbank(words);
  if (requireBaseMinimums) {
    let baseReviewed = 0;
    for (const [index, categoryId] of baseCategoryIds.entries()) {
      const selected = words.filter(word => word?.category === categoryId && word.status === 'reviewed');
      baseReviewed += selected.length;
      if (selected.length < 80) errors.push(diagnostic('base-category-minimum', `categories.${categoryId}`, '基础分类须至少 80 条 reviewed 词。'));
      if (index < 5 && selected.filter(word => ['easy', 'normal'].includes(word.difficulty)).length < 64) {
        errors.push(diagnostic('base-default-minimum', `categories.${categoryId}`, '默认前五类简单加普通须至少 64 条。'));
      }
    }
    if (baseReviewed < 560) errors.push(diagnostic('base-total-minimum', 'words', '七个基础分类须合计至少 560 条 reviewed 词；朋友词不计入。'));
  }
  return { valid: errors.length === 0, errors, stats };
}

// Filtering only: validate the complete combined library before sampling a room.
// This deliberately has no candidate sampler or public answer projection.
export function selectReviewedDrawAndGuessWords(words, { categories, categoryIds, difficulties: selectedDifficulties, packIds } = {}) {
  const activeCategoryIds = categories ? new Set(categories.filter(category => category.status === 'active').map(category => category.id)) : null;
  const selectedCategories = categoryIds ? new Set(categoryIds) : null;
  const difficultySet = selectedDifficulties ? new Set(selectedDifficulties) : null;
  const packSet = packIds ? new Set(packIds) : null;
  return words.filter(word => word.status === 'reviewed'
    && (!activeCategoryIds || activeCategoryIds.has(word.category))
    && (!selectedCategories || selectedCategories.has(word.category))
    && (!difficultySet || difficultySet.has(word.difficulty))
    && (!packSet || packSet.has(word.packId)));
}
