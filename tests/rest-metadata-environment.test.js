'use strict';
const assert = require('node:assert/strict');
const environment = require('../lib/server/tenant-app/environment');
const { forRequest } = require('../lib/server/tenant-app/presentation-environment');
describe('metadata configuration reuse', function () {
  it('reads settings afresh, shares only unchanged metadata configuration and propagates failure', async function () {
    let units = 'mg/dl', calls = 0, failed = false;
    const reader = { async read () { calls++; if (failed) throw Error('reader unavailable'); return { effective: { DISPLAY_UNITS: { value: units } } }; } };
    const env = environment(), metadataState = {};
    const options = { reader, env, tenant: 'a', domains: ['entries'], request: { method: 'GET', path: '/status' }, metadataState };
    const first = await forRequest(options);
    assert.equal(await forRequest(options), first);
    units = 'mmol';
    const next = await forRequest(options);
    assert.notEqual(next, first);
    assert.equal(next.settings.units, 'mmol');
    assert.notEqual(await forRequest({ ...options, metadataState: {} }), next, 'another tenant service has separate configuration');
    assert.notEqual(await forRequest({ ...options, metadataState: undefined }), next, 'derived contexts remain private');
    failed = true;
    await assert.rejects(forRequest(options), /reader unavailable/);
    assert.equal(calls, 6);
  });
});
