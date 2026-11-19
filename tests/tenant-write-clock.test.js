'use strict';

// Multitenant history has transaction-owned cursors; single-tenant clocks remain local.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const dates = require('../lib/server/srv-dates');
const scope = require('../lib/storage/tenant-scope');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function requiresAllocator (implementation = dates) {
  for (const tenant of [A, B]) assert.throws(() => scope.withTenant(tenant, () => implementation.next()),
    error => error.code === 'TENANT_WRITE_CLOCK_REQUIRED', 'MULTITENANT_RAM_CLOCK_MUST_REFUSE');
}

describe('server history clock ownership', function () {
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));

  it('refuses a multitenant history stamp outside its database allocator', function () {
    requiresAllocator();
    assert.throws(() => dates.next(), /no tenant bound/);
  });

  it('uses the active transaction allocator without retaining tenant state', function () {
    for (const tenant of [A, B]) {
      let floor = 5000;
      const allocator = { tenant, active: true, next: now => { assert(Number.isFinite(now)); return ++floor; } };
      scope.withTenant(tenant, () => dates.withAllocator(allocator, () => {
        assert.equal(dates.next(), 5001);
        assert.equal(dates.next(), 5002);
      }));
    }
    requiresAllocator();
  });

  it('preserves single-tenant restart restoration and monotonic allocation', async function () {
    scope.setTenancyMode('single');
    const future = Date.now() + 10000;
    await dates.restore({ collection: () => ({ findOne: async () => ({ srvModified: future }) }) }, {});
    const first = dates.next();
    assert(first > future);
    assert.equal(dates.next(), first + 1);
  });

  it('red/restored: a RAM fallback violates the required allocator boundary', function () {
    const file = require.resolve('../lib/server/srv-dates');
    const source = fs.readFileSync(file, 'utf8');
    const needle = "throw Object.assign(new Error('Multitenant history writes require a database clock transaction'),\n      { code: 'TENANT_WRITE_CLOCK_REQUIRED' });";
    assert(source.includes(needle), 'CLOCK_CONTROL_MUST_REMOVE_ACTUAL_REFUSAL');
    const modified = source.replace(needle, 'return Date.now();');
    const result = { exports: {} };
    vm.runInThisContext('(function(require,module,exports){' + modified + '\n})', { filename: file })(createRequire(file), result, result.exports);
    assert.throws(() => requiresAllocator(result.exports), /MULTITENANT_RAM_CLOCK_MUST_REFUSE/);
    requiresAllocator();
  });
});
