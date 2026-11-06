'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const net = require('node:net');
const request = require('supertest');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const crudHTTP = require('./entries-crud-http');
const { run } = require('../../lib/migrations/postgres');
const catalogue = require('../../lib/server/tenant-app/domain-catalogue');
const postgresDomains = require('../../lib/server/serve/postgres-domains');
const environment = require('../../lib/server/tenant-app/environment');
const previewDomains = require('../../lib/server/serve/preview-domains');
const dataAccess = require('../../lib/server/tenant-app/data-access');
const { createTenantApp } = require('../../lib/server/tenant-app');
const { encodeDocument } = require('../../lib/storage/postgres-identity');

module.exports = function tenantFrameConcurrency () {
  const base = crudHTTP();
  const namespaces = Object.fromEntries(catalogue.names.map(logical => [logical,
    logical === 'entries' ? base.name : base.name + '_' + logical]));
  const role = base.name + '_app';
  let server, writer;
  const fixture = { base, namespaces, role, A: base.A, B: base.B };
  fixture.open = async () => {
    await base.open();
    for (const logical of catalogue.names.filter(name => name !== 'entries')) {
      await run('up', { direct: true, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI,
        namespace: namespaces[logical], catalogue: postgresDomains.get(logical).catalogue });
      await base.admin.query(`GRANT USAGE ON SCHEMA ${namespaces[logical]} TO ${role}`);
      await base.admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${namespaces[logical]}.${logical} TO ${role}`);
    }
    const config = { domains: [...catalogue.names], legacyEnabled: true, contextEnabled: false, namespaces,
      bindings: new Map([[base.A, {}], [base.B, {}]]), environments: new Map([base.A, base.B].map(tenant =>
        [tenant, environment({ settings: { enable: ['bgnow', 'direction'] } })])) };
    const worker = base.workers[0];
    const domains = await previewDomains({ config, connection: worker.connection });
    const unused = async () => { throw new Error('unused fixture management service'); };
    server = createTenantApp({
      resolver: require('../../lib/tenant-resolution')({ aliases: [
        { host: 'one.example.test', tenant: base.A }, { host: 'two.example.test', tenant: base.B }] }),
      verifyCredential: unused, authorizeRequest: unused,
      tenantSettings: { read: unused, replace: unused, rollback: unused },
      subjectPolicy: { read: unused, replace: unused },
      dataAccess: dataAccess({ secrets: worker.secrets, authority: worker.authority,
        verifierContext: async tenant => ({ tenant, principal: 'verifier', consumer: 'api' }),
        collections: domains.v3Names, legacyCollections: domains.legacyNames, derivedReads: true }),
      dataRouter: domains.data, legacyRouter: domains.legacyRouter
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    writer = new Client({ connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI });
    await writer.connect();
  };
  fixture.http = (path = '/api/v2/ddata/at', tenant = base.A) => request(server).get(path)
    .set('Host', tenant === base.A ? 'one.example.test' : 'two.example.test')
    .set('api-secret', base.credentials[tenant === base.A ? 0 : 1]).timeout({ response: 10000, deadline: 15000 });
  fixture.rows = async (logical, tenant = base.A) =>
    (await base.admin.query(`SELECT doc FROM ${namespaces[logical]}.${logical} WHERE tenant_id=$1 ORDER BY "_id"`, [tenant])).rows.map(row => row.doc);
  fixture.seed = async () => {
    for (const logical of catalogue.names) await base.admin.query(`DELETE FROM ${namespaces[logical]}.${logical}`);
    const at = Date.now() - 1000;
    for (const tenant of [base.A, base.B]) {
      const foreign = tenant === base.B;
      for (const [logical, doc] of [
        ['entries', { _id: 'same-entry', identifier: 'same-entry', type: 'sgv', sgv: foreign ? 902 : 101,
          date: at, sysTime: new Date(at).toISOString(), device: 'synthetic-frame', frameGeneration: foreign ? 9 : 0 }],
        ['treatments', { _id: 'same-treatment', identifier: 'same-treatment', eventType: 'Carb Correction',
          carbs: foreign ? 920 : 20, created_at: new Date(at).toISOString(), frameGeneration: foreign ? 9 : 0 }]
      ]) {
        const row = encodeDocument(doc);
        await base.admin.query(`INSERT INTO ${namespaces[logical]}.${logical} (tenant_id,id_kind,doc) VALUES ($1,$2,$3)`,
          [tenant, row.id_kind, row.doc]);
      }
      await base.grants(['api:*:read'], tenant);
    }
  };
  fixture.advance = async () => {
    await writer.query('BEGIN');
    try {
      for (const [logical, field, value] of [['entries', 'sgv', 111], ['treatments', 'carbs', 30]]) {
        await writer.query(`UPDATE ${namespaces[logical]}.${logical} SET doc=jsonb_set(jsonb_set(doc,
          '{${field}}',$1::jsonb),'{frameGeneration}','1'::jsonb) WHERE tenant_id=$2`, [JSON.stringify(value), base.A]);
      }
      await writer.query('COMMIT');
    } catch (error) { await writer.query('ROLLBACK'); throw error; }
  };

  // Delay real treatment SELECT execution without manufacturing documents.
  // Other domain queries continue; observations contain actual returned rows.
  fixture.barrier = () => {
    const connection = base.workers[0].connection;
    const original = connection.query;
    const observed = [], errors = [];
    let held = 0, released = false, release;
    const blocked = new Promise(resolve => { release = resolve; });
    connection.query = async function observedQuery (text, values) {
      const logical = typeof text === 'string' && ['entries', 'treatments'].find(name =>
        text.includes(' FROM "' + namespaces[name] + '"."' + name + '"'));
      if (logical === 'treatments' && !released) { held++; await blocked; }
      try {
        const result = await original.call(this, text, values);
        if (logical) observed.push({ logical, documents: result.rows.map(row => row.doc) });
        return result;
      } catch (error) {
        if (logical) errors.push({ logical, code: error.code });
        throw error;
      }
    };
    return { observed, errors,
      async ready () {
        const deadline = Date.now() + 5000;
        while ((!held || !observed.some(read => read.logical === 'entries' && read.documents.length)) && Date.now() < deadline) await delay(5);
        assert.ok(held > 0, 'a real treatment SELECT must be held before execution');
        assert.ok(observed.some(read => read.logical === 'entries' && read.documents.length), 'a real entries SELECT must complete before changing state');
        assert.equal(observed.some(read => read.logical === 'treatments'), false, 'no treatment SELECT can complete before release');
      },
      release () { released = true; release(); },
      restore () { released = true; release(); connection.query = original; }
    };
  };
  fixture.failRead = async kind => {
    if (kind === 'privilege') await base.admin.query(`REVOKE SELECT ON ${namespaces.treatments}.treatments FROM ${role}`);
    else await base.admin.query(`ALTER TABLE ${namespaces.treatments}.treatments RENAME TO treatments_hidden`);
  };
  fixture.restoreRead = async kind => {
    if (kind === 'privilege') await base.admin.query(`GRANT SELECT ON ${namespaces.treatments}.treatments TO ${role}`);
    else await base.admin.query(`ALTER TABLE ${namespaces.treatments}.treatments_hidden RENAME TO treatments`);
  };
  fixture.egressGuard = () => {
    const original = net.Socket.prototype.connect;
    const allowed = new Set([Number(new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI).port), server.address().port]);
    let denied = 0;
    net.Socket.prototype.connect = function observedConnect (...args) {
      const first = Array.isArray(args[0]) ? args[0][0] : args[0];
      const options = first && typeof first === 'object' ? first : { port: first, host: args[1] };
      const host = options.host || 'localhost';
      if (!['127.0.0.1', '::1', 'localhost'].includes(host) || !allowed.has(Number(options.port))) {
        denied++;
        throw new Error('frame read attempted a non-dependency socket');
      }
      return original.apply(this, args);
    };
    return { denied: () => denied, restore () { net.Socket.prototype.connect = original; } };
  };
  fixture.close = async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (writer) await writer.end();
    for (const logical of catalogue.names.filter(name => name !== 'entries')) {
      await base.admin.query(`DROP SCHEMA IF EXISTS ${namespaces[logical]} CASCADE`);
    }
    await base.close();
  };
  return fixture;
};
