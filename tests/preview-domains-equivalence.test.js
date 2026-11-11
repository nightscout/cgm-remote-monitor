'use strict';

// covers: lib/server/serve/preview-domains.js, lib/server/tenant-app/environment.js

// Clinical equivalence of per-tenant domain construction (decision
// readiness-serve-then-warm). Each tenant's domains are now built by its own warm
// instead of before the listener opens. For five tenants with different
// settings, the constructed environment, v1/v2/v3 app settings (feature
// enablement), collections and storage ports must equal the golden fingerprint
// captured from the construction at 540d3998 (base code plus a read-only
// describeTenant accessor; tests/fixtures/preview-domains-equivalence.golden.json).
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { fingerprints, TENANTS } = require('./fixtures/preview-domains-equivalence');
const golden = require('./fixtures/preview-domains-equivalence.golden.json');

function loadMutated (mutate) {
  const file = path.resolve(__dirname, '../lib/server/serve/preview-domains.js'), output = { exports: {} };
  const source = fs.readFileSync(file, 'utf8'), changed = mutate(source);
  assert.notEqual(changed, source, 'the mutation applies');
  vm.runInThisContext('(function(require,module,exports){' + changed + '\n})', { filename: file })(createRequire(file), output, output.exports);
  return output.exports;
}
const quiet = async fn => {
  const info = console.info, log = console.log; console.info = () => {}; console.log = () => {};
  try { return await fn(); } finally { console.info = info; console.log = log; }
};

describe('per-tenant domain construction is clinically equivalent (decision readiness-serve-then-warm)', function () {
  it('builds each tenant\'s environment and feature enablement exactly as before', async function () {
    const actual = await quiet(() => fingerprints(require('../lib/server/serve/preview-domains')));
    assert.deepEqual(Object.keys(actual), TENANTS.map(([tenant]) => tenant));
    for (const [tenant] of TENANTS) assert.deepEqual(actual[tenant], golden[tenant], tenant);
    assert.equal(new Set(Object.values(actual).map(row => JSON.stringify(row.env))).size, TENANTS.length, 'the fixture tenants differ');
  });
  it('control: a construction that gives every tenant the first tenant\'s environment is caught', async function () {
    const mutated = loadMutated(s => s.replace('const env = config.environments.get(tenant);', 'const env = config.environments.get([...config.bindings.keys()][0]);'));
    const actual = await quiet(() => fingerprints(mutated));
    assert.notDeepEqual(actual[TENANTS[2][0]], golden[TENANTS[2][0]]);
  });
  it('control: a construction that drops the per-domain collection names is caught', async function () {
    const mutated = loadMutated(s => s.replace("env[logical + '_collection'] = logical;", ''));
    await assert.rejects(quiet(() => fingerprints(mutated)).then(actual => assert.deepEqual(actual, golden)));
  });
});
