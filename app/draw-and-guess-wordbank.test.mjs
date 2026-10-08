import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  drawAndGuessCharacterLength, normalizeDrawAndGuessAnswer, normalizeDrawAndGuessGuess,
  selectReviewedDrawAndGuessWords, validateDrawAndGuessDefinition, validateDrawAndGuessWordbank,
} from '../server/content/draw-and-guess-definition.mjs';
import {
  DRAW_AND_GUESS_CATEGORIES, DRAW_AND_GUESS_SEED, DRAW_AND_GUESS_SEED_METADATA,
} from '../server/content/draw-and-guess-seed.mjs';
import { publicAssetPaths } from '../server/public-assets.mjs';

const categories = DRAW_AND_GUESS_CATEGORIES;
const word = overrides => ({ id: 'dg-test-1', category: 'daily', answer: '纸船', aliases: [],
  difficulty: 'easy', language: 'zh', source: '虚构测试词', status: 'reviewed',
  definitionVersion: 1, hintLength: 2, tags: [], packId: 'dg-test', ...overrides });
const codes = result => result.errors.map(error => error.code);

test('frozen zh-exact-v1 vectors normalize width, ASCII case, Unicode spaces and edge punctuation', () => {
  for (const [input, expected] of [
    ['「　ＡＢＣ１２　！」', 'abc12'], ['哆啦 A 梦。', '哆啦a梦'],
    ['H\u00a0e\u2002l\u2003l\u3000o Kitty', 'hellokitty'],
    ['（ R2-D2 ）', 'r2-d2'], ['Cafe\u0301', 'café'], ['一，二', '一,二'],
    ['  !? ', ''], ['自行車', '自行車'],
  ]) assert.equal(normalizeDrawAndGuessGuess(input), expected, input);
  assert.notEqual(normalizeDrawAndGuessGuess('R2-D2'), normalizeDrawAndGuessGuess('R2D2'));
  assert.notEqual(normalizeDrawAndGuessGuess('自行車'), normalizeDrawAndGuessGuess('自行车'));
});

test('display NFC and hint use code points; explicitly different-length aliases keep the original hint', () => {
  assert.equal(normalizeDrawAndGuessAnswer('  Cafe\u0301　'), 'Café');
  assert.equal(drawAndGuessCharacterLength('Cafe\u0301'), 4);
  assert.equal(drawAndGuessCharacterLength('R2-D2'), 5);
  assert.equal(drawAndGuessCharacterLength('Hello Kitty'), 11);
  const panda = DRAW_AND_GUESS_SEED.find(entry => entry.answer === '熊猫');
  assert.equal(panda.hintLength, 2);
  assert.deepEqual(panda.aliases, ['大熊猫']);
  assert.equal(drawAndGuessCharacterLength(panda.aliases[0]), 3);
  assert.equal(validateDrawAndGuessDefinition(panda).length, 0);
  assert.ok(validateDrawAndGuessDefinition({ ...panda, hintLength: 3 }).some(error => error.code === 'hint-length'));
  const nonNfc = word({ answer: 'Cafe\u0301', hintLength: 4 });
  assert.ok(validateDrawAndGuessDefinition(nonNfc).some(error => error.code === 'display-normalization'));
});

test('matching is exact to explicit aliases and never accepts substrings, pinyin or unlisted traditional forms', () => {
  const bicycle = DRAW_AND_GUESS_SEED.find(entry => entry.answer === '自行车');
  const accepted = new Set([bicycle.answer, ...bicycle.aliases].map(normalizeDrawAndGuessGuess));
  assert.equal(accepted.has(normalizeDrawAndGuessGuess('「脚 踏 車」')), false);
  for (const guess of ['自行车', '自行車', '脚踏车', '（自行车！）']) assert.ok(accepted.has(normalizeDrawAndGuessGuess(guess)), guess);
  for (const guess of ['车', '单车', 'zixingche', '这是自行车', '自行车宝宝', '腳踏車']) {
    assert.equal(accepted.has(normalizeDrawAndGuessGuess(guess)), false, guess);
  }
});

test('content and guesses reject invisible, bidi, broken, multiline and HTML characters before matching', () => {
  for (const invalid of ['纸\u200b船', '纸\u2060船', '纸\u034f船', '纸\ufe0f船',
    '纸\u202e船', '纸\u0000船', '纸\n船', '纸\r船', '纸\t船', '纸\u2028船',
    '纸\ud800船', '纸\ue000船', '纸\u2800船', '纸\u0301船', '\u0301',
    '<img src=x>', '<script>', '＜script＞', '﹤img﹥']) {
    assert.throws(() => normalizeDrawAndGuessAnswer(invalid), undefined, JSON.stringify(invalid));
    assert.throws(() => normalizeDrawAndGuessGuess(invalid), undefined, JSON.stringify(invalid));
    assert.ok(validateDrawAndGuessDefinition(word({ answer: invalid })).some(error => error.code === 'text-invalid'));
  }
  assert.equal(normalizeDrawAndGuessAnswer('纸　船'), '纸 船');
  assert.equal(normalizeDrawAndGuessGuess('纸　船'), '纸船');
});

