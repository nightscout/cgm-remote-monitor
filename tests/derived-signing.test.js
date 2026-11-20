'use strict';

// covers: lib/secrets/derived-signing.js (decision deployment-signing-secret, D14)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const derived = require('../lib/secrets/derived-signing');
const tokens = require('../lib/tenant-authorization/legacy-data-token');
const { createVerifier } = require('../lib/tenant-authorization/access-token');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SECRET = Buffer.from('synthetic-deployment-signing-secret-0123456789abcdef');

describe('derived tenant signing keys', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-signing-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, text) => { const file = path.join(dir, name); fs.writeFileSync(file, text, { mode: 0o600 }); return file; };

  it('derives one stable key per tenant, purpose and version, and distinct keys otherwise', () => {
    const one = derived.fromSecret(SECRET), two = derived.fromSecret(Buffer.from(SECRET));
    assert.equal(one.key(A, 'data', 1).raw, two.key(A, 'data', 1).raw);
    assert.equal(one.key(A, 'management', 1).kid, 'management-1');
    const all = new Set();
    for (const tenant of [A, B]) for (const purpose of derived.PURPOSES) for (const version of [1, 2]) all.add(one.key(tenant, purpose, version).raw);
    assert.equal(all.size, 2 * derived.PURPOSES.length * 2);
    assert.notEqual(derived.fromSecret(Buffer.concat([SECRET, Buffer.from('x')])).key(A, 'data', 1).raw, one.key(A, 'data', 1).raw);
    assert.throws(() => one.key(A, 'access', 1), TypeError);
    assert.throws(() => one.key('not-a-tenant', 'data', 1), TypeError);
  });

  it('D14: a data JWT issued for tenant A fails signature verification on tenant B', () => {
    const signing = derived.fromSecret(SECRET);
    const codec = tokens.create({ issuer: 'synthetic-data', audience: 'synthetic-api', now: () => 1700000000 });
    const row = (tenant, key) => ({ kid: key.kid, publicKey: key.spki, active: true });
    const keyA = signing.key(A, 'data', 1), keyB = signing.key(B, 'data', 1);
    const principal = { kind: 'subject', subjectId: 'subject', credentialVersion: 1, rootVersion: 1 };
    const issued = codec.issue(A, principal, keyA);
    assert.equal(codec.verify(issued.token, A, [row(A, keyA)]).tid, A);
    // Same kid on both tenants: only the tenant's own derived public key verifies.
    assert.equal(keyA.kid, keyB.kid);
    assert.throws(() => codec.verify(issued.token, B, [row(B, keyB)]), { code: 'SECRETS_TOKEN_INVALID' });
    // Re-claiming tenant B in the payload breaks the signature too.
    const [h, p, s] = issued.token.split('.');
    const forged = h + '.' + Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), tid: B })).toString('base64url') + '.' + s;
    assert.throws(() => codec.verify(forged, B, [row(B, keyB)]), { code: 'SECRETS_TOKEN_INVALID' });
    // A token that claims tenant B but is signed with tenant A's key fails on B:
    // tenant keys differ, so the signature is the barrier, not only the claim.
    const claimingB = codec.issue(B, principal, keyA);
    assert.equal(codec.verify(codec.issue(B, principal, keyB).token, B, [row(B, keyB)]).tid, B);
    assert.throws(() => codec.verify(claimingB.token, B, [row(B, keyB)]), { code: 'SECRETS_TOKEN_INVALID' });
  });

  it('D14: a management token signed for tenant A fails signature verification on tenant B', () => {
    const signing = derived.fromSecret(SECRET);
    const keyFor = tenant => signing.key(tenant, 'management', 1);
    const verify = createVerifier({ issuer: 'synthetic-management', audience: 'synthetic-owner', purpose: 'management', maxLifetimeSeconds: 600,
      now: () => 1700000100, resolveKey: (tenant, kid) => kid === keyFor(tenant).kid
        ? { tenant, kid, issuer: 'synthetic-management', purpose: 'management', publicKey: keyFor(tenant).publicKey } : undefined });
    const token = tenant => {
      const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const input = encode({ alg: 'EdDSA', typ: 'ns-access+jwt', kid: keyFor(A).kid }) + '.' + encode({ iss: 'synthetic-management', aud: 'synthetic-owner',
        tid: tenant, purpose: 'management', sub: 'owner', sid: 'session', cv: 1, iat: 1700000000, nbf: 1700000000, exp: 1700000600 });
      return input + '.' + keyFor(A).sign(Buffer.from(input)).toString('base64url');
    };
    assert.equal(verify(token(A), A).tid, A);
    assert.throws(() => verify(token(B), B), { code: 'TOKEN_SIGNATURE' });
  });

  it('matches stored public keys and refuses another deployment\'s or another purpose\'s key', () => {
    const signing = derived.fromSecret(SECRET), other = derived.fromSecret(Buffer.alloc(32, 7));
    const key = signing.key(A, 'human-data', 1);
    assert.equal(signing.matching(A, 'human-data', { kid: key.kid, publicKey: key.raw }).kid, 'human-data-1');
    assert.equal(signing.matching(A, 'human-data', { kid: key.kid, publicKey: key.spki }).kid, 'human-data-1');
    assert.throws(() => other.matching(A, 'human-data', { kid: key.kid, publicKey: key.raw }), { code: 'SIGNING_KEY_MISMATCH' });
    assert.throws(() => signing.matching(B, 'human-data', { kid: key.kid, publicKey: key.raw }), { code: 'SIGNING_KEY_MISMATCH' });
    assert.throws(() => signing.matching(A, 'management', { kid: key.kid, publicKey: key.raw }), { code: 'SIGNING_KEY_MISMATCH' });
    assert.throws(() => signing.matching(A, 'data', { kid: 'data-' + crypto.randomUUID(), publicKey: key.raw }), { code: 'SIGNING_KEY_MISMATCH' });
  });

  it('loads the secret from NS_SIGNING_SECRET_FILE and refuses an absent, unreadable or short secret', () => {
    const good = write('good', crypto.randomBytes(32).toString('hex') + '\n');
    assert.equal(typeof derived.load({ NS_SIGNING_SECRET_FILE: good }).key(A, 'data', 1).raw, 'string');
    assert.throws(() => derived.load({}), { code: 'SIGNING_SECRET_INVALID' });
    assert.throws(() => derived.load({ NS_SIGNING_SECRET_FILE: path.join(dir, 'absent') }), { code: 'SIGNING_SECRET_INVALID' });
    assert.throws(() => derived.load({ NS_SIGNING_SECRET_FILE: dir }), { code: 'SIGNING_SECRET_INVALID' });
    assert.throws(() => derived.load({ NS_SIGNING_SECRET_FILE: write('short', 'x'.repeat(31)) }), { code: 'SIGNING_SECRET_INVALID' });
    assert.throws(() => derived.load({ NS_SIGNING_SECRET_FILE: write('blank', '   \n') }), { code: 'SIGNING_SECRET_INVALID' });
    assert.equal(typeof derived.load({ NS_SIGNING_SECRET_FILE: write('min', 'y'.repeat(32)) }).key(A, 'data', 1).raw, 'string');
  });
});
