'use strict';
// Contract tests for the v1 internal hints and the shared post-commit sender
// (spike S3). Synthetic tenant ids only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const hints = require('../lib/internal-hints');
const slice = require('../lib/pool-membership/slice');
const { validate } = require('../lib/server/internal-api/schema');
const contracts = require('../lib/server/internal-api/contracts');

const tenantOf = i => crypto.createHash('sha256').update('s3-synthetic-' + i).digest('hex').slice(0, 32)
  .replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12})$/, '$1-$2-4$3-8$4-$5');
const TENANTS = Array.from({ length: 200 }, (_, i) => tenantOf(i));
// Independent of slice.js: the first 8 bytes of sha256(tenant), unsigned, mod K.
const expected = (tenant, k) => Number(crypto.createHash('sha256').update(tenant, 'utf8').digest().readBigUInt64BE(0) % BigInt(k));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until (check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('timed out'); await wait(5); }
}

// One HTTP receiver per ordinal; each records what reached it.
async function receivers (k, answer = () => 202, { hold } = {}) {
  const rows = [];
  for (let ordinal = 0; ordinal < k; ordinal++) {
    const seen = [];
    let concurrent = 0, peak = 0;
    const server = http.createServer((req, res) => {
      concurrent++; peak = Math.max(peak, concurrent);
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => {
        const hit = hints.contract.route(req.url);
        seen.push({ ...hit, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : {} });
        if (hold) await hold();
        const status = answer(hit, ordinal);
        if (status === null) return; // never answers
        res.writeHead(status, { 'content-length': 0 }); res.end(); concurrent--;
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    rows.push({ server, seen, get peak () { return peak; }, url: 'http://127.0.0.1:' + server.address().port + '/' });
  }
  return { rows, address: i => ({ url: rows[i].url }),
    close: () => Promise.all(rows.map(row => { row.server.closeAllConnections(); return new Promise(resolve => row.server.close(resolve)); })) };
}

describe('internal hints v1: owner computation', () => {
  it('slice.js agrees with an independent sha256-modulo at K 1..9 (and its SQL form is the same rule)', () => {
    for (let k = 1; k <= 9; k++) for (const tenant of TENANTS) assert.equal(hints.contract.owner(tenant, k), expected(tenant, k));
    assert.equal(hints.contract.RULE, 'sha256-modulo-v1');
  });

  async function routed (k, owner) {
    const peers = await receivers(k);
    const sender = hints.sender.create({ targets: { evaluator: { count: k, address: peers.address } }, maxInFlight: 8, ...(owner ? { owner } : {}) });
    try {
      for (const tenant of TENANTS) sender.changed(tenant, { stamp: 1 });
      await until(() => sender.stats().accepted === TENANTS.length);
      return peers.rows.map(row => row.seen.map(hit => hit.tenant).sort());
    } finally { await sender.close(); await peers.close(); }
  }
  const byOwner = k => Array.from({ length: k }, (_, i) => TENANTS.filter(t => slice.bucket(t, k) === i).sort());

  it('sends each tenant to exactly the ordinal slice.js names (K=3, over HTTP)', async () => {
    assert.deepEqual(await routed(3), byOwner(3));
  });
  it('control: a sender whose owner is off by one ordinal is detected', async () => {
    const shifted = (tenant, k) => (slice.bucket(tenant, k) + 1) % k;
    assert.notDeepEqual(await routed(3, shifted), byOwner(3));
  });
});

describe('internal hints v1: receiver', () => {
  async function serve (receiver) {
    const server = http.createServer((req, res) => { if (!receiver.handle(req, res)) { res.writeHead(418); res.end(); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const post = (path, body, method = 'POST') => new Promise((resolve, reject) => {
      const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, agent: false,
        headers: { 'content-type': 'application/json', 'content-length': bytes.length } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end(bytes);
    });
    return { post, close: () => new Promise(resolve => server.close(resolve)) };
  }
  const T = TENANTS[0];

  it('ignores an unknown field, keeps the known ones, and answers 202', async () => {
    const got = [];
    const receiver = hints.receiver.create({ handlers: { changed: (tenant, hint) => got.push([tenant, hint]) } });
    const peer = await serve(receiver);
    try {
      const status = await peer.post('/internal/v1/tenants/' + T + '/changed',
        { stamp: 42, domains: ['entries', 'treatments'], generation: '7', addedInV1_3: { anything: [1, 2] }, priority: 'high' });
      assert.equal(status, 202);
      assert.deepEqual(got, [[T, { stamp: 42, domains: ['entries', 'treatments'], generation: '7' }]]);
    } finally { await peer.close(); }
  });

  it('widens rather than refuses: an unknown domain name or a mistyped known field means "anything may have changed"', async () => {
    const got = [];
    const receiver = hints.receiver.create({ handlers: { changed: (tenant, hint) => got.push(hint) } });
    const peer = await serve(receiver);
    try {
      assert.equal(await peer.post('/internal/v1/tenants/' + T + '/changed', { domains: ['entries', 'a_future_domain'] }), 202);
      assert.equal(await peer.post('/internal/v1/tenants/' + T + '/changed', { stamp: '42', generation: 7 }), 202);
      assert.equal(await peer.post('/internal/v1/tenants/' + T + '/changed', ''), 202);
      assert.deepEqual(got, [{}, {}, {}]);
    } finally { await peer.close(); }
  });

  it('control: the existing strict convention (additionalProperties:false) refuses the same unknown field', () => {
    const request = contracts.completedOutput.operations.hintCompletedOutput.request;
    validate(request, { tenants: [T] });
    assert.throws(() => validate(request, { tenants: [T], addedLater: true }), /INTERNAL_API_SCHEMA_REFUSED/);
  });

  it('answers 404 for another version or kind, 400 for a malformed tenant, 413 over the bound, 421 off-slice, 503 not ready; other paths fall through', async () => {
    let ready = true;
    const receiver = hints.receiver.create({ handlers: { changed: () => {} }, owns: tenant => tenant === T, ready: () => ready });
    const peer = await serve(receiver);
    try {
      assert.equal(await peer.post('/internal/v2/tenants/' + T + '/changed', {}), 404);
      assert.equal(await peer.post('/internal/v1/tenants/' + T + '/storage-events', {}), 404);
      assert.equal(await peer.post('/internal/v1/tenants/NOT-A-UUID/changed', {}), 400);
      assert.equal(await peer.post('/internal/v1/tenants/' + T + '/changed', '[1]'), 400);
      assert.equal(await peer.post('/internal/v1/tenants/' + T + '/changed', { pad: 'x'.repeat(5000) }), 413);
      assert.equal(await peer.post('/internal/v1/tenants/' + TENANTS[1] + '/changed', {}), 421);
      ready = false;
      assert.equal(await peer.post('/internal/v1/tenants/' + T + '/changed', {}), 503);
      assert.equal(await peer.post('/completed-output/hint', {}), 418);
    } finally { await peer.close(); }
  });

  it('storage-events and output-changed normalize, bound and merge without depending on order', () => {
    const c = hints.contract;
    const doc = { identifier: 'synthetic-1', name: 'apple', carbs: 10, srvModified: 1 };
    assert.deepEqual(c.normalize('storage-events', { stamp: 4, events: [{ collection: 'food', op: 'create', doc, later: 1 }, { collection: 'food', op: 'update' }] }),
      { stamp: 4, events: [{ collection: 'food', op: 'create', doc }, { collection: 'food', op: 'changed', collapsed: true }] });
    const many = Array.from({ length: c.MAX_EVENTS + 1 }, (_, i) => ({ collection: i % 2 ? 'entries' : 'treatments', op: 'create', doc: { i } }));
    const collapsed = [{ collection: 'entries', op: 'changed', collapsed: true }, { collection: 'treatments', op: 'changed', collapsed: true }];
    assert.deepEqual(c.normalize('storage-events', { events: many }).events, collapsed);
    // Over the byte bound the documents go, the collections stay.
    const big = c.normalize('storage-events', { events: [0, 1, 2].map(i => ({ collection: i ? 'entries' : 'treatments', op: 'create', doc: { pad: 'x'.repeat(100000) } })) });
    assert.equal(big.events.length, 3);
    assert.deepEqual(c.fit('storage-events', big).events, collapsed);
    assert.equal(c.fit('storage-events', { events: [{ collection: 'food', op: 'create', doc }] }).events[0].doc, doc);
    const a = c.normalize('changed', { stamp: 3, domains: ['entries'], generation: '2' });
    const b = c.normalize('changed', { stamp: 9, domains: ['profile'], generation: '10' });
    const all = c.normalize('changed', { stamp: 1 });
    assert.deepEqual(c.merge('changed', a, b), { stamp: 9, domains: ['entries', 'profile'], generation: '10' });
    assert.deepEqual(c.merge('changed', a, b), c.merge('changed', b, a));
    assert.deepEqual(c.merge('changed', c.merge('changed', a, b), all), c.merge('changed', a, c.merge('changed', b, all)));
    assert.deepEqual(c.merge('changed', a, all), { stamp: 3, generation: '2' });
    assert.deepEqual(c.merge('output-changed', { revision: '5' }, { revision: '12' }), { revision: '12' });
  });
});

describe('internal hints v1: the sender never affects the write', () => {
  // A write as the api's seam would do it: commit, then send, then answer.
  const write = sender => async tenant => { const committed = { ok: true, tenant }; sender.changed(tenant, { stamp: 1 }); return committed; };

  let unhandled;
  const onUnhandled = error => { unhandled.push(error); };
  beforeEach(() => { unhandled = []; process.on('unhandledRejection', onUnhandled); });
  afterEach(() => { process.removeListener('unhandledRejection', onUnhandled); });

  for (const [status, counter] of [[404, 'notFound'], [503, 'notReady'], [500, 'rejected']]) {
    it('swallows a ' + status + ' and the write answers unchanged', async () => {
      const peers = await receivers(1, () => status);
      const sender = hints.sender.create({ targets: { evaluator: { count: 1, address: peers.address } } });
      try {
        const result = await write(sender)(TENANTS[0]);
        assert.deepEqual(result, { ok: true, tenant: TENANTS[0] });
        await until(() => sender.stats()[counter] === 1);
        assert.equal(unhandled.length, 0);
      } finally { await sender.close(); await peers.close(); }
    });
  }

  it('does not wait for a receiver that never answers, nor for a name that does not resolve', async () => {
    const peers = await receivers(1, () => null);
    const sender = hints.sender.create({ timeoutMs: 100, targets: {
      evaluator: { count: 1, address: peers.address },
      realtime: { count: 1, address: () => ({ url: 'http://realtime-7.realtime-peers.invalid:19003/' }) } } });
    try {
      const started = process.hrtime.bigint();
      const result = await write(sender)(TENANTS[0]);
      sender.storageEvents(TENANTS[0], { events: [{ collection: 'entries', op: 'create', doc: { sgv: 100 } }] });
      assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 50, 'the write returned without waiting');
      assert.deepEqual(result, { ok: true, tenant: TENANTS[0] });
      await until(() => sender.stats().timeout === 1 && sender.stats().unreachable === 1);
      assert.equal(unhandled.length, 0);
    } finally { await sender.close(); await peers.close(); }
  });

  it('control: an awaited sender that throws on a non-2xx fails the write', async () => {
    const peers = await receivers(1, () => 503);
    const naive = { changed: tenant => new Promise((resolve, reject) => {
      const req = http.request(peers.rows[0].url + 'internal/v1/tenants/' + tenant + '/changed', { method: 'POST', agent: false }, res => {
        res.resume(); res.on('end', () => res.statusCode === 202 ? resolve() : reject(new Error('HINT_' + res.statusCode)));
      });
      req.on('error', reject); req.end('{}');
    }) };
    const awaitedWrite = async tenant => { await naive.changed(tenant); return { ok: true }; };
    try { await assert.rejects(awaitedWrite(TENANTS[0]), /HINT_503/); } finally { await peers.close(); }
  });

  it('refuses a bad tenant or kind by counting, never by throwing', () => {
    const sender = hints.sender.create({ targets: { evaluator: { local: () => {} } } });
    assert.equal(sender.changed('Not-A-Tenant', {}), undefined);
    assert.equal(sender.send('unknown-kind', TENANTS[0], {}), undefined);
    assert.equal(sender.storageEvents(TENANTS[0], {}), undefined); // realtime not configured
    assert.deepEqual([sender.stats().refused, sender.stats().unconfigured], [2, 1]);
  });
});

describe('internal hints v1: merging and bounds', () => {
  it('merges per tenant while a request is in flight: ten hints become two requests', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    let first = true;
    const peers = await receivers(1, () => 202, { hold: () => { if (first) { first = false; return gate; } } });
    const sender = hints.sender.create({ targets: { evaluator: { count: 1, address: peers.address } } });
    try {
      for (let i = 1; i <= 10; i++) sender.changed(TENANTS[0], { stamp: i, domains: [i % 2 ? 'entries' : 'profile'] });
      await until(() => peers.rows[0].seen.length === 1);
      assert.deepEqual(sender.stats().merged, 8);
      release();
      await until(() => sender.stats().accepted === 2);
      assert.deepEqual(peers.rows[0].seen.map(hit => hit.body), [{ stamp: 1, domains: ['entries'] }, { stamp: 10, domains: ['entries', 'profile'] }]);
    } finally { await sender.close(); await peers.close(); }
  });

  it('keeps at most maxInFlight requests per peer and drops beyond maxWaiting', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const peers = await receivers(1, () => 202, { hold: () => gate });
    const sender = hints.sender.create({ maxInFlight: 2, maxWaiting: 5, targets: { evaluator: { count: 1, address: peers.address } } });
    try {
      for (const tenant of TENANTS.slice(0, 10)) sender.changed(tenant, {});
      await until(() => peers.rows[0].seen.length === 2);
      assert.deepEqual([sender.stats().inflight, sender.stats().waiting, sender.stats().dropped], [2, 5, 3]);
      release();
      await until(() => sender.stats().accepted === 7);
      assert.equal(peers.rows[0].peak, 2);
    } finally { await sender.close(); await peers.close(); }
  });
});

describe('internal hints v1: one process', () => {
  it('calls the local handler off the caller\'s stack, and a throwing handler does not reach the writer', async () => {
    const calls = [];
    const sender = hints.sender.create({ targets: { evaluator: { local: (kind, tenant, hint) => { calls.push([kind, tenant, hint]); throw new Error('boom'); } } } });
    sender.changed(TENANTS[0], { stamp: 5, extra: true });
    assert.equal(calls.length, 0, 'not called synchronously inside the commit callback');
    await until(() => sender.stats().rejected === 1);
    assert.deepEqual(calls, [['changed', TENANTS[0], { stamp: 5 }]]);
    assert.equal(sender.stats().local, 1);
    await sender.close();
  });

  it('a process that is one slice of K calls itself for its own tenants and HTTP for the others', async () => {
    const peers = await receivers(2);
    const local = [];
    const sender = hints.sender.create({ targets: { evaluator: { count: 2, ordinal: 0, local: (kind, tenant) => local.push(tenant), address: peers.address } } });
    try {
      for (const tenant of TENANTS.slice(0, 40)) sender.changed(tenant, {});
      await until(() => sender.stats().accepted === 40);
      assert.deepEqual(local.sort(), TENANTS.slice(0, 40).filter(t => slice.bucket(t, 2) === 0).sort());
      assert.equal(peers.rows[0].seen.length, 0);
      assert.deepEqual(peers.rows[1].seen.map(hit => hit.tenant).sort(), TENANTS.slice(0, 40).filter(t => slice.bucket(t, 2) === 1).sort());
    } finally { await sender.close(); await peers.close(); }
  });
});

describe('internal hints v1: targets from the environment', () => {
  const env = hints.targets.fromEnvironment;
  it('K=1 uses the role\'s internal address; K>1 the headless Service template; the realtime roster is honoured', () => {
    const one = env({ NS_EVALUATOR_INTERNAL_URL: 'http://evaluator-internal:19002/', XDG_RUNTIME_DIR: '/run/user/1' });
    assert.deepEqual([one.evaluator.count, one.evaluator.address(0)], [1, { url: 'http://evaluator-internal:19002/' }]);
    assert.deepEqual(one.realtime.address(0), { socketPath: '/run/user/1/nightscout/realtime.sock' });
    const k = env({ NS_EVALUATOR_SLICES: '3', NS_EVALUATOR_SLICE_URL: 'http://evaluator-{i}.evaluator:19002/',
      NS_REALTIME_SLICE_PEERS: JSON.stringify([{ url: 'http://realtime-0.realtime-peers.ns.svc:19003/' }, { url: 'http://realtime-1.realtime-peers.ns.svc:19003/' }]) });
    assert.deepEqual([0, 1, 2].map(k.evaluator.address), [0, 1, 2].map(i => ({ url: 'http://evaluator-' + i + '.evaluator:19002/' })));
    assert.equal(k.realtime.count, 2);
    const sender = hints.sender.create({ targets: k });
    assert.equal(typeof sender.send, 'function');
    for (const bad of [{ NS_EVALUATOR_SLICES: '2' }, { NS_EVALUATOR_SLICES: '2', NS_EVALUATOR_SLICE_URL: 'http://evaluator:19002/' },
      { NS_EVALUATOR_SLICES: '0' }, { NS_REALTIME_SLICES: '3', NS_REALTIME_SLICE_PEERS: '[{"url":"http://r:1/"}]' }]) assert.throws(() => env(bad), /internal hints/);
    assert.throws(() => hints.sender.create({ targets: env({ NS_EVALUATOR_SLICES: '2', NS_EVALUATOR_SLICE_URL: 'http://evaluator-{i}.evaluator/' }) }), /http:\/\/host:port/);
  });
});
