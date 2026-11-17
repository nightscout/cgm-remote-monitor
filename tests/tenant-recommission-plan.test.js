'use strict';
// Pure artifact planning/credential controls; native admission and recovery are separate.
// covers: lib/tenant-lifecycle/recommission-plan.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const artifacts = require('../lib/tenant-lifecycle/artifact');
const planner = require('../lib/tenant-lifecycle/recommission-plan');
const localTokens = require('../lib/tenant-authorization/legacy-data-token');
const verifiers = require('../lib/secrets/legacy-verifiers');
const clinical = require('../lib/tenant-lifecycle/clinical-catalogue').CLINICAL;
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const ROOT = Buffer.from('synthetic-recommission-root');
const key = localTokens.generateKey(), material = verifiers.prepare(ROOT, [{ subjectId: 'subject_a', tokenPrefix: 'a' }]);
const clone = value => JSON.parse(JSON.stringify(value));
const typed = (kind, n) => ({ tenant_id: A, id_kind: 'string',
  doc: { _id: kind + '-' + n, identifier: kind + '-' + n, srvCreated: 1000, srvModified: 1200,
    nested: { flag: false, zero: 0, nullable: null, ordered: [3, 1] } }, ...(kind === 'activity' || kind === 'settings' ? {} : { insertion_ordinal: String(n) }) });

