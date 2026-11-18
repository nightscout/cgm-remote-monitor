'use strict';

// The serving role's one platform check (platform-verification admit), for
// tests that replace the database with stubs. The admin pre-start step and the
// real proof check are covered by tests/platform-verification.test.js.
const real = require('../../lib/server/serve/platform-verification');
// Fake operation windows carry no intake profile digest to bind.
module.exports = function admitted (calls, check = async () => {}) {
  return Object.freeze({ ...real, operationProfileDigest: () => undefined,
    admit: async (_config, role) => { if (calls) calls.push('platform-admit:' + role); await check(role); return Object.freeze({ role }); } });
};
