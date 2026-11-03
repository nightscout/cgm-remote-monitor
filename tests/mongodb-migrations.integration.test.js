'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync, fork, spawnSync } = require('node:child_process');
const path = require('node:path');
const { MongoClient } = require('mongodb');
const { run } = require('../lib/migrations/mongodb');
const { checksum } = require('../lib/migrations/catalogue');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const catalogue = (...steps) => ({
  version: 1, backend: 'mongodb',
  migrations: steps.map((up, i) => ({ name: String(i + 1).padStart(4, '0') + '_test',
    transactional: true, up, checksum: checksum(up) }))
});
const step = (from, to) => ({ collection: 'samples', filter: { kind: from }, set: { kind: to } });

(process.env.NS_MIGRATION_MONGO_DOCKER_TEST === '1' ? describe : describe.skip)('operator MongoDB migrations (disposable replica set)', function () {
  this.timeout(40000);
  const name = 'ns-mongo-migrations-' + crypto.randomBytes(8).toString('hex');
  const password = crypto.randomBytes(24).toString('hex');
  let owned = false;
  let connectionString;
  let observer;
  let db;
  let sequence = 0;
  let shell;
  const opts = cat => ({ direct: true, connectionString, namespace: 'test_' + (++sequence),
    catalogue: cat, leaseMs: 1200, waitMs: 15000 });
  const workerFile = path.join(__dirname, 'fixtures/migrations/mongo-worker.js');
  const workers = new Set();

  async function eventually (fn, timeout = 15000) {
    const deadline = Date.now() + timeout;
    do {
      if (await fn()) return;
      await sleep(30);
    } while (Date.now() < deadline);
    throw new Error('test condition did not become true before deadline');
  }

  async function connectObserver () {
    if (observer) await observer.close();
    const port = docker(['port', name, '27017/tcp']).split(':').pop();
    connectionString = 'mongodb://operator:' + password + '@127.0.0.1:' + port + '/migrations?authSource=admin';
    observer = await new MongoClient(connectionString, { directConnection: true, serverSelectionTimeoutMS: 15000 }).connect();
    db = observer.db('migrations');
    await eventually(async () => (await db.admin().command({ hello: 1 })).isWritablePrimary);
  }

  function worker (o, pause) {
    const child = fork(workerFile, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    workers.add(child);
    const messages = [];
    child.on('message', message => messages.push(message));
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => { workers.delete(child); resolve({ code, signal }); });
    });
    child.send({ opts: o, pause });
    return { child, messages, exited };
  }

  before(async function () {
    execFileSync('docker', ['run', '--rm', '--name', name, '-d', '-p', '127.0.0.1::27017',
      '--ulimit', 'nofile=64000:64000', '-e', 'NS_TEST_REPL_KEY',
      process.env.NS_MIGRATION_MONGO_IMAGE || 'mongo:8.0.34', 'bash', '-c',
      'printf "%s" "$NS_TEST_REPL_KEY" > /tmp/ns-repl-key; chmod 600 /tmp/ns-repl-key; chown mongodb /tmp/ns-repl-key; exec docker-entrypoint.sh mongod --replSet ns_migrations --bind_ip_all --keyFile /tmp/ns-repl-key --setParameter transactionLifetimeLimitSeconds=5'],
    { env: { ...process.env, NS_TEST_REPL_KEY: crypto.randomBytes(48).toString('base64') }, stdio: ['ignore', 'pipe', 'pipe'] });
    owned = true;
    shell = docker(['exec', name, 'sh', '-c', 'command -v mongosh || command -v mongo']);
    await eventually(async () => {
      const result = spawnSync('docker', ['exec', name, shell, '--quiet', '--eval',
        'try { rs.initiate({_id:"ns_migrations",members:[{_id:0,host:"127.0.0.1:27017"}]}) } catch(e) { if(e.code !== 23) throw e }'],
      { encoding: 'utf8', timeout: 5000 });
      return result.status === 0;
    });
    await eventually(async () => {
      const result = spawnSync('docker', ['exec', name, shell, '--quiet', '--eval',
        'if (!db.hello().isWritablePrimary) quit(2)'], { encoding: 'utf8', timeout: 5000 });
      return result.status === 0;
    });
    execFileSync('docker', ['exec', '-i', name, shell, '--quiet'], {
      input: 'db.getSiblingDB("admin").createUser({user:"operator",pwd:"' + password + '",roles:["root"]})\n',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    await connectObserver();
    const info = await db.admin().command({ buildInfo: 1 });
    console.log('    MongoDB acceptance server: ' + info.version);
    assert.equal((await db.admin().command({ hello: 1 })).setName, 'ns_migrations');
  });

  after(async function () {
    try {
      await Promise.all([...workers].map(child => new Promise(resolve => {
        child.once('exit', resolve);
        child.kill('SIGKILL');
      })));
      if (observer) await observer.close();
    } finally { if (owned) docker(['rm', '-f', name]); }
  });

  beforeEach(async function () {
    await db.collection('samples').deleteMany({});
    await db.collection('samples').insertOne({ _id: 'sample', kind: 'old' });
  });

  it('inspects without creating metadata and atomically applies idempotent data and ledger', async function () {
    const o = opts(catalogue([step('old', 'new')]));
    assert.deepEqual(await run('status', o), { current: false, applied: [], pending: ['0001_test'] });
    await assert.rejects(run('check', o), /schema is stale/);
    assert.deepEqual(await db.listCollections({ name: o.namespace + '_migration_state' }).toArray(), []);
    assert.deepEqual((await run('up', o)).done, ['0001_test']);
    assert.equal((await db.collection('samples').findOne({ _id: 'sample' })).kind, 'new');
    assert.deepEqual((await run('up', o)).done, []);
    assert.equal((await run('check', o)).current, true);
  });

  it('runs the explicit MongoDB CLI and redacts connection details', function () {
    const o = opts(catalogue([step('old', 'new')]));
    const result = spawnSync(process.execPath, ['bin/nightscout.js', 'migrate', 'up', '--backend', 'mongodb',
        '--namespace', o.namespace, '--catalogue', 'tests/fixtures/migrations/mongo-test.json', '--connection-env', 'NS_TEST_OPERATOR_URL', '--direct'],
      { cwd: path.resolve(__dirname, '..'), env: { ...process.env, NS_TEST_OPERATOR_URL: connectionString },
        encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).done, ['0001_test']);
    assert.equal((result.stdout + result.stderr).includes(password), false);
    assert.doesNotMatch(result.stdout + result.stderr, /mongodb:\/\/|127\.0\.0\.1/);
  });

  it('refuses standalone before creating runner metadata or touching data', async function () {
    const standalone = name + '-standalone';
    let active = false;
    let client;
    try {
      execFileSync('docker', ['run', '--rm', '--name', standalone, '-d', '-p', '127.0.0.1::27017',
        '--ulimit', 'nofile=64000:64000', '-e', 'MONGO_INITDB_ROOT_USERNAME=operator',
        '-e', 'MONGO_INITDB_ROOT_PASSWORD', process.env.NS_MIGRATION_MONGO_IMAGE || 'mongo:8.0.34'],
      { env: { ...process.env, MONGO_INITDB_ROOT_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
      active = true;
      const port = docker(['port', standalone, '27017/tcp']).split(':').pop();
      const uri = 'mongodb://operator:' + password + '@127.0.0.1:' + port + '/migrations?authSource=admin';
      client = new MongoClient(uri, { directConnection: true, serverSelectionTimeoutMS: 15000 });
      await client.connect();
      const o = { ...opts(catalogue([step('old', 'new')])), connectionString: uri };
      for (const action of ['up', 'status', 'check']) await assert.rejects(run(action, o), /replica-set primary/);
      assert.deepEqual(await client.db('migrations').listCollections().toArray(), []);
    } finally {
      try { if (client) await client.close(); } finally { if (active) docker(['rm', '-f', standalone]); }
    }
  });

  it('allows a read-only checker but refuses mutations and missing collections', async function () {
    const o = opts(catalogue([step('old', 'new')]));
    await run('up', o);
    await db.admin().command({ createUser: 'checker', pwd: password, roles: [{ role: 'read', db: 'migrations' }] });
    const readonly = { ...o, connectionString: connectionString.replace('operator:', 'checker:') };
    assert.equal((await run('check', readonly)).current, true);
    await assert.rejects(run('up', readonly), /not authorized/);
    const absent = opts(catalogue([{ ...step('old', 'new'), collection: 'missing' }]));
    await assert.rejects(run('up', absent), /must already exist/);
    assert.deepEqual((await run('status', absent)).applied, []);
  });

  it('refuses on actual database outage rather than using earlier successful state', async function () {
    const o = opts(catalogue([step('old', 'new')]));
    await run('up', o);
    docker(['pause', name]);
    try {
      await assert.rejects(run('check', o), /timed out|timeout|selection/i);
    } finally { docker(['unpause', name]); }
    assert.equal((await run('check', o)).current, true);
  });

  it('renews a live lease while another runner waits, then commits exactly once', async function () {
    const o = opts(catalogue([step('old', 'new')]));
    const first = worker(o, 'before-fence');
    await eventually(() => first.messages.some(m => m.checkpoint === 'before-fence'));
    const state = db.collection(o.namespace + '_migration_state');
    const initial = await state.findOne({ _id: 'lease' });
    await sleep(o.leaseMs * 2);
    const renewed = await state.findOne({ _id: 'lease' });
    assert.equal(renewed.epoch, initial.epoch);
    assert.ok(renewed.expiresAt > initial.expiresAt);
    await assert.rejects(run('up', { ...o, waitMs: 150 }), /lease deadline/);
    const contenders = [run('up', o), run('up', o), run('up', o)];
    first.child.send('continue');
    assert.equal((await first.exited).code, 0);
    assert.equal(first.messages.find(m => m.result).result.done.length, 1);
    assert.deepEqual((await Promise.all(contenders)).map(s => s.done.length), [0, 0, 0]);
    assert.equal(await db.collection(o.namespace + '_schema_migrations').countDocuments(), 1);
  });

  it('refuses an expired renewal after real server pause without reacquiring or attempting data', async function () {
    const o = opts(catalogue([step('old', 'new')]));
    const holder = worker(o, 'before-fence');
    await eventually(() => holder.messages.some(m => m.checkpoint === 'before-fence'));
    const state = db.collection(o.namespace + '_migration_state');
    const original = await state.findOne({ _id: 'lease' });
    const observed = holder.messages.length;
    docker(['pause', name]);
    try { await sleep(o.leaseMs * 2); } finally { docker(['unpause', name]); }
    await eventually(() => holder.messages.slice(observed).some(m => m.renewalMatched !== undefined));
    assert.equal(holder.messages.slice(observed).find(m => m.renewalMatched !== undefined).renewalMatched, 0);
    holder.child.send('continue');
    await holder.exited;
    assert.equal(holder.messages.find(m => m.error).error, 'MIG_LOCK_LOST');
    assert.equal(holder.messages.some(m => m.result || m.dataAttempt), false);
    assert.equal((await state.findOne({ _id: 'lease' })).epoch, original.epoch);
    assert.equal(await db.collection(o.namespace + '_schema_migrations').countDocuments(), 0);
    assert.equal((await db.collection('samples').findOne({ _id: 'sample' })).kind, 'old');
    const retry = worker(o);
    await retry.exited;
    assert.deepEqual(retry.messages.find(m => m.result).result.done, ['0001_test']);
    assert.ok((await state.findOne({ _id: 'lease' })).epoch > original.epoch);
    assert.equal((await db.collection('samples').findOne({ _id: 'sample' })).kind, 'new');
  });

  it('fences a SIGSTOPed stale worker after expiry and successor takeover', async function () {
    const o = opts(catalogue([step('old', 'new')]));
    const stale = worker(o, 'after-lease');
    await eventually(() => stale.messages.some(m => m.checkpoint === 'after-lease'));
    const state = db.collection(o.namespace + '_migration_state');
    const original = await state.findOne({ _id: 'lease' });
    stale.child.kill('SIGSTOP');
    await sleep(o.leaseMs * 2);
    const successor = await run('up', o);
    assert.deepEqual(successor.done, ['0001_test']);
    const after = await state.findOne({ _id: 'lease' });
    assert.ok(after.epoch > original.epoch);
    // Distinguish stale data replay from a harmless idempotent re-run.
    await db.collection('samples').updateOne({ _id: 'sample' }, { $set: { kind: 'old' } });
    stale.child.send('continue');
    stale.child.kill('SIGCONT');
    await stale.exited;
    assert.equal(stale.messages.find(m => m.error).error, 'MIG_LOCK_LOST');
    assert.equal(stale.messages.some(m => m.dataAttempt), false);
    assert.equal((await db.collection('samples').findOne({ _id: 'sample' })).kind, 'old');
    assert.equal((await state.findOne({ _id: 'lease' })).epoch, after.epoch);
    assert.equal(await db.collection(o.namespace + '_schema_migrations').countDocuments(), 1);
  });

  it('rolls back data and ledger after real SIGKILL, then resumes in a new process', async function () {
    const o = opts(catalogue([step('old', 'new')]));
    const killed = worker(o, 'after-data');
    await eventually(() => killed.messages.some(m => m.checkpoint === 'after-data'));
    assert.equal((await db.collection('samples').findOne({ _id: 'sample' })).kind, 'old');
    assert.equal(await db.collection(o.namespace + '_schema_migrations').countDocuments(), 0);
    killed.child.kill('SIGKILL');
    assert.equal((await killed.exited).signal, 'SIGKILL');
    const retry = worker(o);
    assert.equal((await retry.exited).code, 0);
    assert.deepEqual(retry.messages.find(m => m.result).result.done, ['0001_test']);
    assert.equal((await db.collection('samples').findOne({ _id: 'sample' })).kind, 'new');
    assert.equal(await db.collection(o.namespace + '_schema_migrations').countDocuments(), 1);
  });

  it('does not let takeover commit across an active fenced transaction', async function () {
    const o = opts(catalogue([step('old', 'new')]));
    const first = worker(o, 'after-data');
    await eventually(() => first.messages.some(m => m.checkpoint === 'after-data'));
    first.child.kill('SIGSTOP');
    await sleep(o.leaseMs * 2);
    await assert.rejects(run('up', { ...o, waitMs: 200 }), /lease deadline/);
    assert.equal(await db.collection(o.namespace + '_schema_migrations').countDocuments(), 0);
    // The test server bounds abandoned transactions to five seconds.
    first.child.send('continue');
    first.child.kill('SIGCONT');
    await first.exited;
    const result = await run('up', o);
    assert.equal(result.current, true);
    assert.equal(await db.collection(o.namespace + '_schema_migrations').countDocuments(), 1);
    assert.equal((await db.collection('samples').findOne({ _id: 'sample' })).kind, 'new');
  });

  it('preserves a committed migration across SIGKILL and a new-process retry', async function () {
    const o = opts(catalogue([step('old', 'new')]));
    const committed = worker(o, 'after-commit');
    await eventually(() => committed.messages.some(m => m.checkpoint === 'after-commit'));
    const ledger = db.collection(o.namespace + '_schema_migrations');
    const row = await ledger.findOne({ _id: '0001_test' });
    assert.ok(row);
    committed.child.kill('SIGKILL');
    assert.equal((await committed.exited).signal, 'SIGKILL');
    const retry = worker(o);
    await retry.exited;
    assert.deepEqual(retry.messages.find(m => m.result).result.done, []);
    assert.deepEqual(await ledger.findOne({ _id: '0001_test' }), row);
    assert.equal((await db.collection('samples').findOne({ _id: 'sample' })).kind, 'new');
  });

  for (const committed of [false, true]) {
    it('recovers ' + (committed ? 'committed' : 'uncommitted') + ' migration state after actual primary SIGKILL/restart', async function () {
      const o = opts(catalogue([step('old', 'new')]));
      const checkpoint = committed ? 'after-commit' : 'after-data';
      const interrupted = worker(o, checkpoint);
      await eventually(() => interrupted.messages.some(m => m.checkpoint === checkpoint));
      const ledgerName = o.namespace + '_schema_migrations';
      const before = await db.collection(ledgerName).findOne({ _id: '0001_test' });
      assert.equal(Boolean(before), committed);
      const oldPid = docker(['inspect', '--format', '{{.State.Pid}}', name]);
      assert.notEqual(oldPid, '0');
      docker(['restart', '--signal', 'SIGKILL', name]);
      assert.notEqual(docker(['inspect', '--format', '{{.State.Pid}}', name]), oldPid);
      interrupted.child.kill('SIGKILL');
      assert.equal((await interrupted.exited).signal, 'SIGKILL');
      await connectObserver();
      assert.deepEqual(await db.collection(ledgerName).findOne({ _id: '0001_test' }), before);
      assert.equal((await db.collection('samples').findOne({ _id: 'sample' })).kind, committed ? 'new' : 'old');
      const retry = worker({ ...o, connectionString });
      assert.equal((await retry.exited).code, 0);
      assert.deepEqual(retry.messages.find(m => m.result).result.done, committed ? [] : ['0001_test']);
      assert.equal((await db.collection('samples').findOne({ _id: 'sample' })).kind, 'new');
      assert.equal(await db.collection(ledgerName).countDocuments(), 1);
      if (committed) assert.deepEqual(await db.collection(ledgerName).findOne({ _id: '0001_test' }), before);
    });
  }

  it('rejects drift, unknown and non-prefix history before applying data', async function () {
    const o = opts(catalogue([step('old', 'middle')], [step('middle', 'new')]));
    await run('up', o);
    const changed = { ...o, catalogue: catalogue([step('old', 'changed')], [step('middle', 'new')]) };
    for (const action of ['status', 'check', 'up']) await assert.rejects(run(action, changed), /checksum drift/);
    const ledger = db.collection(o.namespace + '_schema_migrations');
    await ledger.insertOne({ _id: '9999_unknown', checksum: '0'.repeat(64) });
    await assert.rejects(run('up', o), /unknown/);
    await ledger.deleteMany({ _id: { $in: ['9999_unknown', '0001_test'] } });
    await assert.rejects(run('up', o), /catalogue prefix/);
  });

  it('rolls data back on ledger failure and retries without losing prior migrations', async function () {
    const o = opts(catalogue([step('old', 'middle')], [step('middle', 'new')]));
    await db.createCollection(o.namespace + '_schema_migrations', {
      validator: { _id: { $ne: '0002_test' } }
    });
    await assert.rejects(run('up', o), /Migration .* failed/);
    assert.deepEqual((await run('status', o)).applied, ['0001_test']);
    assert.equal((await db.collection('samples').findOne({ _id: 'sample' })).kind, 'middle');
    await db.command({ collMod: o.namespace + '_schema_migrations', validator: {} });
    assert.deepEqual((await run('up', o)).done, ['0002_test']);
    assert.equal((await db.collection('samples').findOne({ _id: 'sample' })).kind, 'new');
  });
});