function input () {
  const rows = {};
  for (const entry of require('../lib/tenant-lifecycle').admittedCatalogue()) for (const table of entry.tables) rows[entry.kind + '.' + table] = [];
  for (const kind of clinical) {
    rows[kind + '.' + kind] = [typed(kind, 11), typed(kind, 3)];
    if (!['activity', 'settings'].includes(kind)) rows[kind + '.tenant_insertion_ordinal'] = [{ tenant_id: A, last_ordinal: '17' }];
  }
  rows['clock.tenant_write_clock'] = [{ tenant_id: A, last_stamp: '2000', last_delete_stamp: '1500' }];
  rows['legacy.legacy_credential_config'] = [{ tenant_id: A, root_reference_id: 'root_a', root_version: 7,
    root_verifiers: [...material.rootVerifiers], verifier_root_reference_id: 'root_a' }];
  rows['legacy.legacy_credential_subjects'] = [{ tenant_id: A, subject_id: 'subject_a', token_prefix: 'a',
    credential_version: 9, verifiers: [...material.subjects[0].verifiers], verifier_token_prefix: 'a' }];
  rows['legacy.legacy_data_keys'] = [{ tenant_id: A, kid: key.kid, public_key: key.publicKey, private_key: key.privateKey, active: true, signing: true }];
  rows['access.access_credentials'] = [
    { tenant_id: A, credential_id: 'identity_a', subject_id: 'subject_a', generation: 4, enabled: true },
    { tenant_id: A, credential_id: 'identity_disabled', subject_id: 'subject_a', generation: 8, enabled: false },
    { tenant_id: A, credential_id: 'management_' + A.replaceAll('-', ''), subject_id: 'subject_a', generation: 1, enabled: true },
    { tenant_id: A, credential_id: 'request_bound', subject_id: 'subject_a', generation: 1, enabled: true }
  ];
  rows['access.management_session_requests'] = [{ tenant_id: A, request_id: A, credential_id: 'request_bound' }];
  rows['access.access_sessions'] = [{ tenant_id: A, session_id: 'old_session', active: true }];
  rows['access.access_keys'] = [{ tenant_id: A, kid: 'old_key', purpose: 'data', active: true }];
  rows['human_session.human_identities'] = [{ tenant_id: A, issuer: 'https://synthetic.invalid', provider_subject: 'provider_a',
    subject_id: 'subject_a', credential_id: 'identity_a', enabled: true, generation: 6, purposes: ['data'] }];
  rows['human_session.human_sessions'] = [{ tenant_id: A, session_id: 'old_human', active: true }];
  rows['human_session.human_access_tokens'] = [{ tenant_id: A, token_hash: 'a'.repeat(64), session_id: 'old_human' }];
  rows['human_session.human_logout_events'] = [{ tenant_id: A, issuer: 'https://synthetic.invalid', event_id: 'old_logout', issued_at: '1000' }];
  rows['alarm_suppression.tenant_alarm_suppression'] = [{ tenant_id: A, alarm_group: 'default', alarm_level: 2, acked_at: '1000', expires_at: '1500' }];
  rows['evaluator_checkpoint.tenant_consumer_checkpoint'] = [{ tenant_id: A, consumer: 'evaluator-old', work_owner_ordinal: 9,
    work_assignment_revision: '9', output_restore_generation: '9', projection: [{ old: 'output' }] }];
  for (const table of ['tenant_notification_heads', 'tenant_notification_requests', 'tenant_notification_state']) {
    rows['notification_outbox.' + table] = [{ tenant_id: A, archived: { attempt_token: A, payload: 'do not replay' } }];
  }
  rows['secrets.secret_records'] = [{ tenant_id: A, id: 'root_a', format: 1, ciphertext: 'vault:v1:c3ludGhldGlj' }];
  for (const [kind, tables] of Object.entries({
    authorization: ['tenant_owner_policy', 'tenant_owner_actors'], operator_policy: ['tenant_operator_policy'],
    owner_configuration: ['tenant_owner_configuration_authority'], subject_policy: ['subject_policy']
  })) for (const table of tables) rows[kind + '.' + table] = [{ tenant_id: A, archived: { active: true, grants: ['*'] } }];
  return rows;
}
function capture (rows = input()) {
  const kinds = new Map();
  for (const [key, values] of Object.entries(rows)) {
    const [kind, table] = key.split('.');
    if (!kinds.has(kind)) kinds.set(kind, []);
    const names = [...new Set(['tenant_id', ...values.flatMap(row => Object.keys(row))])];
    const columns = names.map(name => ({ name, type: name === 'tenant_id' ? 'uuid' : typeof values[0]?.[name] === 'object' ? 'jsonb' : 'text' }));
    kinds.get(kind).push({ table, columns, rows: clone(values), secrets: key === 'secrets.secret_records' });
  }
  return artifacts.buildArtifact({ tenant: A, sourceCommit: 'a'.repeat(40), exportedAt: 3000,
    catalogues: [...kinds].map(([kind, tables]) => ({ kind, namespace: 'synthetic_' + kind, ledger: [], tables })) });
}
const plan = artifact => planner.plan(artifact, { tenant: A, artifactDigest: artifact.digest });
function altered (guard, replacement) {
  const file = path.resolve(__dirname, '../lib/tenant-lifecycle/recommission-plan.js');
  const source = fs.readFileSync(file, 'utf8');
  assert.equal(source.split(guard).length, 2, 'control must change exactly one guard');
  const compiled = new Module(file, module); compiled.filename = file; compiled.paths = Module._nodeModulePaths(path.dirname(file));
  compiled._compile(source.replace(guard, replacement), file); return compiled.exports;
}
function currentVerifier (planned, { permitOldKey = false } = {}) {
  const config = planned.tables['legacy.legacy_credential_config'][0];
  const subjects = planned.tables['legacy.legacy_credential_subjects'];
  const keys = planned.tables['legacy.legacy_data_keys'].map(row => ({ kid: row.kid, publicKey: row.public_key, privateKey: row.private_key,
    active: row.active || permitOldKey && row.kid === key.kid }));
  const codec = localTokens.create({ issuer: 'synthetic', audience: 'synthetic', now: () => 1000 });
  return { codec, keys, authority: verifiers.create({ verifyToken: codec.verify, read: async () => ({ rootVerifiers: config.root_verifiers,
    rootVersion: config.root_version, keys, subjects: subjects.map(row => ({ subjectId: row.subject_id, credentialVersion: row.credential_version, verifiers: row.verifiers })) }) }) };
}

