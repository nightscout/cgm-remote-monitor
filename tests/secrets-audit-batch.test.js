'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const batcher = require('../lib/secrets/audit-batch');
const { createSecrets } = require('../lib/secrets/component');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

describe('durable tenant-local audit batching', function () {
  it('coalesces concurrent receipts but releases none before the durable writer commits', async function () {
    const commit = deferred(), writes = [];
    const batch = batcher.create(async (tenant, events) => { writes.push({ tenant, events }); await commit.promise; });
    let released = 0;
    const pending = Array.from({ length: 12 }, (_, id) => batch.append('tenant', { id }).then(() => released++));
    await nextTurn();
    assert.equal(writes.length, 1); assert.equal(writes[0].events.length, 12); assert.equal(released, 0);
    commit.resolve(); await Promise.all(pending); await batch.close();
    assert.equal(released, 12);
  });

  it('bounds a SQL batch and never combines tenants or loses an attempt during close', async function () {
    const writes = [], batch = batcher.create(async (tenant, events) => writes.push({ tenant, events }));
    const pending = Array.from({ length: 130 }, (_, id) => batch.append('A', { id }));
    pending.push(batch.append('B', { id: 0 }));
    await batch.close(); await Promise.all(pending);
    assert.deepEqual(writes.map(write => [write.tenant, write.events.length]), [['A', 64], ['A', 64], ['A', 2], ['B', 1]]);
    await assert.rejects(batch.append('A', {}), { code: 'SECRETS_STORE_UNAVAILABLE' });
  });

  it('a refused batch rejects every receipt before the provider can decrypt', async function () {
    const commit = deferred(); let cryptographicEffects = 0;
    const batch = batcher.create(async () => { await commit.promise; throw Object.assign(new Error('SECRETS_STORE_UNAVAILABLE'), { code: 'SECRETS_STORE_UNAVAILABLE' }); });
    const secrets = createSecrets({ maxTokenLifetimeSeconds: 3600,
      store: { get: async () => null, insert: async () => {} }, authorize: async () => true,
      providerFor: async () => ({ decrypt: async () => { cryptographicEffects++; } }),
      audit: event => batch.append(event.tenant, event) });
    const pending = Array.from({ length: 8 }, () => secrets.decrypt({ tenant: 'tenant', principal: 'subject', consumer: 'api' }, { tenant: 'tenant', id: 'root' }));
    const results = Promise.allSettled(pending);
    await nextTurn(); assert.equal(cryptographicEffects, 0);
    commit.resolve();
    assert((await results).every(result => result.status === 'rejected' && result.reason.code === 'SECRETS_STORE_UNAVAILABLE'));
    assert.equal(cryptographicEffects, 0); await batch.close();
  });

  it('control: not awaiting the durable writer releases the receipt and fails the pre-effect oracle', async function () {
    const file = require.resolve('../lib/secrets/audit-batch'), source = fs.readFileSync(file, 'utf8');
    const marker = 'Promise.resolve().then(() => write(tenant, batch.items.map(item => item.event))).then(';
    assert(source.includes(marker), 'production mutation marker must match');
    const mutated = source.replace(marker, 'Promise.resolve().then(() => { void write(tenant, batch.items.map(item => item.event)); }).then(');
    const output = { exports: {} };
    vm.runInNewContext('(function(module,exports){' + mutated + '\n})', { setImmediate, clearImmediate })(output, output.exports);
    const commit = deferred(); let committed = false, effects = 0;
    const batch = output.exports.create(async () => { await commit.promise; committed = true; });
    await batch.append('tenant', {}); effects++;
    assert.equal(committed, false, 'the actual mutated production receipt precedes commit');
    assert.throws(() => assert.equal(effects, 0, 'AUDIT_COMMITTED_BEFORE_EFFECT'), /AUDIT_COMMITTED_BEFORE_EFFECT/);
    commit.resolve(); await batch.close();
  });
});
