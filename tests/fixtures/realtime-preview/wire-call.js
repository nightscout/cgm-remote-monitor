'use strict';
const { isDeepStrictEqual } = require('node:util');
// Mirror JSON wire isolation before invoking an in-process canonical handler.
// Do not alter the caller's retry packet or inject a timestamp into it.
module.exports = async function wireCall (producer, invoke, now = Date.now) {
  const original = structuredClone(producer), window = { startedAt: now() }; let result, error;
  try { result = await invoke(structuredClone(producer)); } catch (failure) { error = failure; }
  window.finishedAt = now();
  return { result, error, window, producerUnchanged: isDeepStrictEqual(producer, original) };
};
