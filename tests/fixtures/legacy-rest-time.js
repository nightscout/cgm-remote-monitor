'use strict';

const DAY = 86400000;
// Capture once per suite. No clock mutation: servers retain their real wall clock.
function capture (now = Date.now()) {
  const date = new Date(now);
  const base = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - 1, 0, 0, 0, 123);
  const iso = (offset = 0) => new Date(base + offset).toISOString();
  return Object.freeze({ base, iso, day: (offset = 0) => iso(offset * DAY).slice(0, 10) });
}
module.exports = { capture, DAY };
