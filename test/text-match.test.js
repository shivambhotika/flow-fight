'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  countMatchedWords,
  isExactWordMatch,
  normalizeText,
  normalizeWords,
  shouldAdvanceOnEnter,
} = require('../public/text-match');

test('normalization ignores case punctuation and repeated whitespace', () => {
  assert.deepEqual(normalizeWords('  QUICK, wit... SLICK! steps  '), ['quick', 'wit', 'slick', 'steps']);
  assert.equal(normalizeText('Quick—WIT'), 'quick wit');
});

test('exact matching compares only the complete word sequence', () => {
  const target = 'Quick wit slick steps';
  assert.equal(isExactWordMatch(target, 'quick, WIT!!! slick... STEPS?'), true);
  assert.equal(isExactWordMatch(target, 'quick wit slick step'), false);
  assert.equal(isExactWordMatch(target, 'quick wit steps'), false);
  assert.equal(isExactWordMatch(target, 'quick extra wit slick steps'), false);
  assert.equal(isExactWordMatch(target, 'wit quick slick steps'), false);
});

test('partial scoring counts only correctly positioned normalized words', () => {
  assert.equal(countMatchedWords('Quick wit slick steps', 'QUICK, wrong slick! steps.'), 3);
  assert.equal(countMatchedWords('Quick wit slick steps', 'quick wit'), 2);
});

test('only Enter advances an exactly matched case-insensitive line', () => {
  const target = 'Quick wit slick steps';
  const accepted = 'QUICK, wit! Slick... STEPS?';
  assert.equal(shouldAdvanceOnEnter('Enter', target, accepted), true);
  assert.equal(shouldAdvanceOnEnter('Tab', target, accepted), false);
  assert.equal(shouldAdvanceOnEnter('s', target, accepted), false);
  assert.equal(shouldAdvanceOnEnter('Enter', target, 'quick wit slick'), false);
});
