'use strict';

const crypto = require('node:crypto');
const { MongoClient, MongoOperationTimeoutError } = require('mongodb');
const { Umzug } = require('umzug');
const { MigrationError } = require('./catalogue');
const { validateCatalogue } = require('./mongo-catalogue');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const lost = () => new MigrationError('MIG_LOCK_LOST', 'MongoDB migration lease or transaction fence was lost');

function options (input) {
  if (!input || input.direct !== true) {
    throw new MigrationError('MIG_DIRECT', 'an operator-attested direct MongoDB replica-set member is required');
  }
  let url;
  try { url = new URL(input.connectionString); } catch {
    throw new MigrationError('MIG_CONNECTION', 'an explicit MongoDB connection URL is required');
  }
  if (url.protocol !== 'mongodb:' || !url.hostname || url.hostname.includes(',') || !url.username || !url.password ||
      !/^\/[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(url.pathname) || url.hash ||
      [...url.searchParams.keys()].some(key => !['authSource', 'tls'].includes(key)) ||
      ['authSource', 'tls'].some(key => url.searchParams.getAll(key).length > 1) ||
      (url.searchParams.has('tls') && !['true', 'false'].includes(url.searchParams.get('tls'))) ||
      (url.searchParams.has('authSource') && !/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(url.searchParams.get('authSource')))) {
    throw new MigrationError('MIG_CONNECTION', 'MongoDB URL requires explicit credentials, one host and database; only authSource and verified tls are supported');
  }
  if (typeof input.namespace !== 'string' || !/^[a-z][a-z0-9_]{0,50}$/.test(input.namespace) ||
      input.namespace.startsWith('system')) {
    throw new MigrationError('MIG_NAMESPACE', 'an explicit non-system migration collection namespace is required');
  }
  for (const [key, minimum] of [['waitMs', 1], ['leaseMs', 300]]) {
    if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] < minimum || input[key] > 600000)) {
      throw new MigrationError('MIG_OPTIONS', 'MongoDB migration wait/lease durations are out of range');
    }
  }
  const files = validateCatalogue(input.catalogue);
  const stateName = input.namespace + '_migration_state';
  const ledgerName = input.namespace + '_schema_migrations';
  if (files.some(m => m.up.some(step => /_(migration_state|schema_migrations)$/.test(step.collection)))) {
    throw new MigrationError('MIG_CATALOGUE', 'migration steps cannot modify coordination or ledger collections');
  }
  return { ...input, files, stateName, ledgerName, database: url.pathname.slice(1),
    waitMs: input.waitMs === undefined ? 30000 : input.waitMs,
    leaseMs: input.leaseMs === undefined ? 30000 : input.leaseMs };
}

async function inspect (ledger, files, session) {
  const rows = await ledger.find({}, { session, projection: { checksum: 1 } }).sort({ _id: 1 }).toArray();
  for (const [index, row] of rows.entries()) {
    const file = files.find(m => m.name === row._id);
    if (!file) throw new MigrationError('MIG_UNKNOWN', 'an applied migration is unknown to the reviewed catalogue');
    if (file.checksum !== row.checksum) throw new MigrationError('MIG_DRIFT', 'applied migration checksum drift: ' + file.name);
    if (files[index].name !== row._id) throw new MigrationError('MIG_HISTORY', 'applied migrations are not a catalogue prefix');
  }
  return { current: rows.length === files.length, applied: rows.map(row => row._id),
    pending: files.slice(rows.length).map(m => m.name) };
}

async function transaction (client, fn, timeoutMS = 10000) {
  const session = client.startSession();
  try {
    return await session.withTransaction(() => fn(session), {
      readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', j: true },
      readPreference: 'primary', maxCommitTimeMS: 5000, timeoutMS
    });
  } finally { await session.endSession(); }
}

