'use strict';

(function exposeTextMatch(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FlowFightTextMatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function normalizeWords(value) {
    const normalized = String(value || '')
      .normalize('NFKC')
      .toLocaleLowerCase('en-US');

    return normalized.match(/[\p{L}\p{N}]+/gu) || [];
  }

  function normalizeText(value) {
    return normalizeWords(value).join(' ');
  }

  function isExactWordMatch(targetText, enteredText) {
    const targetWords = normalizeWords(targetText);
    const enteredWords = normalizeWords(enteredText);
    return targetWords.length > 0 &&
      targetWords.length === enteredWords.length &&
      targetWords.every((word, index) => word === enteredWords[index]);
  }

  function countMatchedWords(targetText, enteredText) {
    const targetWords = normalizeWords(targetText);
    const enteredWords = normalizeWords(enteredText);
    let matched = 0;
    for (let index = 0; index < Math.min(targetWords.length, enteredWords.length); index += 1) {
      if (targetWords[index] === enteredWords[index]) matched += 1;
    }
    return matched;
  }

  function shouldAdvanceOnEnter(key, targetText, enteredText) {
    return key === 'Enter' && isExactWordMatch(targetText, enteredText);
  }

  function sanitizeVoiceText(value) {
    return String(value || '')
      .replace(/\p{P}+/gu, ' ')
      .replace(/[^\S\r\n]+/g, ' ');
  }

  function sanitizeVoiceSelection(value, selectionStart, selectionEnd = selectionStart) {
    const source = String(value || '');
    const text = sanitizeVoiceText(source);
    const mapPosition = position => Math.min(
      text.length,
      sanitizeVoiceText(source.slice(0, Math.max(0, Number(position) || 0))).length,
    );

    return {
      text,
      selectionStart: mapPosition(selectionStart),
      selectionEnd: mapPosition(selectionEnd),
    };
  }

  return Object.freeze({
    countMatchedWords,
    isExactWordMatch,
    normalizeText,
    normalizeWords,
    sanitizeVoiceSelection,
    sanitizeVoiceText,
    shouldAdvanceOnEnter,
  });
});
