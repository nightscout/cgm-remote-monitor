'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { checksum, validateCatalogue } = require('../lib/migrations/catalogue');
const { run } = require('../lib/migrations/postgres');
const { parse } = require('../lib/cli/commands/migrate');
const mongoCatalogue = require('../lib/migrations/mongo-catalogue');
const mongo = require('../lib/migrations/mongodb');

const up = ['CREATE TABLE sample (id integer)'];
const catalogue = () => ({ version: 1, migrations: [{ name: '0001_sample', up, checksum: checksum(up) }] });
const args = ['up', '--backend', 'postgres', '--namespace', 'reviewed', '--catalogue', 'reviewed.json',
  '--connection-env', 'OPERATOR_DATABASE', '--direct'];

describe('operator migration foundation', function () {
  it('requires a nonempty ordered catalogue with exact SQL checksums', function () {
    assert.equal(validateCatalogue(catalogue())[0].name, '0001_sample');
    for (const bad of [null, {}, { version: 1, migrations: [] },
      { version: 1, migrations: [...catalogue().migrations, ...catalogue().migrations] },
      { version: 1, migrations: [{ ...catalogue().migrations[0], checksum: '0'.repeat(64) }] }]) {
      assert.throws(() => validateCatalogue(bad), /catalogue|checksum|ordered/);
    }
  });

  it('takes an immutable SQL snapshot and refuses direct transaction control', function () {
    const input = catalogue();
    const result = validateCatalogue(input);
    input.migrations[0].up = ['DROP TABLE sample'];
    assert.deepEqual(result[0].up, up);
    for (const text of ['COMMIT', 'BEGIN', 'ROLLBACK', 'SET search_path TO public', '-- leading\nCREATE TABLE t(id int)']) {
      const bad = { version: 1, migrations: [{ name: '0001_bad', up: [text], checksum: checksum([text]) }] };
      assert.throws(() => validateCatalogue(bad), /individual DDL\/DML/);
    }
  });

  it('requires explicit operator arguments and does not fall back to application environment', function () {
    const env = { OPERATOR_DATABASE: 'postgres://operator:secret@localhost/db', DATABASE_URL: 'ignored' };
    assert.equal(parse(args, env).connectionString, env.OPERATOR_DATABASE);
    assert.throws(() => parse(args, { DATABASE_URL: env.OPERATOR_DATABASE }), /explicitly named/);
    assert.throws(() => parse(args.slice(0, -1), env), /Usage/);
    assert.throws(() => parse([...args, '--backend', 'postgres'], env), /Usage/);
    assert.throws(() => parse([...args, '--bogus'], env), /Usage/);
    assert.throws(() => parse(['up', '--backend', 'mongo'], env), /Usage/);
    assert.equal(parse(args.map(arg => arg === 'postgres' ? 'mongodb' : arg), env).backend, 'mongodb');
  });

  it('refuses pooler ambiguity, incomplete connection URLs, system namespaces and rollback before connecting', async function () {
    const base = { direct: true, connectionString: 'postgres://operator:secret@localhost/db', namespace: 'reviewed', catalogue: catalogue() };
    for (const change of [{ direct: false }, { namespace: 'public' }, { namespace: 'pg_catalog' },
      { namespace: 'unsafe";' }, { connectionString: 'postgres:///db' },
      { connectionString: 'postgres://operator@localhost/db' },
      { connectionString: base.connectionString + '?options=-csearch_path=public' }]) {
      await assert.rejects(run('up', { ...base, ...change }), /explicit|connection|namespace/);
    }
    await assert.rejects(run('down', base), /rollback is not enabled/);
  });

  it('dispatches migrate visibly without leaking supplied credentials', function () {
    const result = spawnSync(process.execPath, ['bin/nightscout.js', ...['migrate', ...args]], {
      cwd: require('node:path').resolve(__dirname, '..'),
      env: { ...process.env, OPERATOR_DATABASE: 'postgres://operator:do-not-print-me@localhost/db' },
      encoding: 'utf8'
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MIG_FAILED/);
    assert.doesNotMatch(result.stdout + result.stderr, /do-not-print-me|postgres:\/\/|reviewed\.json|ENOENT/);
    const unsupported = spawnSync(process.execPath, ['bin/nightscout.js', 'migrate', 'up', '--backend', 'mongodb'], { encoding: 'utf8' });
    assert.equal(unsupported.status, 64);
    assert.match(unsupported.stderr, /Usage/);
  });

  it('snapshots bounded transactional MongoDB steps and refuses unsafe operation shapes', function () {
    const up = [{ collection: 'samples', filter: { kind: 'old' }, set: { kind: 'new' } }];
    const input = { version: 1, backend: 'mongodb',
      migrations: [{ name: '0001_backfill', transactional: true, up, checksum: checksum(up) }] };
    const snapshot = mongoCatalogue.validateCatalogue(input);
    up[0].set.kind = 'edited';
    assert.equal(snapshot[0].up[0].set.kind, 'new');
    input.migrations[0].checksum = checksum(up);
    for (const step of [{ ...up[0], filter: {} }, { ...up[0], set: { _id: 'changed' } },
      { ...up[0], filter: { $where: 'unsafe' } }, { ...up[0], set: { count: { $inc: 1 } } },
      { ...up[0], operation: 'drop' }, { ...up[0], collection: 'system_users' }]) {
      const bad = [step];
      assert.throws(() => mongoCatalogue.validateCatalogue({ ...input,
        migrations: [{ ...input.migrations[0], up: bad, checksum: checksum(bad) }] }), /MongoDB steps/);
    }
    assert.throws(() => mongoCatalogue.validateCatalogue({ ...input,
      migrations: [{ ...input.migrations[0], transactional: false }] }), /transactional/);
    assert.throws(() => mongoCatalogue.validateCatalogue({ ...input,
      migrations: [{ ...input.migrations[0], checksum: '0'.repeat(64) }] }), /checksum/);
  });

  it('rejects unsafe MongoDB configuration and coordination writes before connecting', async function () {
    const up = [{ collection: 'samples', filter: { kind: 'old' }, set: { kind: 'new' } }];
    const base = { direct: true, connectionString: 'mongodb://operator:synthetic@127.0.0.1:1/lab',
      namespace: 'reviewed', catalogue: { version: 1, backend: 'mongodb',
        migrations: [{ name: '0001_backfill', transactional: true, up, checksum: checksum(up) }] } };
    for (const change of [{ direct: false }, { namespace: 'system_users' }, { leaseMs: 1 },
      { connectionString: 'mongodb://127.0.0.1/lab' },
      { connectionString: base.connectionString + '?tlsAllowInvalidCertificates=true' },
      { connectionString: base.connectionString + '?authSource=admin&authSource=lab' }]) {
      await assert.rejects(mongo.run('up', { ...base, ...change }), /explicit|operator|namespace|range|URL/);
    }
    up[0].collection = 'reviewed_migration_state';
    base.catalogue.migrations[0].checksum = checksum(up);
    await assert.rejects(mongo.run('up', base), /coordination/);
    await assert.rejects(mongo.run('down', base), /rollback is not enabled/);
  });
});
