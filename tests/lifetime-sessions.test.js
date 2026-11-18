'use strict';
/* eslint-disable security/detect-non-literal-fs-filename -- Explicitly owned temporary configuration artifacts only. */
const assert = require('node:assert/strict');
const A = '11111111-1111-4111-8111-111111111111';
describe('explicit operation lease-session selection', function () {
  it('keeps unselected behavior and bounds selected lanes by the existing physical pool', function () {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-lifetime-config-')), file = path.join(directory, 'operation.json');
    const input = { version: 1, namespace: 'synthetic_control', connectionEnv: 'NS_SYNTHETIC_PG', locks: [{ tenant: A, key: '1' }] };
    const env = { MULTITENANT_OPERATION_CONFIG: file, NS_SYNTHETIC_PG: 'postgres://synthetic:synthetic@127.0.0.1/synthetic', NS_POOL_OPERATION_MAX: '4' };
    const parse = value => { fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); return require('../lib/server/serve/operation-cohort-config').load(env); };
    try {
      assert.equal(parse(input).leaseSessions, undefined);
      assert.equal(parse({ ...input, leaseSessions: 4 }).leaseSessions, 4);
      for (const bad of [0, -1, 1.5, '4', 5]) assert.throws(() => parse({ ...input, leaseSessions: bad }));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