describe('exact artifact recommission reconstruction plan', function () {
  it('preserves all seven clinical contents/public IDs/source columns and relative order with captured floors', function () {
    const artifact = capture(), before = clone(artifact), result = plan(artifact);
    for (const kind of clinical) {
      const original = artifact.tables[kind + '.' + kind];
      const expected = ['activity', 'settings'].includes(kind) ? original : original.slice().sort((a, b) => Number(a.insertion_ordinal) - Number(b.insertion_ordinal));
      assert.deepEqual(result.tables[kind + '.' + kind], expected);
    }
    assert.deepEqual(result.floors.clock, { last_stamp: '2000', last_delete_stamp: '1500' });
    assert.deepEqual(result.floors.insertion, { entries: '17', treatments: '17', devicestatus: '17', profile: '17', food: '17' });
    assert.deepEqual(result.tables['secrets.secret_records'], before.tables['secrets.secret_records']);
    assert.deepEqual(result.tables['alarm_suppression.tenant_alarm_suppression'], before.tables['alarm_suppression.tenant_alarm_suppression']);
    assert.deepEqual(artifact, before, 'planning does not alter retained original');
  });

  it('owns and freezes every returned row and nested value without freezing the artifact', function () {
    const artifact = capture(), result = plan(artifact), row = result.tables['entries.entries'][0];
    assert(Object.isFrozen(result) && Object.isFrozen(result.tables) && Object.isFrozen(row.doc.nested.ordered));
    assert.throws(() => { row.doc.nested.ordered.push(9); }, TypeError);
    artifact.tables['entries.entries'][1].doc.nested.ordered.push(8);
    assert.deepEqual(row.doc.nested.ordered, [3, 1]);
    assert(!Object.isFrozen(artifact));
  });

  it('resets sessions and producer state while preserving live delivery obligations and authority', function () {
    const artifact = capture(), result = plan(artifact);
    for (const key of ['access.access_sessions', 'access.management_session_requests', 'human_session.human_sessions',
      'human_session.human_access_tokens', 'checkpoint.tenant_consumer_checkpoint', 'evaluator_checkpoint.tenant_consumer_checkpoint',
      'notification_outbox.tenant_notification_state']) {
      assert(result.reset.includes(key), key); assert(!Object.hasOwn(result.tables, key));
    }
    for (const key of ['notification_outbox.tenant_notification_heads', 'notification_outbox.tenant_notification_requests',
      'access.access_tenants', 'access.access_keys', 'authorization.tenant_owner_policy', 'authorization.tenant_owner_actors',
      'subject_policy.subject_policy', 'operator_policy.tenant_operator_policy', 'owner_configuration.tenant_owner_configuration_authority']) {
      assert(result.current.includes(key), key); assert(!Object.hasOwn(result.tables, key));
    }
    assert.deepEqual(result.tables['human_session.human_logout_events'], artifact.tables['human_session.human_logout_events']);
  });

  it('advances persistent credential/identity epochs while excluding request-derived management credentials', function () {
    const result = plan(capture());
    assert.equal(result.tables['legacy.legacy_credential_config'][0].root_version, 8);
    assert.equal(result.tables['legacy.legacy_credential_subjects'][0].credential_version, 10);
    assert.deepEqual(result.tables['access.access_credentials'].map(row => [row.credential_id, row.generation, row.enabled]),
      [['identity_a', 5, true], ['identity_disabled', 9, false]]);
    assert.equal(result.tables['human_session.human_identities'][0].generation, 7);
  });

  it('recovers long-lived legacy credentials, retires captured key authority and rejects old DATAJWT through the real verifier', async function () {
    const artifact = capture(), result = plan(artifact), fresh = result.tables['legacy.legacy_data_keys'].find(row => row.signing);
    const retired = result.tables['legacy.legacy_data_keys'].find(row => row.kid === key.kid);
    assert.deepEqual([retired.active, retired.signing, retired.private_key], [false, false, null]);
    assert(fresh && fresh.kid !== key.kid && fresh.private_key);
    const verify = currentVerifier(result), codec = verify.codec;
    const old = codec.issue(A, { kind: 'subject', subjectId: 'subject_a', credentialVersion: 9, rootVersion: 7 }, key).token;
    assert.equal(await verify.authority.verifyLegacyCredential({ tenant: A }, { token: old }, async () => true), null);
    const sha1 = crypto.createHash('sha1').update(ROOT).digest('hex');
    assert.deepEqual(await verify.authority.verifyLegacyCredential({ tenant: A }, { apiSecret: sha1 }), { kind: 'root' });
    const digest = crypto.createHash('sha1').update(sha1 + 'subject_a').digest('hex');
    const principal = await verify.authority.verifyLegacyCredential({ tenant: A }, { apiSecret: digest });
    assert.equal(principal.credentialVersion, 10); assert.equal(principal.rootVersion, 8);
    const issued = codec.issue(A, principal, { kid: fresh.kid, publicKey: fresh.public_key, privateKey: fresh.private_key });
    assert.equal((await verify.authority.verifyLegacyCredential({ tenant: A }, { token: issued.token }, async () => true)).subjectId, 'subject_a');
  });

  it('refuses wrong tenant/digest and table dispositions not explicitly admitted', function () {
    const artifact = capture();
    assert.throws(() => planner.plan(artifact, { tenant: B, artifactDigest: artifact.digest }), { code: 'LIFECYCLE_RECOMMISSION_TENANT_MISMATCH' });
    assert.throws(() => planner.plan(artifact, { tenant: A, artifactDigest: 'b'.repeat(64) }), { code: 'LIFECYCLE_RECOMMISSION_ARTIFACT_MISMATCH' });
    const rows = input(); rows['unknown.arbitrary'] = [{ tenant_id: A }];
    assert.throws(() => plan(capture(rows)), { code: 'LIFECYCLE_RECOMMISSION_TABLE_UNSUPPORTED', detail: 'unknown.arbitrary' });
  });

  it('refuses omitted/rehashed signer tables, omitted signer rows and tampered/mismatched key pairs', function () {
    for (const change of [
      rows => { delete rows['legacy.legacy_data_keys']; }, rows => { rows['legacy.legacy_data_keys'] = []; },
      rows => { rows['legacy.legacy_data_keys'][0].private_key = null; },
      rows => { rows['legacy.legacy_data_keys'][0].private_key = 'tampered'; },
      rows => { rows['legacy.legacy_data_keys'][0].kid = 123; },
      rows => { rows['legacy.legacy_data_keys'][0].public_key = localTokens.generateKey().publicKey; },
      rows => { rows['legacy.legacy_data_keys'][0].signing = false; }
    ]) { const rows = input(); change(rows); assert.throws(() => plan(capture(rows)), error => /^LIFECYCLE_RECOMMISSION_KEY_/.test(error.code)); }
    const rows = input(); rows['legacy.legacy_data_keys'].push({ ...rows['legacy.legacy_data_keys'][0], kid: 'other_signer' });
    assert.throws(() => plan(capture(rows)), { code: 'LIFECYCLE_RECOMMISSION_KEY_INVALID' });
  });

  it('refuses missing/malformed/out-of-range or rewound history floors and metadata above the clock', function () {
    for (const change of [
      rows => { delete rows['clock.tenant_write_clock']; }, rows => { rows['clock.tenant_write_clock'] = []; },
      rows => { rows['clock.tenant_write_clock'][0].last_stamp = '02000'; },
      rows => { rows['clock.tenant_write_clock'][0].last_stamp = '9223372036854775808'; },
      rows => { rows['clock.tenant_write_clock'][0].last_stamp = '8640000000000000'; },
      rows => { rows['clock.tenant_write_clock'][0].last_delete_stamp = '2001'; },
      rows => { rows['entries.entries'][0].doc.srvCreated = 2001; },
      rows => { rows['activity.activity'][0].doc.srvModified = '1200'; }
    ]) { const rows = input(); change(rows); assert.throws(() => plan(capture(rows)), error => /^LIFECYCLE_RECOMMISSION_(CLOCK_|METADATA_)/.test(error.code)); }
  });

  it('refuses missing/behind/duplicate/int8-overflow insertion floors and invalid or ambiguous public identities', function () {
    for (const change of [
      rows => { delete rows['entries.tenant_insertion_ordinal']; },
      rows => { rows['entries.tenant_insertion_ordinal'][0].last_ordinal = '10'; },
      rows => { rows['entries.tenant_insertion_ordinal'][0].last_ordinal = '9223372036854775808'; },
      rows => { rows['entries.entries'][1].insertion_ordinal = '11'; },
      rows => { rows['entries.entries'][0].id_kind = 'arbitrary'; },
      rows => { rows['entries.entries'][1].doc.identifier = rows['entries.entries'][0].doc.identifier; }
    ]) { const rows = input(); change(rows); assert.throws(() => plan(capture(rows))); }
  });

  it('refuses epoch overflow and malformed stored integer values rather than wrapping or coercing them', function () {
    for (const [key, column] of [['legacy.legacy_credential_config', 'root_version'], ['legacy.legacy_credential_subjects', 'credential_version'],
      ['access.access_credentials', 'generation'], ['human_session.human_identities', 'generation']]) {
      for (const bad of [2147483647, 0, -1, '1', 1.5]) {
        const rows = input(); rows[key][0][column] = bad;
        assert.throws(() => plan(capture(rows)), { code: 'LIFECYCLE_RECOMMISSION_EPOCH_INVALID' });
      }
    }
  });

  it('control: omitting the exact-artifact guard admits a different self-consistent snapshot; restored source refuses', function () {
    const broken = altered("if (typeof artifactDigest !== 'string' || artifact.digest !== artifactDigest) fail('ARTIFACT_MISMATCH');", '');
    const artifact = capture(), rows = input(); rows['clock.tenant_write_clock'][0].last_stamp = '1999'; const other = capture(rows);
    assert.throws(() => assert.throws(() => broken.plan(other, { tenant: A, artifactDigest: artifact.digest }),
      { code: 'LIFECYCLE_RECOMMISSION_ARTIFACT_MISMATCH' }), /Missing expected exception/);
    assert.throws(() => planner.plan(other, { tenant: A, artifactDigest: artifact.digest }), { code: 'LIFECYCLE_RECOMMISSION_ARTIFACT_MISMATCH' });
  });

  it('control: omitted epoch advancement reactivates a captured DATAJWT if old verification key retirement is broken independently', async function () {
    const broken = altered('return value + 1;', 'return value;');
    const artifact = capture(), old = localTokens.create({ issuer: 'synthetic', audience: 'synthetic', now: () => 1000 })
      .issue(A, { kind: 'subject', subjectId: 'subject_a', credentialVersion: 9, rootVersion: 7 }, key).token;
    const bad = currentVerifier(broken.plan(artifact, { tenant: A, artifactDigest: artifact.digest }), { permitOldKey: true });
    const accepted = await bad.authority.verifyLegacyCredential({ tenant: A }, { token: old }, async () => true);
    assert.throws(() => assert.equal(accepted, null), assert.AssertionError, 'red: broken epochs plus permitted historical verification key accepts the old DATAJWT');
    const restored = currentVerifier(plan(artifact), { permitOldKey: true });
    assert.equal(await restored.authority.verifyLegacyCredential({ tenant: A }, { token: old }, async () => true), null, 'restored epoch guard rejects even with old public key present');
  });
});
