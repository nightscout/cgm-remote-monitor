'use strict';

const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const { main } = require('../tools/import-entries');

describe('one-time entries import command', function () {
  it('requires explicit source, scoped token, target, tenant and schema settings', async function () {
    await assert.rejects(main({}), /requires source, token, target and tenant environment/);
  });

  it('validates the source origin before changing the process tenancy mode', async function () {
    const previous = scope.getTenancyMode();
    scope.setTenancyMode('single');
    try {
      await assert.rejects(main({
        NS_SOURCE_URL: 'http://source.example.org',
        NS_SOURCE_READ_TOKEN: 'read-token',
        NS_TARGET_POSTGRES_URL: 'postgres://operator:password@localhost/target',
        NS_TARGET_POSTGRES_NAMESPACE: 'tenant_data',
        NS_IMPORT_TENANT_ID: '11111111-1111-4111-8111-111111111111'
      }), /HTTPS origin/);
      assert.equal(scope.getTenancyMode(), 'single');
    } finally {
      scope.setTenancyMode(previous);
    }
  });
});
