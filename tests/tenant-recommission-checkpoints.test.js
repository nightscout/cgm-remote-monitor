'use strict';
// Actual replay descriptor constructor; recording insert/provision boundary only.
const assert = require('node:assert/strict');
const checkpoint = require('../lib/tenant-lifecycle/recommission-checkpoints');
const profiles = require('../lib/pgstream/pool-intake-profile');
const replay = require('../lib/storage/postgres-durable-replay');
const profile = profiles.create({ namespace: 'synthetic_checkpoint', membershipNamespace: 'synthetic_membership', lifecycleNamespace: 'synthetic_control', role: 'synthetic_intake', operatorRole: 'synthetic_operator', consumer: 'evaluator-synthetic', codec: profiles.CODEC, generationDomain: profiles.GENERATION_DOMAIN, sliceRule: require('../lib/pool-membership/slice').RULE });
const configuration = { checkpointTable: 'synthetic_checkpoint.tenant_consumer_checkpoint', clockTable: 'synthetic_clock.tenant_write_clock', consumer: profile.binding.consumer,
  domains: { entries: 'synthetic_entries.entries' }, projectionVersion: 'clinical-current-rows-v1', pageSize: 20, maxRows: 200 };
const input = { intakeProfile: profile, replays: [configuration], namespaces: { checkpoint: 'synthetic_checkpoint', entries: 'synthetic_entries', clock: 'synthetic_clock' },
  catalogues: [{ kind: 'checkpoint', tables: ['tenant_consumer_checkpoint'] }, { kind: 'entries', tables: ['entries'] }, { kind: 'clock', tables: ['tenant_write_clock'] }] };
describe('current recommission checkpoint descriptors', function () {
  it('uses the actual current replay factory digest with no artifact or data read', function () {
    const expected = replay({ ...configuration, connection: { query () { throw new Error('No I/O'); }, snapshotTransaction () { throw new Error('No I/O'); } } });
    const described = checkpoint.describe(input);
    assert.deepEqual(described.rows, [{ namespace: 'synthetic_checkpoint', consumer: profile.binding.consumer, digest: expected.digest }]);
    assert(Object.isFrozen(described)); assert(Object.isFrozen(described.rows[0]));
    const changed = checkpoint.describe({ ...input, replays: [{ ...configuration, projectionVersion: 'current-other-contract' }] });
    assert.notEqual(changed.rows[0].digest, described.rows[0].digest);
  });
  it('refuses unconfigured, foreign, completed-output and incomplete namespace descriptors', function () {
    for (const replays of [[], [configuration, configuration], [{ ...configuration, consumer: profile.binding.consumer + '-completed' }],
      [{ ...configuration, clockTable: 'foreign_clock.tenant_write_clock' }], [{ ...configuration, domains: { entries: 'foreign_entries.entries' } }],
      [{ ...configuration, digest: 'a'.repeat(64) }]]) assert.throws(() => checkpoint.describe({ ...input, replays }));
    assert.throws(() => checkpoint.describe({ ...input, namespaces: { ...input.namespaces, extra_checkpoint: 'synthetic_other' },
      catalogues: [...input.catalogues, { kind: 'extra_checkpoint', tables: ['tenant_consumer_checkpoint'] }] }), { code: 'LIFECYCLE_RECOMMISSION_REPLAY_REQUIRED' });
  });
  it('refuses a descriptor copied from artifact-like JSON before any write', async function () {
    let effects = 0;
    await assert.rejects(checkpoint.provision(async () => { effects++; }, { ...checkpoint.describe(input) }, { tenant: '11111111-1111-4111-8111-111111111111', generation: '8' }), { code: 'LIFECYCLE_RECOMMISSION_REPLAY_INVALID' });
    assert.equal(effects, 0);
  });
});
