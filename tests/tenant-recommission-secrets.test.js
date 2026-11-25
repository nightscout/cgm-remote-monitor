'use strict';
// Actual AES-GCM provider double and source verifier preparation; not native Vault.
// covers: lib/tenant-lifecycle/recommission-secrets.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const helper = require('../lib/tenant-lifecycle/recommission-secrets');
const artifacts = require('../lib/tenant-lifecycle/artifact');
const verifiers = require('../lib/secrets/legacy-verifiers');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const ROOT = 'synthetic-recommission-secret-root';
const PREFIX = 'LIFECYCLE_RECOMMISSION_SECRETS_';
const clone = value => JSON.parse(JSON.stringify(value));
function encrypt (key, value) {
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return 'vault:v1:' + Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
function decrypt (key, ciphertext) {
  const bytes = Buffer.from(ciphertext.slice('vault:v1:'.length), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
}
function fixture () {
  const key = crypto.randomBytes(32), returned = [], calls = [];
  const material = verifiers.prepare(Buffer.from(ROOT), [{ subjectId: 'subject_a', tokenPrefix: 'prefix' }]);
  const rows = {
    'secrets.secret_records': ['root', 'connector', 'empty'].map(id => ({ tenant_id: A, id, format: 1,
      ciphertext: encrypt(key, { tenant: A, id, data: Buffer.from(id === 'root' ? ROOT : id === 'empty' ? '' : 'synthetic-other-secret').toString('base64') }) })),
    'legacy.legacy_credential_config': [{ tenant_id: A, root_reference_id: 'root', verifier_root_reference_id: 'root', root_version: 7, root_verifiers: [...material.rootVerifiers] }],
    'legacy.legacy_credential_subjects': [{ tenant_id: A, subject_id: 'subject_a', token_prefix: 'prefix', verifier_token_prefix: 'prefix', credential_version: 9, verifiers: [...material.subjects[0].verifiers] }]
  };
  const provider = { async decrypt (ciphertext) { calls.push(ciphertext); const bytes = decrypt(key, ciphertext); returned.push(bytes); return bytes; } };
  return { rows, provider, returned, calls,
    rewrite (id, change) {
      const row = rows['secrets.secret_records'].find(record => record.id === id);
      const bytes = decrypt(key, row.ciphertext);
      try { row.ciphertext = encrypt(key, typeof change === 'function' ? change(JSON.parse(bytes.toString('utf8'))) : change); }
      finally { bytes.fill(0); }
    } };
}
function capture (rows) {
  const kinds = new Map();
  for (const [key, values] of Object.entries(rows)) {
    const [kind, table] = key.split('.'); if (!kinds.has(kind)) kinds.set(kind, []);
    const names = [...new Set(['tenant_id', ...values.flatMap(row => Object.keys(row))])];
    const columns = names.map(name => ({ name, type: name === 'tenant_id' ? 'uuid' : name === 'format' ? 'integer' : 'text' }));
    kinds.get(kind).push({ table, columns, rows: clone(values), secrets: key === 'secrets.secret_records' });
  }
  return artifacts.buildArtifact({ tenant: A, sourceCommit: 'a'.repeat(40), exportedAt: 3000,
    catalogues: [...kinds].map(([kind, tables]) => ({ kind, namespace: 'synthetic_' + kind, ledger: [], tables })) });
}
const args = f => ({ artifact: capture(f.rows), tenant: A, provider: f.provider });
const zeroed = f => f.returned.every(bytes => bytes.every(byte => byte === 0));
async function trackedRoot (fn) {
  const original = verifiers.prepare, roots = [];
  verifiers.prepare = (root, subjects) => { roots.push(root); return original(root, subjects); };
  try { return await fn(roots); } finally { verifiers.prepare = original; }
}
function altered (guard, replacement) {
  const file = path.resolve(__dirname, '../lib/tenant-lifecycle/recommission-secrets.js');
  const source = fs.readFileSync(file, 'utf8'); assert.equal(source.split(guard).length, 2);
  const compiled = new Module(file, module); compiled.filename = file; compiled.paths = Module._nodeModulePaths(path.dirname(file));
  compiled._compile(source.replace(guard, replacement), file); return compiled.exports;
}

describe('recommission captured secrets preflight (cryptographic provider double)', function () {
  it('decrypts every captured record, matches real prepared root/subject verifiers and releases only a frozen success marker', async function () {
    const f = fixture(), input = args(f), original = clone(input.artifact);
    await trackedRoot(async roots => {
      const result = await helper.verify(input);
      assert.deepEqual(result, { verified: true }); assert(Object.isFrozen(result));
      assert.equal(roots.length, 1); assert(roots[0].every(byte => byte === 0), 'decoded root is wiped');
    });
    assert.equal(f.calls.length, 3); assert(zeroed(f), 'every provider-returned plaintext is wiped');
    assert.deepEqual(input.artifact, original, 'retained artifact remains unchanged');
  });

  it('refuses absent provider, wrong tenant or invalid artifact without provider effects and sanitizes artifact errors', async function () {
    const f = fixture(), input = args(f);
    for (const absent of [undefined, null, {}]) await assert.rejects(helper.verify(absent), { code: PREFIX + 'INPUT_INVALID' });
    for (const [change, code] of [
      [value => { value.provider = undefined; }, 'INPUT_INVALID'], [value => { value.tenant = B; }, 'TENANT_MISMATCH'],
      [value => { value.artifact.digest = '0'.repeat(64); }, 'ARTIFACT_INVALID']
    ]) {
      const value = { ...input, artifact: clone(input.artifact) }; change(value);
      await assert.rejects(helper.verify(value), { code: PREFIX + code, message: PREFIX + code });
    }
    assert.equal(f.calls.length, 0);
  });

  it('refuses rehashed omission/duplication of root records and missing preparation or mismatched reference metadata', async function () {
    for (const change of [
      rows => { delete rows['secrets.secret_records']; }, rows => { rows['secrets.secret_records'] = []; },
      rows => { rows['secrets.secret_records'] = rows['secrets.secret_records'].filter(record => record.id !== 'root'); },
      rows => { rows['secrets.secret_records'].push(clone(rows['secrets.secret_records'][0])); },
      rows => { delete rows['legacy.legacy_credential_config']; }, rows => { rows['legacy.legacy_credential_config'] = []; },
      rows => { rows['legacy.legacy_credential_config'][0].root_reference_id = 'missing'; },
      rows => { rows['legacy.legacy_credential_config'][0].root_verifiers = null; },
      rows => { rows['legacy.legacy_credential_config'][0].verifier_root_reference_id = 'another'; },
      rows => { delete rows['legacy.legacy_credential_subjects']; },
      rows => { rows['legacy.legacy_credential_subjects'][0].verifiers = null; },
      rows => { rows['legacy.legacy_credential_subjects'][0].verifier_token_prefix = 'stale'; },
      rows => { rows['legacy.legacy_credential_subjects'].push(clone(rows['legacy.legacy_credential_subjects'][0])); }
    ]) {
      const f = fixture(); change(f.rows);
      await assert.rejects(helper.verify(args(f)), error => error.code.startsWith(PREFIX));
      assert.equal(f.calls.length, 0); assert(zeroed(f));
    }
  });

  it('accepts explicitly prepared zero-subject metadata without inventing a subject credential', async function () {
    const f = fixture(); f.rows['legacy.legacy_credential_subjects'] = [];
    assert.deepEqual(await helper.verify(args(f)), { verified: true }); assert.equal(f.calls.length, 3); assert(zeroed(f));
  });

  it('refuses wrong current provider keys and sanitizes thrown provider body/cause fields', async function () {
    const f = fixture(), input = args(f);
    input.provider = { decrypt: ciphertext => decrypt(crypto.randomBytes(32), ciphertext) };
    await assert.rejects(helper.verify(input), { code: PREFIX + 'DECRYPT_REFUSED', message: PREFIX + 'DECRYPT_REFUSED' });
    input.provider = { decrypt: () => { throw Object.assign(new Error('synthetic-provider-body-must-not-escape'), { body: ROOT, cause: new Error(ROOT), code: 'upstream' }); } };
    await assert.rejects(helper.verify(input), error => {
      assert.deepEqual(Object.keys(error), ['code']); assert(!JSON.stringify(error).includes(ROOT));
      assert.equal(error.message, PREFIX + 'DECRYPT_REFUSED'); assert.equal(error.cause, undefined); return true;
    });
  });

  it('refuses malformed format-1 plaintext, tenant/reference substitution and noncanonical base64 with wiped provider bytes', async function () {
    for (const change of [
      value => ({ ...value, tenant: B }), value => ({ ...value, id: 'other' }), value => ({ ...value, data: 'YQ' }),
      value => ({ ...value, data: 'YR==' }), value => ({ ...value, data: 7 }), () => null,
      () => Buffer.from('not-json')
    ]) {
      const f = fixture(); f.rewrite('root', change);
      await assert.rejects(helper.verify(args(f)), { code: PREFIX + 'RECORD_INVALID' });
      assert(zeroed(f));
    }
    const f = fixture(); f.rows['secrets.secret_records'][0].format = '1';
    await assert.rejects(helper.verify(args(f)), { code: PREFIX + 'RECORD_INVALID' }); assert.equal(f.calls.length, 0);
  });

  it('refuses valid decrypted roots that do not reproduce captured root or subject preparations and wipes the decoded root on failure', async function () {
    for (const change of [
      f => { f.rows['legacy.legacy_credential_config'][0].root_verifiers[0] = 'f'.repeat(64); },
      f => { f.rows['legacy.legacy_credential_subjects'][0].verifiers[0] = 'f'.repeat(64); },
      f => { f.rewrite('root', value => ({ ...value, data: Buffer.from('different-valid-synthetic-root').toString('base64') })); },
      f => { f.rewrite('root', value => ({ ...value, data: Buffer.from('short').toString('base64') })); }
    ]) {
      const f = fixture(); change(f);
      await trackedRoot(async roots => {
        await assert.rejects(helper.verify(args(f)), { code: PREFIX + 'VERIFIER_MISMATCH' });
        assert.equal(roots.length, 1); assert(roots[0].every(byte => byte === 0));
      });
      assert(zeroed(f));
    }
  });

  it('checks non-root records too and wipes prior successes before a later provider/decode failure', async function () {
    const f = fixture(); f.rewrite('connector', value => ({ ...value, tenant: B }));
    await assert.rejects(helper.verify(args(f)), { code: PREFIX + 'RECORD_INVALID' });
    assert.equal(f.calls.length, 2); assert(zeroed(f));
    const later = fixture(), original = later.provider.decrypt;
    later.provider.decrypt = async ciphertext => { if (later.calls.length === 1) throw new Error(ROOT); return original(ciphertext); };
    await assert.rejects(helper.verify(args(later)), { code: PREFIX + 'DECRYPT_REFUSED' }); assert(zeroed(later));
    const invalid = fixture(), bytes = new Uint8Array([1, 2, 3]); invalid.provider.decrypt = async () => bytes;
    await assert.rejects(helper.verify(args(invalid)), { code: PREFIX + 'RECORD_INVALID' }); assert(bytes.every(byte => byte === 0));
  });

  it('owns relevant metadata before asynchronous provider work instead of observing later artifact mutations', async function () {
    const f = fixture(), input = args(f), original = f.provider.decrypt;
    f.provider.decrypt = async ciphertext => {
      input.artifact.tables['legacy.legacy_credential_subjects'][0].verifiers = null;
      return original(ciphertext);
    };
    assert.deepEqual(await helper.verify(input), { verified: true }); assert(zeroed(f));
  });

  it('control: omitted tenant binding accepts a cryptographically valid foreign envelope; restored source refuses', async function () {
    const broken = altered('value.tenant !== tenant || ', '');
    const f = fixture(); f.rewrite('root', value => ({ ...value, tenant: B }));
    await assert.rejects(assert.rejects(broken.verify(args(f))), /Missing expected rejection/);
    assert(zeroed(f));
    await assert.rejects(helper.verify(args(f)), { code: PREFIX + 'RECORD_INVALID' }); assert(zeroed(f));
  });

  it('control: omitted prepared-verifier comparison accepts mismatched recovered credentials; restored source refuses', async function () {
    const broken = altered('if (!isDeepStrictEqual(prepared.rootVerifiers, config.root_verifiers) ||\n              prepared.subjects.some((subject, index) => !isDeepStrictEqual(subject.verifiers, subjects[index].verifiers))) throw null;', '');
    const f = fixture(); f.rows['legacy.legacy_credential_config'][0].root_verifiers[0] = 'f'.repeat(64);
    await assert.rejects(assert.rejects(broken.verify(args(f))), /Missing expected rejection/);
    assert(zeroed(f));
    await assert.rejects(helper.verify(args(f)), { code: PREFIX + 'VERIFIER_MISMATCH' }); assert(zeroed(f));
  });
});
