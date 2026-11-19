'use strict';

// The serving role's start check (lib/server/serve/role-readiness.js admit),
// for tests that replace the database with stubs. The real identity and
// ledger checks are covered by tests/role-readiness.integration.test.js.
const real = require('../../lib/server/serve/role-readiness');
module.exports = function admitted (calls, check = async () => {}) {
  return Object.freeze({ ...real,
    admit: async (_config, role) => { if (calls) calls.push('readiness-admit:' + role); await check(role); } });
};
