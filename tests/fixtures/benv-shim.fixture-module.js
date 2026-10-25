'use strict';
// Fixture loaded by benv-shim.test.js to verify rewire-style top-level
// execution writes to the jsdom window provided by the shim.
if (typeof window !== 'undefined') {
  window.SHIMTEST = 'ok';
}
module.exports = { ok: true };