async function acquire (client, state, opts) {
  const owner = crypto.randomUUID();
  const deadline = Date.now() + opts.waitMs;
  let epoch;
  do {
    try {
      epoch = await transaction(client, async session => {
        const lease = await state.findOneAndUpdate({
          _id: 'lease', $expr: { $lte: ['$expiresAt', '$$NOW'] }
        }, [{ $set: { owner, epoch: { $add: ['$epoch', 1] }, expiresAt: { $add: ['$$NOW', opts.leaseMs] } } }],
        { session, returnDocument: 'after' });
        if (!lease) return null;
        if (!Number.isSafeInteger(lease.epoch)) throw new MigrationError('MIG_HISTORY', 'MongoDB migration lease epoch is invalid');
        const fenced = await state.updateOne({ _id: 'fence' }, { $set: { owner, epoch: lease.epoch } }, { session });
        if (fenced.matchedCount !== 1) throw lost();
        return lease.epoch;
      }, Math.max(1, deadline - Date.now()));
    } catch (error) {
      if (!(error instanceof MongoOperationTimeoutError)) throw error;
      throw new MigrationError('MIG_LOCK_TIMEOUT', 'MongoDB migration lease deadline exceeded');
    }
    if (epoch === null) {
      if (Date.now() >= deadline) throw new MigrationError('MIG_LOCK_TIMEOUT', 'MongoDB migration lease deadline exceeded');
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  } while (epoch === null);

  let failure;
  let timer;
  let renewal = Promise.resolve();
  const predicate = { _id: 'lease', owner, epoch, $expr: { $gt: ['$expiresAt', '$$NOW'] } };
  const schedule = () => {
    timer = setTimeout(() => {
      renewal = state.updateOne(predicate, [{ $set: { expiresAt: { $add: ['$$NOW', opts.leaseMs] } } }])
        .then(result => {
          if (result.matchedCount !== 1) throw lost();
          schedule();
        }).catch(error => { failure = error; });
    }, Math.floor(opts.leaseMs / 3));
  };
  schedule();
  return {
    async fence (session) {
      if (failure) throw failure;
      const lease = await state.findOne(predicate, { session });
      if (!lease) throw lost();
      // Takeover must update this same document in its transaction. A stale
      // transaction therefore conflicts or refuses before data/ledger writes.
      const result = await state.updateOne({ _id: 'fence', owner, epoch }, { $inc: { serial: 1 } }, { session });
      if (result.matchedCount !== 1) throw lost();
    },
    async close () {
      clearTimeout(timer);
      await renewal;
      clearTimeout(timer);
      // Never delete the epoch or release a successor's lease.
      await state.updateOne({ _id: 'lease', owner, epoch }, { $set: { expiresAt: new Date(0) } });
      if (failure) throw failure;
    }
  };
}

async function up (client, db, opts) {
  const state = db.collection(opts.stateName);
  const ledger = db.collection(opts.ledgerName);
  for (const [id, values] of [['lease', { epoch: 0, expiresAt: new Date(0) }], ['fence', { serial: 0 }]]) {
    try { await state.updateOne({ _id: id }, { $setOnInsert: values }, { upsert: true }); } catch (error) {
      if (error.code !== 11000) throw error;
    }
  }
  // Create only runner metadata, not application collections or indexes.
  try { await db.createCollection(opts.ledgerName); } catch (error) {
    if (error.code !== 48) throw error;
  }
  const lease = await acquire(client, state, opts);
  try {
    await inspect(ledger, opts.files);
    const names = [...new Set(opts.files.flatMap(m => m.up.map(step => step.collection)))];
    const found = await db.listCollections({ name: { $in: names } }, { nameOnly: true }).toArray();
    if (names.some(name => !found.some(collection => collection.name === name))) {
      throw new MigrationError('MIG_COLLECTION', 'all migration data collections must already exist');
    }
    const runner = new Umzug({
      logger: undefined,
      migrations: opts.files.map(m => ({
        name: m.name,
        up: async () => transaction(client, async session => {
          await lease.fence(session);
          for (const step of m.up) {
            await db.collection(step.collection).updateMany(step.filter, { $set: step.set }, { session });
          }
          await ledger.insertOne({ _id: m.name, checksum: m.checksum, appliedAt: new Date() }, { session });
        })
      })),
      storage: {
        executed: async () => (await inspect(ledger, opts.files)).applied,
        logMigration: async () => {},
        unlogMigration: async () => { throw new MigrationError('MIG_UNSUPPORTED', 'rollback is not enabled'); }
      }
    });
    const done = (await runner.up()).map(m => m.name);
    return { ...await inspect(ledger, opts.files), done };
  } finally { await lease.close(); }
}

async function run (action, input) {
  if (!['up', 'status', 'check'].includes(action)) {
    throw new MigrationError('MIG_UNSUPPORTED', 'supported migration actions are up, status and check; rollback is not enabled');
  }
  const opts = options(input);
  const client = new MongoClient(opts.connectionString, {
    directConnection: true, retryWrites: false, readPreference: 'primary',
    serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 10000,
    writeConcern: { w: 'majority', j: true }, appName: 'nightscout-operator-migrations'
  });
  try {
    await client.connect();
    const db = client.db(opts.database);
    const hello = await db.admin().command({ hello: 1 });
    if (!hello.setName || !hello.isWritablePrimary || hello.maxWireVersion < 13) {
      throw new MigrationError('MIG_UNSUPPORTED', 'MongoDB migration adapter requires a writable MongoDB 5+ replica-set primary; standalone mutation is not enabled');
    }
    if (action === 'up') return await up(client, db, opts);
    const result = await transaction(client, session => inspect(db.collection(opts.ledgerName), opts.files, session));
    if (action === 'check' && !result.current) throw new MigrationError('MIG_STALE', 'schema is stale; an operator must run migrate up');
    return result;
  } finally { await client.close(); }
}

module.exports = { run };
