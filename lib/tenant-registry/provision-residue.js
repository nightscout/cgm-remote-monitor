'use strict';

// Fixed inventories from the ACTUAL nine provisioning catalogues. API callers
// cannot supply a table or SQL. Current rows alone do not prove a fresh birth.
const catalogues = {
  registry: require('./postgres-candidate.json'), legacy: require('../secrets/legacy-credentials-candidate.json'),
  secrets: require('../secrets/postgres-candidate.json'), authorization: require('../tenant-authorization/postgres-candidate.json'),
  access: require('../tenant-authorization/access-candidate.json'), clock: require('../../migrations/candidates/postgres-write-clock-v1.json'),
  control: require('../tenant-lifecycle/postgres-candidate.json'), settings: require('../tenant-settings/postgres-candidate.json'),
  operatorPolicy: require('../operator-policy/postgres-candidate.json')
};
const SIGNALS = new Set(['tenant_registry_clock', 'tenant_registry_changes']);
const tables = Object.freeze(Object.fromEntries(Object.entries(catalogues).map(([kind,catalogue]) => {
  const definitions = new Map();
  for (const migration of catalogue.migrations) for (const sql of migration.up) {
    if (!sql.startsWith('CREATE TABLE ')) continue;
    const match = /^CREATE TABLE ([a-z][a-z0-9_]*) \(/.exec(sql);
    if (!match) throw new Error('Unsupported provisioning residue catalogue');
    definitions.set(match[1],sql);
  }
  // The registry clock and its per-tenant change stamps are the deployment's
  // change signal, not a tenant's records.
  const bound = new Set([...definitions].filter(([name,sql]) => !SIGNALS.has(name) && /\btenant_id\s+uuid\b/.test(sql)).map(([name]) => name));
  for (const [name,sql] of definitions) {
    const inherited = /\bLIKE\s+([a-z][a-z0-9_]*)\b/.exec(sql);
    if (inherited && bound.has(inherited[1])) bound.add(name);
  }
  for (const name of definitions.keys()) if (!bound.has(name) && !SIGNALS.has(name)) throw new Error('Unclassified provisioning residue table');
  return [kind,Object.freeze([...bound])];
})));
const q = value => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value) || value.startsWith('pg_') || ['public','information_schema'].includes(value)) throw new TypeError('Explicit residue identifier required');
  return '"'+value+'"';
};
function grantReads (namespaces,role) {
  return Object.entries(tables).flatMap(([kind,names]) => names.map(name => 'GRANT SELECT (tenant_id) ON '+q(namespaces[kind])+'.'+q(name)+' TO '+q(role)));
}
async function present (client,namespaces,tenant) {
  const terms = Object.entries(tables).flatMap(([kind,names]) => names.map(name => 'EXISTS(SELECT 1 FROM '+q(namespaces[kind])+'.'+q(name)+' WHERE tenant_id=$1 LIMIT 1)'));
  const row = (await client.query('SELECT '+terms.join(' OR ')+' AS retained_residue',[tenant])).rows[0];
  if (typeof row?.retained_residue !== 'boolean') throw Object.assign(new Error('TENANT_PROVISION_STORE_UNPREPARED'),{code:'TENANT_PROVISION_STORE_UNPREPARED'});
  return row.retained_residue;
}
module.exports = { tables, grantReads, present };
