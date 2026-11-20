'use strict';
// Entry admission only. Complete DATA/ACTIVATION reconstruction is a native criterion.
const assert = require('node:assert/strict');
const writer = require('../lib/tenant-lifecycle/recommission');
const artifacts = require('../lib/tenant-lifecycle/artifact');
const profiles = require('../lib/pgstream/pool-intake-profile');
const A = '11111111-1111-4111-8111-111111111111';
const profile = profiles.create({ namespace: 'synthetic_checkpoint', membershipNamespace: 'synthetic_membership', lifecycleNamespace: 'synthetic_control', role: 'synthetic_intake', operatorRole: 'synthetic_assignment', consumer: 'evaluator-synthetic', codec: profiles.CODEC, generationDomain: profiles.GENERATION_DOMAIN, sliceRule: require('../lib/pool-membership/slice').RULE });
function captured () { return artifacts.buildArtifact({ tenant: A, sourceCommit: 'a'.repeat(40), exportedAt: 100,
  catalogues: [{ kind: 'activity', namespace: 'synthetic_activity', ledger: [], tables: [{ table: 'activity', columns: [{ name: 'tenant_id', type: 'uuid' }, { name: 'doc', type: 'jsonb' }], rows: [{ tenant_id: A, doc: { _id: 'synthetic', nested: { unchanged: true } } }] }] }] }); }
describe('exact recommission writer admission', function () {
  let previous; const scope = require('../lib/storage/tenant-scope');
  beforeEach(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(previous));
  it('refuses a forged actual maintenance claim before authorization, provider reads or SQL', async function () {
    let effects = 0;
    const forbidden = async () => { effects++; throw new Error('Unexpected effect'); };
    const restore = writer.create({ intakeProfile: profile, registryNamespace: 'synthetic_registry', currentConfiguration: forbidden, providerFor: forbidden,
      signing: require('./fixtures/signing-secret').signing, authorize: forbidden, verifyDurableArtifact: forbidden, admissionCheck: forbidden });
    await assert.rejects(restore({ transaction: fn => fn(), query: forbidden }, captured(), { tenant: A, ledgerNamespace: profile.binding.lifecycleNamespace, maintenanceClaim: {} }), { code: 'LIFECYCLE_RESTORE_CLAIM_INVALID' });
    assert.equal(effects, 0);
  });
  it('refuses mismatched artifact tenant and missing current capabilities before opening a transaction', async function () {
    const restore = writer.create({ intakeProfile: profile, registryNamespace: 'synthetic_registry' });
    let opened = false; const connection = { transaction: async () => { opened = true; } };
    await assert.rejects(restore(connection, captured(), { tenant: '22222222-2222-4222-8222-222222222222' }), { code: 'LIFECYCLE_TENANT_MISMATCH' });
    await assert.rejects(restore(connection, captured(), { tenant: A, ledgerNamespace: profile.binding.lifecycleNamespace }), { code: 'LIFECYCLE_RECOMMISSION_CAPABILITIES_REQUIRED' });
    assert.equal(opened, false);
  });
});