test('answer and every alias have independent character, byte, count and nonempty-match limits', () => {
  assert.equal(normalizeDrawAndGuessAnswer('字'.repeat(32)).length, 32);
  assert.throws(() => normalizeDrawAndGuessAnswer('字'.repeat(33)), RangeError);
  assert.equal(normalizeDrawAndGuessGuess('字'.repeat(64)).length, 64);
  assert.throws(() => normalizeDrawAndGuessGuess('字'.repeat(65)), RangeError);
  assert.throws(() => normalizeDrawAndGuessGuess('𠮷'.repeat(65)), RangeError);
  assert.throws(() => normalizeDrawAndGuessAnswer('𠮷'.repeat(33)), RangeError);
  // NFD Hangul remains within the NFC character cap while exceeding the raw
  // byte cap. This verifies bytes independently of the character limit.
  assert.throws(() => normalizeDrawAndGuessAnswer('\u1100\u1161'.repeat(22)), RangeError);
  assert.throws(() => normalizeDrawAndGuessGuess('\u1100\u1161'.repeat(44)), RangeError);
  assert.equal(validateDrawAndGuessDefinition(word({ aliases: ['字'.repeat(32)] })).length, 0);
  for (const aliases of [['字'.repeat(33)], ['\u200b'], ['...'], Array.from({ length: 9 }, (_, index) => `别名${index}`)]) {
    assert.ok(validateDrawAndGuessDefinition(word({ aliases })).length > 0, JSON.stringify(aliases));
  }
  assert.ok(validateDrawAndGuessDefinition(word({ aliases: ['纸 船'] })).some(error => error.code === 'alias-redundant'));
  assert.equal(validateDrawAndGuessDefinition(word({ aliases: ['折纸小船'] })).length, 0);
});

test('cross-pack answer/alias collisions provide both conflicting IDs and paths instead of silently dropping rows', () => {
  const first = word({ id: 'dg-test-panda', answer: '熊猫', aliases: ['大熊猫'] });
  const second = word({ id: 'dg-other-panda', packId: 'dg-other', answer: '大 熊 猫', hintLength: 5 });
  const report = validateDrawAndGuessWordbank([first, second], { categories });
  const collision = report.errors.find(error => error.code === 'term-ambiguous');
  assert.equal(report.valid, false);
  assert.equal(collision.wordId, 'dg-other-panda');
  assert.equal(collision.otherWordId, 'dg-test-panda');
  assert.equal(collision.path, 'words[1].answer');
  assert.equal(collision.otherPath, 'words[0].aliases[0]');
  const width = validateDrawAndGuessWordbank([
    word({ answer: 'Ａ', hintLength: 1 }), word({ id: 'dg-test-2', answer: 'a', hintLength: 1 }),
  ], { categories });
  assert.ok(codes(width).includes('term-ambiguous'));
  const duplicateId = validateDrawAndGuessWordbank([first, { ...first, answer: '白熊', aliases: [] }], { categories });
  assert.ok(codes(duplicateId).includes('id-duplicate'));
});

test('retired and draft terms never enter new selections, disabled or unselected categories and packs stay excluded', () => {
  const active = word();
  const draft = word({ id: 'dg-test-draft', answer: '草稿', status: 'draft' });
  const retired = word({ id: 'dg-test-retired', status: 'retired' });
  const other = word({ id: 'dg-test-other', answer: '纸花', category: 'friends', packId: 'dg-private' });
  const words = [active, draft, retired, other];
  assert.equal(validateDrawAndGuessWordbank([active, retired], { categories }).valid, true);
  assert.deepEqual(selectReviewedDrawAndGuessWords(words, { categories, categoryIds: ['daily'],
    difficulties: ['easy'], packIds: ['dg-test'] }), [active]);
  assert.deepEqual(selectReviewedDrawAndGuessWords(words, { categories: categories.map(category =>
    category.id === 'daily' ? { ...category, status: 'disabled' } : category), categoryIds: ['daily'] }), []);
  assert.deepEqual(selectReviewedDrawAndGuessWords(words, { categoryIds: [] }), []);
  assert.deepEqual(selectReviewedDrawAndGuessWords(words, { difficulties: ['hard'] }), []);
  assert.deepEqual(selectReviewedDrawAndGuessWords(words, { packIds: [] }), []);
});

