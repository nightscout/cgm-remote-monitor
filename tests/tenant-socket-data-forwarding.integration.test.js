'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const { MongoClient } = require('mongodb');
const ioClient = require('socket.io-client');
const shiro = require('shiro-trie');
const { run } = require('../lib/migrations/postgres');
const createAuthority = require('../lib/tenant-authorization/postgres');
const createOrderPort = require('../lib/server/tenant-socket-order-port');
const scope = require('../lib/storage/tenant-scope');
const dates = require('../lib/server/srv-dates');
const { encodeDocument, decodeDocument } = require('../lib/storage/postgres-identity');
const { createExecutor } = require('../lib/server/tenant-socket-write-executor');
const { createApiReceiver, createForwarder } = require('../lib/server/tenant-socket-forwarding');
const createLab = require('./fixtures/tenant-commit-clock-port');
const { context } = require('./fixtures/socket-forwarding/recording-context');
const pattern = require('./fixtures/socket-forwarding/patterns');
const createReference = require('./fixtures/socket-forwarding/mongo-reference');
const { optInSuite } = require('./support/opt-in');

// Real Socket.IO and database pattern replay, NOT an Android binary run. The
// in-process transport and credential lookup are explicit fixture injections;
// the current PostgreSQL subject snapshot and canonical DATA write are real.
// No production transport identity or listener is chosen by this lab.
optInSuite(process.env.NS_SOCKET_DATA_FORWARDING_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI &&
  !!process.env.CUSTOMCONNSTR_mongo, 'NS_SOCKET_DATA_FORWARDING_TEST=1 with disposable PostgreSQL and MongoDB')(
  'dormant socket DATA forwarding real socket/database lab', function () {
    this.timeout(30000);
    const lab = createLab();
    const auth = 'socket_auth_' + crypto.randomBytes(8).toString('hex');
    const role = auth + '_reader';
    const database = 'socket_reference_' + crypto.randomBytes(8).toString('hex');
    const sockets = [], servers = [];
    let mongo, authority, reference, singleReference, forwarded, substitute = false, refusalObserved;
    const events = [];
    const fixtureCredential = Object.freeze({ token: 'synthetic-client' });
    const roleCredential = Object.freeze({ token: 'synthetic-role' });
    const credentials = new Map([[fixtureCredential.token, { kind: 'subject', subjectId: 'client' }],
      [roleCredential.token, { kind: 'subject', subjectId: 'role-in-foreign-tenant' }]]);
    const grants = ['api:*:read', 'api:*:create,update,delete'];
    const action = { dbAdd: 'create', dbUpdate: 'update', dbUpdateUnset: 'update', dbRemove: 'delete' };

    async function rows (tenant = lab.A, domain = 'treatments') {
      assert(['treatments', 'devicestatus'].includes(domain));
      const result = await lab.admin.query(`SELECT id_kind,doc FROM "${lab.namespaces[domain]}"."${domain}" WHERE tenant_id=$1 ORDER BY "_id",id_kind`, [tenant]);
      return result.rows.map(decodeDocument);
    }
    function norm (value, key) {
      if (value && value._bsontype === 'ObjectId') return { objectId: value.toHexString() };
      if (value instanceof Date) return { date: value.toISOString() };
      if (['srvCreated', 'srvModified'].includes(key) && typeof value === 'number' && value > 1e12) return 'server-clock';
      if (Array.isArray(value)) return value.map(v => norm(v));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, norm(v, k)]));
      return value;
    }
    const send = (socket, event, payload) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Expected socket callback missing: ' + event)), 5000);
      socket.emit(event, payload, (...args) => { clearTimeout(timer); resolve(args); });
    });
    async function client (server) {
      let port = server;
      if (typeof server !== 'number') { server.listen(0, '127.0.0.1'); await once(server, 'listening'); port = server.address().port; }
      const socket = ioClient('http://127.0.0.1:' + port, { reconnection: false, transports: ['websocket'] });
      sockets.push(socket); await once(socket, 'connect'); return socket;
    }
    before(async function () {
      await lab.open();
      for (const logical of ['treatments', 'devicestatus']) {
        await run('up', { direct: true, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI,
          namespace: lab.namespaces[logical], catalogue: createOrderPort.catalogues[logical] });
        await lab.admin.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA "${lab.namespaces[logical]}" TO "${lab.role}"`);
      }
      await run('up', { direct: true, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI,
        namespace: auth, catalogue: require('../lib/tenant-authorization/postgres-candidate.json') });
      const password = crypto.randomBytes(24).toString('hex');
      await lab.admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      await lab.admin.query(`GRANT USAGE ON SCHEMA "${auth}" TO "${role}"`);
      await lab.admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${auth}" TO "${role}"`);
      for (const [tenant, subject] of [[lab.A, 'client'], [lab.B, 'role-in-foreign-tenant']]) {
        await lab.admin.query(`INSERT INTO "${auth}".tenant_authorization_config VALUES($1,ARRAY['denied'])`, [tenant]);
        await lab.admin.query(`INSERT INTO "${auth}".tenant_authorization_subjects VALUES($1,$2,'Synthetic Socket')`, [tenant, subject]);
        await lab.admin.query(`INSERT INTO "${auth}".tenant_authorization_roles VALUES($1,'writer',$2)`, [tenant, grants]);
        await lab.admin.query(`INSERT INTO "${auth}".tenant_authorization_subject_roles VALUES($1,$2,'writer')`, [tenant, subject]);
      }
      const uri = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI); uri.username = role; uri.password = password;
      authority = await createAuthority({ connectionString: uri.toString(), namespace: auth });
      mongo = new MongoClient(process.env.CUSTOMCONNSTR_mongo); await mongo.connect();
      const fixture = context();
      singleReference = await createReference({ connectionString: process.env.CUSTOMCONNSTR_mongo, database });
      assert.equal(scope.getTenancyMode(), 'multi', 'parent stays multitenant while reference child is single');
      reference = await client(singleReference.port);
      await send(reference, 'authorize', pattern.authorization());
      const env = fixture.env, bus = new EventEmitter();
      bus.on('storage-intent-committed', event => events.push(event));
      const ports = Object.fromEntries(await Promise.all(['treatments', 'devicestatus'].map(async logical => [logical, await createOrderPort({
        readinessConnectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI, namespace: lab.namespaces[logical],
        connection: lab.clocks[0], logical, env, bus })])));
      const ctx = { ...fixture.ctx, bus, store: { collection: () => { throw new Error('Realtime/Mongo write forbidden'); } },
        storagePorts: { resolve: ({ logical, source }) => {
          assert(['treatments', 'devicestatus'].includes(logical)); assert.equal(source, 'socket');
          return { storage: ports[logical].storage, intentFactory: () => ports[logical] };
        } } };
      const executeWrite = createExecutor({ contextForOperation: operation => ({ env, ctx,
        authorizationFor: () => operation.actor.permissions }) });
      const receive = createApiReceiver({ authenticateTransport: async request => request === transportIdentity,
        resolveTenant: async () => lab.A, authorizeSocket: async ({ tenant, credential, event }) => {
          const principal = credentials.get(credential.token);
          if (!principal) return null;
          const snapshot = await authority.subjectSnapshot({ tenant, principal });
          if (!snapshot) { if (refusalObserved) refusalObserved(); return null; }
          const tries = snapshot.permissionGroups.map(group => { const trie = shiro.new(); trie.add(group); return trie; });
          const check = permission => tries.some(trie => trie.check(permission));
          if (!check('api:treatments:' + action[event])) return null;
          return { tenant, permissions: { read: check('api:*:read'), write: check('api:*:create,update,delete'),
            write_treatment: check('api:treatments:create,update,delete') } };
        }, executeWrite });
      const transportIdentity = Object.freeze({ fixture: true });
      const forwarder = createForwarder({ contextForSocket: () => ({ tenant: lab.A,
        credential: substitute ? roleCredential : fixtureCredential }), transport: envelope => receive(transportIdentity, envelope) });
      const server = http.createServer();
      const io = require('socket.io')({}).listen(server, { allowEIO3: true });
      io.on('connection', socket => forwarder.bind(socket, '/'));
      servers.push({ server, io }); forwarded = await client(server);
    });
    beforeEach(async function () {
      await lab.reset();
      await singleReference.reset();
      events.length = 0;
    });
    afterEach(function () { singleReference.assertHealthy(); });
    after(async function () {
      for (const socket of sockets) socket.disconnect();
      for (const resource of servers) {
        if (resource.bus) resource.bus.emit('teardown');
        if (resource.io) await new Promise(resolve => resource.io.close(resolve));
        if (resource.server.listening) await new Promise(resolve => resource.server.close(resolve));
      }
      try {
        if (singleReference) { await singleReference.close(); singleReference.assertHealthy(); }
        if (mongo) { await mongo.db(database).dropDatabase();
          assert.equal((await mongo.db(database).listCollections().toArray()).length, 0); await mongo.close(); }
        if (authority) await authority.close();
        if (lab.admin) {
          await lab.admin.query(`DROP SCHEMA IF EXISTS "${auth}" CASCADE`);
          await lab.admin.query(`DROP ROLE IF EXISTS "${role}"`);
          assert.equal((await lab.admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [auth])).rowCount, 0);
        }
      } finally { await lab.close(); }
    });
    it('matches same-head single Mongo acknowledgements and typed stored values for pinned treatment retry/update/unset/remove', async function () {
      const treatment = pattern.addTreatment(); treatment.data._id = 'synthetic-stable-id';
      let id;
      const steps = [['dbAdd', () => structuredClone(treatment)], ['dbAdd', () => structuredClone(treatment)],
        ['dbUpdate', () => pattern.updateTreatment(id)],
        ['dbUpdateUnset', () => ({ collection: 'treatments', _id: id, data: { notes: true } })],
        ['dbRemove', () => ({ collection: 'treatments', _id: id })],
        ['dbAdd', () => { const value = pattern.addDeviceStatus(); value.data._id = 'synthetic-device'; return value; }]];
      for (const [index, [event, payload]] of steps.entries()) {
        const expected = await send(reference, event, payload());
        const actual = await send(forwarded, event, payload());
        assert.deepEqual(norm(actual), norm(expected), 'callback parity at ' + event);
        if (index === 0) id = pattern.addedId(actual);
        const stored = await rows();
        for (const domain of ['treatments', 'devicestatus']) {
          assert.deepEqual(norm(await rows(lab.A, domain)), norm(await mongo.db(database).collection(domain).find({}).toArray()), 'stored parity at ' + event + '/' + domain);
          assert.deepEqual(await rows(lab.B, domain), [], 'foreign tenant unchanged');
        }
        if (index < 4) assert.equal(stored.length, 1, 'retried add has one logical row');
      }
      assert(events.length >= 6); assert(events.every(event => event.source === 'socket'));
      assert(await lab.floor(lab.A) > lab.initial, 'socket writes use the durable tenant clock');
      // Characterize only this unindexed Mongo reference's fresh insertion order.
      // Reverse lexical IDs make an arbitrary _id sort choose the wrong record.
      await lab.admin.query(`TRUNCATE "${lab.namespaces.treatments}".treatments`);
      await mongo.db(database).collection('treatments').deleteMany({});
      let seeded;
      await scope.withTenant(lab.A, () => lab.clocks[0].transaction(async () => {
        const stamp = dates.next();
        seeded = ['z-inserted-first', 'a-inserted-second'].map((_id, index) => ({
          ...pattern.addTreatment().data, _id, notes: 'synthetic-choice-' + index,
          srvCreated: stamp, srvModified: stamp
        }));
        for (const doc of seeded) {
          const encoded = encodeDocument(doc);
          await lab.raw[0].query(`INSERT INTO "${lab.namespaces.treatments}".treatments(tenant_id,id_kind,doc) VALUES($1,$2,$3::jsonb)`,
            [lab.A, encoded.id_kind, JSON.stringify(encoded.doc)]);
        }
      }));
      await mongo.db(database).collection('treatments').insertMany(structuredClone(seeded));
      const beforeMatches = await rows();
      for (let attempt = 0; attempt < 2; attempt++) {
        const submitted = pattern.addTreatment(); submitted.data._id = 'synthetic-unmatched-attempt';
        const expected = await send(reference, 'dbAdd', structuredClone(submitted));
        assert.equal(pattern.addedId(expected), 'z-inserted-first', 'actual Mongo reference selects first fresh insertion');
        const actual = await send(forwarded, 'dbAdd', structuredClone(submitted));
        assert.deepEqual(norm(actual), norm(expected), 'multiple-match initial/retry callback parity');
        assert.equal(pattern.addedId(actual), 'z-inserted-first');
        assert.deepEqual(norm(await rows()), norm(beforeMatches), 'dedup choice does not replace either stored identity');
        assert.deepEqual(norm(await rows()), norm(await mongo.db(database).collection('treatments').find({}).sort({ _id: 1 }).toArray()));
      }

    });
    it('refuses a substituted foreign role credential at current API subject authority without effects or callback', async function () {
      substitute = true;
      let acknowledged = false;
      const before = await rows();
      const expectedForeign = await rows(lab.B);
      const eventCount = events.length;
      try {
        const refused = new Promise(resolve => { refusalObserved = resolve; });
        forwarded.emit('dbAdd', pattern.addTreatment(), () => { acknowledged = true; });
        await refused;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(acknowledged, false, 'foreign role must not gain a client callback');
        assert.deepEqual(await rows(), before); assert.deepEqual(await rows(lab.B), expectedForeign);
        assert.equal(events.length, eventCount);
      } finally { substitute = false; refusalObserved = undefined; }
    });
    it('does not publish a success acknowledgement or event before the owned API commit', async function () {
      const transaction = lab.clocks[0].transaction;
      let release, entered, failed, postWrite = false;
      const gate = new Promise(resolve => { release = resolve; });
      const started = new Promise((resolve, reject) => { entered = resolve; failed = reject; });
      lab.clocks[0].transaction = fn => transaction(async () => {
        try {
          const result = await fn();
          const stored = await lab.raw[0].query(`SELECT count(*)::int AS count FROM "${lab.namespaces.treatments}".treatments WHERE tenant_id=$1`, [lab.A]);
          assert.equal(stored.rows[0].count, 1, 'owned transaction sees its actual write before held COMMIT');
          postWrite = true; entered(); await gate; return result;
        } catch (error) { failed(error); throw error; }
      });
      let acknowledged = false;
      const count = events.length;
      const pending = send(forwarded, 'dbAdd', pattern.addTreatment()).then(reply => { acknowledged = true; return reply; });
      try {
        await started;
        assert.equal(postWrite, true, 'held-COMMIT barrier reached after actual stored write');
        assert.equal(acknowledged, false, 'client acknowledgement preceded API commit');
        assert.deepEqual(await rows(), [], 'uncommitted write invisible to independent oracle');
        assert.equal(events.length, count, 'intent not emitted before commit');
      } finally { release(); lab.clocks[0].transaction = transaction; }
      const result = await pending;
      assert(pattern.addedId(result)); assert.equal((await rows()).length, 1);
      assert.equal(events.length, count + 1);
    });
    it('rolls back a post-write API failure without a success callback, intent event or clock advance', async function () {
      const transaction = lab.clocks[0].transaction;
      const before = await rows(), floor = await lab.floor(lab.A), count = events.length;
      const submitted = pattern.addTreatment(); submitted.data._id = 'synthetic-rolled-back';
      let postWrite = false;
      lab.clocks[0].transaction = fn => transaction(async () => {
        await fn();
        const stored = await lab.raw[0].query(`SELECT count(*)::int AS count FROM "${lab.namespaces.treatments}".treatments WHERE tenant_id=$1 AND "_id"=$2`, [lab.A, submitted.data._id]);
        assert.equal(stored.rows[0].count, 1, 'actual row exists inside owned transaction before abort');
        postWrite = true; throw new Error('synthetic post-write abort');
      });
      let result;
      try { result = await send(forwarded, 'dbAdd', submitted); }
      finally { lab.clocks[0].transaction = transaction; }
      assert.equal(postWrite, true, 'rollback assertion must not pass after a pre-write refusal');
      assert.deepEqual(result, [[]], 'existing failed-write callback has no added identity');
      assert.deepEqual(await rows(), before); assert.equal(await lab.floor(lab.A), floor);
      assert.equal(events.length, count); assert.deepEqual(await rows(lab.B), []);
    });
  });
