'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const dates = require('../lib/server/srv-dates');
const scope = require('../lib/storage/tenant-scope');

describe('tenant-local server write clocks', function () {
  it('restores and advances only the bound tenant clock', async function () {
    const mode = scope.getTenancyMode();
    const first = randomUUID(), second = randomUUID();
    const future = Date.now() + 100000;
    scope.setTenancyMode('multi');
    try {
      await scope.withTenant(first, async () => {
        await dates.restoreResolved([{ async findFiltered () { return [{ srvModified: future }]; } }]);
        assert.equal(dates.next(), future + 1);
      });
      scope.withTenant(second, () => assert.ok(dates.next() < future));
      scope.withTenant(first, () => assert.equal(dates.next(), future + 2));
      assert.throws(() => dates.next(), /no tenant bound/);
    } finally { scope.setTenancyMode(mode); }
  });
});
