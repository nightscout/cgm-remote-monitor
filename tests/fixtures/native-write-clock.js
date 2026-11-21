'use strict';

// The tenant write clock a native fixture's api connection needs
// (decision multitenant-requires-write-clock): every multitenant history write
// stamps srvModified from its tenant's clock row inside the write's own
// transaction (lib/storage/postgres-write-clock). Provisioning creates the row
// (lib/tenant-registry/provision.js) and the api role may read and advance it
// (lib/server/ordinary-deployment-grants.js); a fixture that composes the api
// storage by hand does the same here.
const { run } = require('../../lib/migrations/postgres');
const decorate = require('../../lib/storage/postgres-write-clock');
const dates = require('../../lib/server/srv-dates');
const catalogue = require('../../migrations/candidates/postgres-write-clock-v1.json');

const q = name => '"' + String(name).replaceAll('"', '""') + '"';

// admin: a connected pg Client with the disposable admin URI. role: the api
// login role the fixture serves with.
async function provision (admin, { connectionString, namespace, role, tenants }) {
  await run('up', { direct: true, connectionString, namespace, catalogue });
  const table = q(namespace) + '.tenant_write_clock';
  await admin.query('GRANT USAGE ON SCHEMA ' + q(namespace) + ' TO ' + q(role));
  await admin.query('GRANT SELECT, UPDATE(last_stamp, last_delete_stamp) ON ' + table + ' TO ' + q(role));
  for (const tenant of tenants) {
    await admin.query('INSERT INTO ' + table + ' (tenant_id, last_stamp) VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING',
      [tenant, Date.now()]);
  }
}

// The api's data connection: the plain connection decorated with the clock.
// `query` is the plain connection's own property, read at call time: a
// fixture's fault injection on either object reaches both, and data access
// still sees one connection (it joins reads by comparing `query`).
function clocked (connection, namespace) {
  const decorated = decorate(connection, namespace);
  Object.defineProperty(decorated, 'query', { enumerable: true,
    get: () => connection.query, set: value => { connection.query = value; } });
  return decorated;
}

// A MongoDB differential oracle has no database clock, but under the process's
// multitenant mode its writes still stamp from one. It runs inside a stand-in
// allocator with the same contract: one tenant, strictly increasing stamps.
let floor = 0;
function referenceClock (tenant, fn) {
  return dates.withAllocator({ tenant, active: true, next: now => (floor = Math.max(now, floor + 1)) }, fn);
}

module.exports = { provision, clocked, referenceClock };
