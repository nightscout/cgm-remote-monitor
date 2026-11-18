'use strict';

// The proof used by the evaluator and restore operator identifies the
// suppression and outbox bindings that admin actually checked at pre-start.
const assert = require('node:assert/strict');
const platform = require('../lib/server/serve/platform-verification');

describe('evaluator consumer pre-start proof binding', function () {
  const address = role => new URL('postgres://' + role + '@synthetic.invalid/db');
  function config () {
    return {
      namespaces: { clock: 'fixture_clock', checkpoint: 'fixture_realtime' }, completedOutput: { namespace: 'fixture_output' },
      connectionString: address('clinical').toString(), consumers: { realtime: {
        outbox: { namespace: 'fixture_outbox', connectionString: address('outbox').toString() },
        suppression: { namespace: 'fixture_alarm', connectionString: address('reader').toString() }
      } }
    };
  }
  it('changes when a checked consumer namespace, role, database or selected catalogue changes', function () {
    const baseline = platform.contract(config(), 'evaluator');
    for (const change of [
      value => { value.suppression.namespace = 'another_alarm'; },
      value => { value.outbox.namespace = 'another_outbox'; },
      value => { value.suppression.connectionString = address('another_reader').toString(); },
      value => { const url = address('outbox'); url.pathname = '/another_database'; value.outbox.connectionString = url.toString(); },
      value => { value.expectedCatalogue = { version: 1, migrations: [] }; }
    ]) {
      const selected = config();
      change(selected.consumers.realtime);
      assert.notEqual(platform.contract(selected, 'evaluator'), baseline);
    }
  });
  it('carries only the non-secret bindings needed by the restore operator', function () {
    const selected = config();
    const reader = address('reader');
    reader.password = 'synthetic-private-value';
    selected.consumers.realtime.suppression.connectionString = reader.toString();
    const inputs = JSON.parse(JSON.stringify(platform.contractInputs(selected, 'evaluator')));
    assert(!JSON.stringify(inputs).includes(reader.password));
    assert.equal(platform.contractFromInputs(inputs, 'evaluator'), platform.contract(selected, 'evaluator'));
    inputs.selection.operationProfileDigest = 'a'.repeat(64);
    assert.equal(platform.contractFromInputs(inputs, 'evaluator'), platform.contract(selected, 'evaluator'));
    const current = 'b'.repeat(64);
    assert.equal(platform.contractFromInputs(inputs, 'evaluator', current), platform.contract(selected, 'evaluator', current));
    assert.notEqual(platform.contractFromInputs(inputs, 'evaluator', current), platform.contract(selected, 'evaluator', inputs.selection.operationProfileDigest));
    assert.throws(() => platform.contractFromInputs(inputs, 'evaluator', 'invalid'), { code: 'PLATFORM_VERIFICATION_CONFIG' });
  });
});
