'use strict';
// Native read-only admission and physical red/restored controls on owned objects.
// The coordinator supplies a disposable PostgreSQL URI; no Docker/global cleanup.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { run } = require('../lib/migrations/postgres');
const admission = require('../lib/storage/postgres-insertion-readiness');
const proposal = require('../lib/tenant-lifecycle/tenant-insertion-sql');
const { optInSuite } = require('./support/opt-in');
const A = '11111111-1111-4111-8111-111111111111';
optInSuite(process.env.NS_TENANT_INSERTION_READINESS_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_TENANT_INSERTION_READINESS_TEST=1 with disposable PostgreSQL')('tenant insertion native admission', function () {
  this.timeout(60000);
  const prefix = 'ordread_' + crypto.randomBytes(7).toString('hex');
  const schemas = [], roles = [], clients = [], selected = {};
  let admin, owner;
  const q = name => '"' + name + '"';
  async function bind (client, fn) {
    await client.query('BEGIN READ ONLY');
    try { await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [A]); return await fn(); }
    finally { await client.query('ROLLBACK'); }
  }
  const check = (domain, role = 'serving') => bind(selected[domain][role], async () => {
    await admission.metadata(selected[domain][role], { namespace: selected[domain].namespace, domain, mode: role });
    await admission.floor(selected[domain][role], { namespace: selected[domain].namespace, domain, tenant: A });
  });
  before(async () => {
    const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI; assert.match(new URL(uri).pathname, /test/i);
    admin = new Client({ connectionString: uri, statement_timeout: 10000 }); await admin.connect();
    owner = (await admin.query('SELECT current_user AS owner')).rows[0].owner;
    assert.match(owner, /^[a-z][a-z0-9_]*$/);
    for (const mode of ['serving', 'reader', 'restore', 'inherited']) {
      const role = prefix + '_' + mode, password = crypto.randomBytes(24).toString('hex');
      await admin.query('CREATE ROLE ' + q(role) + " LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '" + password + "'");
      roles.push(role);
      const url = new URL(uri); url.username = role; url.password = password;
      const client = new Client({ connectionString: url.toString(), statement_timeout: 10000 }); await client.connect();
      clients.push(client); selected[mode] = { client, role };
    }
    for (const domain of proposal.DOMAINS) {
      const namespace = prefix + '_' + domain;
      await admin.query('CREATE SCHEMA ' + q(namespace)); schemas.push(namespace);
      const catalogue = ['treatments', 'devicestatus', 'profile'].includes(domain)
        ? require('../lib/server/tenant-socket-order-port').catalogues[domain]
        : require('../lib/server/serve/postgres-domains').get(domain).catalogue;
      assert(admission.isOrderedCatalogue(catalogue), 'new typed migration must be selected');
      await run('up', { direct: true, connectionString: uri, namespace, catalogue });
      const built = proposal.build({ namespace, domain });
      for (const mode of ['serving', 'reader', 'restore']) {
        const role = selected[mode].role;
        await admin.query('GRANT USAGE ON SCHEMA ' + q(namespace) + ' TO ' + q(role));
        await admin.query('GRANT SELECT ON ' + q(namespace) + '.' + q(domain) + ' TO ' + q(role));
        if (mode === 'reader') await admin.query('GRANT SELECT ON ' + q(namespace) + '.tenant_insertion_ordinal TO ' + q(role));
        else {
          await admin.query('GRANT UPDATE,DELETE ON ' + q(namespace) + '.' + q(domain) + ' TO ' + q(role));
          for (const statement of mode === 'restore' ? built.restoreGrants(role) : built.servingGrants(role)) await admin.query(statement);
          if (mode === 'restore') await admin.query('GRANT DELETE ON ' + q(namespace) + '.tenant_insertion_ordinal TO ' + q(role));
        }
      }
      selected[domain] = { namespace, ...Object.fromEntries(['serving', 'reader', 'restore'].map(mode => [mode, selected[mode].client])) };
      await admin.query('BEGIN');
      try {
        await admin.query("SELECT set_config('app.current_tenant_id',$1,true)", [A]);
        await admin.query('INSERT INTO ' + q(namespace) + '.' + q(domain) + '(tenant_id,id_kind,doc) VALUES($1,\'string\',$2::jsonb)', [A, JSON.stringify({ _id: 'synthetic-order', startDate: '2026-11-07T00:00:00Z' })]);
        await admin.query('COMMIT');
      } catch (error) { await admin.query('ROLLBACK'); throw error; }
    }
  });
  after(async () => {
    const errors = [];
    for (const client of clients) try { await client.end(); } catch (error) { errors.push(error); }
    if (admin) {
      for (const namespace of [...schemas].reverse()) try { await admin.query('DROP SCHEMA ' + q(namespace) + ' CASCADE'); } catch (error) { errors.push(error); }
      for (const role of [...roles].reverse()) try { await admin.query('DROP ROLE ' + q(role)); } catch (error) { errors.push(error); }
      await admin.end();
    }
    if (errors.length) throw new globalThis.AggregateError(errors, 'Owned insertion readiness cleanup refused');
  });
  it('admits all five actual schemas for serving/read-only/restore roles', async () => {
    for (const domain of proposal.DOMAINS) for (const mode of ['serving', 'reader', 'restore']) {
      await check(domain, mode);
      await admission.roleMetadata(admin, { namespace: selected[domain].namespace, domain, mode, role: selected[mode].role });
    }
  });
  it('rejects missing and disabled trigger and altered body, then restores actual physical admission', async () => {
    const domain = 'entries', { namespace } = selected[domain], table = q(namespace) + '.entries', fn = q(namespace) + '.allocate_tenant_insertion_ordinal()';
    const original = (await admin.query('SELECT pg_get_functiondef($1::regprocedure) AS ddl', [fn])).rows[0].ddl;
    await check(domain);
    await admin.query('ALTER TABLE ' + table + ' DISABLE TRIGGER tenant_insertion_allocate');
    try { await assert.rejects(check(domain), /unsafe tenant insertion schema/); }
    finally { await admin.query('ALTER TABLE ' + table + ' ENABLE TRIGGER tenant_insertion_allocate'); }
    await check(domain);
    await admin.query('DROP TRIGGER tenant_insertion_allocate ON ' + table);
    try { await assert.rejects(check(domain), /unsafe tenant insertion schema/); }
    finally { await admin.query('CREATE TRIGGER tenant_insertion_allocate BEFORE INSERT OR UPDATE ON ' + table + ' FOR EACH ROW EXECUTE FUNCTION ' + fn); }
    await check(domain);
    assert(original.includes('counter.last_ordinal+1'));
    await admin.query(original.replace('counter.last_ordinal+1', 'counter.last_ordinal'));
    try { await assert.rejects(check(domain), /unsafe tenant insertion schema/); }
    finally { await admin.query(original); }
    await check(domain);
  });
  it('rejects inherited explicit-ordinal grants and inappropriate reader mutation, with restored positives', async () => {
    const { namespace } = selected.entries, table = q(namespace) + '.entries';
    await admin.query('GRANT USAGE ON SCHEMA ' + q(namespace) + ' TO ' + q(selected.inherited.role));
    await admin.query('GRANT INSERT(insertion_ordinal) ON ' + table + ' TO ' + q(selected.inherited.role));
    await admin.query('GRANT ' + q(selected.inherited.role) + ' TO ' + q(selected.serving.role));
    try { await assert.rejects(check('entries'), /unsafe tenant insertion privileges/); }
    finally { await admin.query('REVOKE ' + q(selected.inherited.role) + ' FROM ' + q(selected.serving.role)); }
    await check('entries');
    await admin.query('GRANT UPDATE(last_ordinal) ON ' + q(namespace) + '.tenant_insertion_ordinal TO ' + q(selected.reader.role));
    try { await assert.rejects(check('entries', 'reader'), /unsafe tenant insertion privileges/); }
    finally { await admin.query('REVOKE UPDATE(last_ordinal) ON ' + q(namespace) + '.tenant_insertion_ordinal FROM ' + q(selected.reader.role)); }
    await check('entries', 'reader');
  });
  it('rejects counter binding drift, wrong owner and stale floor without changing clinical rows', async () => {
    const { namespace } = selected.entries, counter = q(namespace) + '.tenant_insertion_ordinal';
    await admin.query('ALTER POLICY tenant_insertion_isolation ON ' + counter + ' USING(true)');
    try { await assert.rejects(check('entries'), /unsafe tenant insertion schema/); }
    finally { await admin.query("ALTER POLICY tenant_insertion_isolation ON " + counter + " USING(tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid)"); }
    await check('entries');
    await admin.query('ALTER TABLE ' + counter + ' OWNER TO ' + q(selected.inherited.role));
    try { await assert.rejects(check('entries'), /unsafe tenant insertion schema/); }
    finally { await admin.query('ALTER TABLE ' + counter + ' OWNER TO ' + q(owner)); }
    await check('entries');
    await admin.query('UPDATE ' + counter + ' SET last_ordinal=0 WHERE tenant_id=$1', [A]);
    try { await assert.rejects(check('entries'), /unsafe tenant insertion floor/); }
    finally { await admin.query('UPDATE ' + counter + ' SET last_ordinal=1 WHERE tenant_id=$1', [A]); }
    await check('entries');
  });
});