test('first seed covers all seven 80-word categories and the default pool without counting friends', () => {
  const report = validateDrawAndGuessWordbank(DRAW_AND_GUESS_SEED, { categories, requireBaseMinimums: true });
  assert.equal(report.valid, true, JSON.stringify(report.errors));
  assert.equal(report.stats.total, 560);
  assert.equal(report.stats.reviewed, 560);
  assert.equal(DRAW_AND_GUESS_SEED.filter(entry => entry.category === 'friends').length, 0);
  for (const id of ['daily', 'nature', 'food', 'action-job', 'place-transport', 'screen', 'idiom-abstract']) {
    assert.equal(report.stats.byCategory[id].total, 80, id);
  }
  for (const id of ['daily', 'nature', 'food', 'action-job', 'place-transport']) {
    const selected = selectReviewedDrawAndGuessWords(DRAW_AND_GUESS_SEED, { categoryIds: [id], difficulties: ['easy', 'normal'] });
    assert.ok(selected.length >= 64, id);
    assert.ok(selected.length >= 8 * 2 * 3, `${id} must supply eight players with two turns and three candidates`);
  }
  assert.equal(report.stats.byCategory.screen.easy, 0);
  assert.equal(report.stats.byCategory['idiom-abstract'].easy, 0);
  const short = validateDrawAndGuessWordbank(DRAW_AND_GUESS_SEED.slice(1), { categories, requireBaseMinimums: true });
  assert.ok(codes(short).includes('base-category-minimum'));
  assert.ok(codes(short).includes('base-total-minimum'));
  const falseFill = [...DRAW_AND_GUESS_SEED.slice(1), word({ category: 'friends' })];
  assert.ok(codes(validateDrawAndGuessWordbank(falseFill, { categories, requireBaseMinimums: true })).includes('base-total-minimum'));
});

test('unknown categories, invalid versions and malformed payloads fail with usable field diagnostics', () => {
  assert.equal(validateDrawAndGuessWordbank(null, { categories }).valid, false);
  assert.equal(validateDrawAndGuessWordbank([word()]).valid, false);
  const malformed = validateDrawAndGuessWordbank([word({ category: 'missing', definitionVersion: 0,
    difficulty: 'unknown', language: 'ja', status: 'unapproved', tags: Array(9).fill('标签') })], { categories });
  for (const code of ['category-missing', 'definition-version', 'difficulty', 'language', 'status', 'tags-limit']) {
    assert.ok(codes(malformed).includes(code), code);
  }
  const dynamicCategories = [...categories, { id: 'new-category', name: '新增分类', status: 'active' }];
  assert.equal(validateDrawAndGuessWordbank([word({ category: 'new-category' })], { categories: dynamicCategories }).valid, true);
  const dangerousName = validateDrawAndGuessWordbank([word({ category: 'constructor' })], { categories });
  assert.equal(dangerousName.valid, false);
  assert.equal(dangerousName.stats.byCategory.constructor.total, 1);
  assert.equal(Object.total, undefined);
});

test('seed is immutable editorial material with maintenance-only cues and 21 representative basic words', () => {
  assert.equal(DRAW_AND_GUESS_SEED_METADATA.releasePublished, false);
  assert.equal(DRAW_AND_GUESS_SEED_METADATA.trialDrawingVerified, false);
  assert.equal(DRAW_AND_GUESS_SEED_METADATA.drawingCueAudience, 'content-maintenance-only');
  assert.ok(Object.isFrozen(DRAW_AND_GUESS_SEED));
  for (const entry of DRAW_AND_GUESS_SEED) {
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.aliases));
    assert.ok(Object.isFrozen(entry.tags));
    assert.ok(entry.drawingCue.length > 4, entry.id);
  }
  const representatives = DRAW_AND_GUESS_SEED_METADATA.step0RepresentativeIds
    .map(id => DRAW_AND_GUESS_SEED.find(entry => entry.id === id));
  assert.equal(representatives.length, 21);
  assert.ok(representatives.every(Boolean));
  for (const id of ['daily', 'nature', 'food', 'action-job', 'place-transport', 'screen', 'idiom-abstract']) {
    assert.equal(representatives.filter(entry => entry.category === id).length, 3);
  }
  assert.ok(representatives.some(entry => entry.aliases.some(alias => drawAndGuessCharacterLength(alias) !== entry.hintLength)));
  assert.ok(representatives.some(entry => /[A-Za-z]/.test(entry.answer) && /\d/.test(entry.answer)));
  assert.ok(representatives.some(entry => entry.aliases.includes('自行車')));
  assert.equal(Math.max(...representatives.map(entry => entry.hintLength)), Math.max(...DRAW_AND_GUESS_SEED.map(entry => entry.hintLength)));
});

test('production public asset contract has no seed, definition module or content library import', () => {
  const assets = publicAssetPaths();
  assert.equal(assets.some(path => /(?:server\/content\/|draw-and-guess-seed)/u.test(path)), false);
  for (const asset of assets.filter(path => /\.(mjs|js|html)$/.test(path))) {
    const source = readFileSync(new URL(`./${asset}`, import.meta.url), 'utf8');
    assert.equal(/(?:server\/content\/|draw-and-guess-seed|DRAW_AND_GUESS_SEED)/u.test(source), false, asset);
  }
});
