'use strict';
// Full actual source census/builders. No native schema or runtime acceptance.
const assert = require('node:assert/strict');
const profiles = require('../lib/pgstream/pool-intake-profile');
const source = require('../lib/tenant-operations/catalogues');
const infrastructure = require('../lib/tenant-operations/selected-platform');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const namespaces = Object.fromEntries([...require('../lib/tenant-lifecycle').admittedCatalogue().map(entry => entry.kind), 'lifecycle', 'alarm_suppression', 'notification_outbox'].map(kind => [kind, 'synthetic_' + kind]));
const profile = profiles.create({ namespace: namespaces.checkpoint, membershipNamespace: 'synthetic_membership', lifecycleNamespace: namespaces.lifecycle, role: 'synthetic_intake', operatorRole: 'synthetic_assignment', consumer: 'evaluator-synthetic', codec: profiles.CODEC, generationDomain: profiles.GENERATION_DOMAIN, sliceRule: require('../lib/pool-membership/slice').RULE });
const binding = { namespace: namespaces.notification_outbox, checkpointNamespace: profile.binding.namespace, membershipNamespace: profile.binding.membershipNamespace,
  lifecycleNamespace: profile.binding.lifecycleNamespace, consumer: 'synthetic_realtime', evaluatorConsumer: profile.binding.consumer + '-completed' };
const extensions = [require('./fixtures/tenant-deployment-alarm').alarmInputs({ tenants: [A, B], now: 1700000000000, writerRole: 'synthetic_writer', readerRole: 'synthetic_reader' }).extension,
  require('./fixtures/tenant-deployment-notifications').notificationInputs({ tenants: [A, B], now: 1700000000000, outboxRole: 'synthetic_writer', checkpointWriterRole: 'synthetic_checkpoint_writer', ackReaderRole: 'synthetic_reader' }).extension];
const input = { namespaces, extensions, intakeProfile: profile, notificationBindings: [binding] };
describe('complete selected-v2 artifact source composition', function () {
  it('constructs the exact pool/control/outbox catalogues while excluding the global profile from tenant rows', function () {
    const result = source.deploymentAdmission(input), checkpoint = result.catalogues.find(entry => entry.kind === 'checkpoint');
    assert.deepEqual(checkpoint.catalogue, require('../lib/pgstream/pool-catalogue').build(profile).catalogue);
    assert.deepEqual(checkpoint.tables, ['tenant_consumer_checkpoint']); assert(infrastructure.recognizes(checkpoint.infrastructure));
    const control = result.catalogues.find(entry => entry.kind === 'lifecycle');
    assert.deepEqual(control.catalogue, require('../lib/tenant-lifecycle/generation-domain').catalogue(profile));
    assert(control.tables.includes('tenant_lifecycle_recommission'));
    const outbox = { ...binding }; delete outbox.namespace;
    assert.deepEqual(result.catalogues.find(entry => entry.kind === 'notification_outbox').catalogue, require('../lib/tenant-notifications/pool-partition-candidate').build({ binding: outbox, intakeProfile: profile }).catalogue);
    assert(!result.lifecycle.CATALOGUE.some(entry => entry.tables.includes(infrastructure.TABLE) || entry.kind === 'lifecycle'));
    assert(infrastructure.recognizes(result.lifecycle.CATALOGUE.find(entry => entry.kind === 'checkpoint').infrastructure));
    assert(result.census.selected.filter(entry => entry.sourceConstruction).every(entry => entry.sourceProfileDigest === profile.digest));
  });
  it('requires the current physical namespace and complete explicit notification bindings', function () {
    assert.throws(() => source.deploymentAdmission({ ...input, notificationBindings: [] }), { code: 'OPERATIONS_SELECTED_BINDING_INVALID' });
    assert.throws(() => source.deploymentAdmission({ ...input, notificationBindings: [binding, binding] }), { code: 'OPERATIONS_SELECTED_BINDING_INVALID' });
    assert.throws(() => source.deploymentAdmission({ ...input, namespaces: { ...namespaces, checkpoint: 'foreign_checkpoint' } }), { code: 'OPERATIONS_SELECTED_BINDING_INVALID' });
    assert.throws(() => source.deploymentAdmission({ ...input, notificationBindings: [{ ...binding, consumer: 'evaluator_bad\'route' }] }));
  });
  it('keeps unselected source byte-equivalent and declines implicit selected-v1 reinterpretation', function () {
    const ordinary = source.deploymentAdmission({ namespaces, extensions });
    assert.deepEqual(ordinary.catalogues.find(entry => entry.kind === 'checkpoint').catalogue, require('../migrations/candidates/postgres-consumer-checkpoint-v1.json'));
    assert(ordinary.catalogues.every(entry => !entry.infrastructure && !entry.sourceConstruction));
    const legacy = require('./fixtures/lifecycle-domain-profile').profile();
    assert.throws(() => source.deploymentAdmission({ ...input, intakeProfile: legacy }));
  });
});
