'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createSecrets } = require('../lib/secrets/component');

// Source-only tests: the provider/store below are synthetic doubles. No Vault,
// database, HTTP listener or distributed transaction acceptance is claimed.
describe('tenant legacy credential issuance boundary', function () {
  const actor = { tenant: 'tenant-a', principal: 'owner-a', consumer: 'owner' };
  const subjectId = 'synthetic-subject';
  function fixture () {
    const roots = new Map([['tenant-a', Buffer.alloc(32, 17)], ['tenant-b', Buffer.alloc(32, 23)]]);
    const metadata = new Map([...roots.keys()].map(tenant => [tenant,
      { reference: { tenant, id: 'legacy-root' }, subjects: [{ subjectId, tokenPrefix: 'synthetic' }] }]));
    const events = [], grants = new Set(['issue-legacy', 'decrypt']);
    let effects = 0, fenced = false, active = true;
    const options = {
      async providerFor (tenant) {
        assert.equal(fenced, true, 'crypto must stay within the current-authority fence');
        assert.ok(roots.has(tenant));
        return { async decrypt () {
          effects++;
          return Buffer.from(JSON.stringify({ tenant, id: 'legacy-root', data: roots.get(tenant).toString('base64') }));
        } };
      },
      store: { async get (tenant, id) { return { format: 1, tenant, id, ciphertext: 'synthetic-envelope' }; }, async insert () {} },
      async authorize (who, action) { return who.principal === 'owner-a' && active && grants.has(action.operation); },
      async audit (event) { events.push(event); },
      async legacyAuthorityFor (tenant) { return metadata.get(tenant); },
      maxTokenLifetimeSeconds: 28800
    };
    async function withCurrentSubject (target, issue) {
      assert.deepEqual(target, { tenant: actor.tenant, subjectId });
      if (!active) throw Object.assign(new Error('revoked'), { code: 'SUBJECT_ADMIN_FORBIDDEN' });
      fenced = true;
      try { return await issue(); } finally { fenced = false; }
    }
    return { roots, metadata, events, grants, options, withCurrentSubject,
      component: createSecrets(options), effects: () => effects,
      revoke () { active = false; },
      async fenced (operation) { fenced = true; try { return await operation(); } finally { fenced = false; } } };
  }

  it('derives the shipping token from independently held synthetic root bytes and current metadata', async function () {
    const f = fixture();
    const result = await f.component.issueLegacyCredential(actor, subjectId, f.withCurrentSubject);
    const rootHash = createHash('sha1').update(f.roots.get(actor.tenant)).digest('hex');
    const expected = 'synthetic-' + createHash('sha1').update(rootHash + subjectId).digest('hex').slice(0, 16);
    assert.deepEqual(result, { token: expected });
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(f.events.map(event => event.operation), ['issue-legacy']);
    assert.equal(JSON.stringify(f.events).includes(result.token), false);
    assert.equal(JSON.stringify(f.events).includes(rootHash), false);
    const worker = createSecrets(f.options);
    const verified = await f.fenced(() => worker.verifyLegacyCredential(actor, { apiSecret: result.token }));
    assert.deepEqual(verified, { kind: 'subject', subjectId });
  });

  it('keeps equal subject IDs bound to each tenant root', async function () {
    const f = fixture();
    const first = await f.component.issueLegacyCredential(actor, subjectId, f.withCurrentSubject);
    const otherActor = { ...actor, tenant: 'tenant-b' };
    const second = await f.component.issueLegacyCredential(otherActor, subjectId, async (target, issue) => {
      assert.deepEqual(target, { tenant: otherActor.tenant, subjectId });
      return f.fenced(issue);
    });
    const rootHash = createHash('sha1').update(f.roots.get('tenant-b')).digest('hex');
    assert.equal(second.token, 'synthetic-' + createHash('sha1').update(rootHash + subjectId).digest('hex').slice(0, 16));
    assert.notEqual(first.token, second.token);
  });

  it('requires separate issuance authority, current subject fencing and durable audit before crypto', async function () {
    const f = fixture();
    f.grants.delete('issue-legacy');
    await assert.rejects(f.component.issueLegacyCredential(actor, subjectId, f.withCurrentSubject), { code: 'SECRETS_FORBIDDEN' });
    assert.equal(f.effects(), 0);
    await assert.rejects(f.component.issueLegacyCredential(actor, subjectId), TypeError);
    f.grants.add('issue-legacy');
    const deniedAudit = createSecrets({ ...f.options, async audit () { throw new Error('audit unavailable'); } });
    await assert.rejects(deniedAudit.issueLegacyCredential(actor, subjectId, f.withCurrentSubject), /audit unavailable/);
    assert.equal(f.effects(), 0);
    f.revoke();
    await assert.rejects(f.component.issueLegacyCredential(actor, subjectId, f.withCurrentSubject), { code: 'SUBJECT_ADMIN_FORBIDDEN' });
    assert.equal(f.effects(), 0);
  });

  it('refuses missing metadata and wrong-tenant references without selecting another root', async function () {
    const f = fixture();
    f.metadata.get(actor.tenant).subjects = [];
    await assert.rejects(f.component.issueLegacyCredential(actor, subjectId, f.withCurrentSubject), { code: 'SECRETS_NOT_FOUND' });
    f.metadata.get(actor.tenant).subjects = [{ subjectId, tokenPrefix: 'synthetic' }];
    f.metadata.get(actor.tenant).reference.tenant = 'tenant-b';
    await assert.rejects(f.component.issueLegacyCredential(actor, subjectId, f.withCurrentSubject), { code: 'SECRETS_REFERENCE_MISMATCH' });
    assert.equal(f.effects(), 0);
    assert.equal(f.events.length, 0);
  });

  it('does not release credentials when the current-authority transaction fails after derivation', async function () {
    const f = fixture();
    await assert.rejects(f.component.issueLegacyCredential(actor, subjectId, async (target, issue) => {
      await f.withCurrentSubject(target, issue);
      throw new Error('commit refused');
    }), /commit refused/);
    assert.equal(f.effects(), 1);
    await assert.rejects(f.component.issueLegacyCredential(actor, subjectId, async () => ({ token: 'substitute' })),
      { code: 'SECRETS_FORBIDDEN' });
  });

  it('clears the decoded root buffer before returning the derived credential', async function () {
    const f = fixture();
    const encoded = f.roots.get(actor.tenant).toString('base64');
    const captured = [], original = Buffer.from;
    Buffer.from = function (...args) {
      const result = original.apply(Buffer, args);
      if (args[0] === encoded && args[1] === 'base64') captured.push(result);
      return result;
    };
    try { await f.component.issueLegacyCredential(actor, subjectId, f.withCurrentSubject); }
    finally { Buffer.from = original; }
    assert.ok(captured.length >= 1, 'observed decoded root');
    assert.deepEqual(captured.at(-1), Buffer.alloc(32), 'root material must be cleared');
    assert.deepEqual(f.roots.get(actor.tenant), Buffer.alloc(32, 17), 'external encrypted-store fixture unchanged');
  });
});
