'use strict';

const { Client } = require('pg');
const { run } = require('../../migrations/postgres');
const domains = require('../../data/tenant-projection-evaluator').domains;
const insertion = require('../../storage/postgres-insertion-readiness');
const quote = name => '"' + name + '"'; // config validated namespaces before calling

async function screen (client, config, { operationWindow } = {}) {
  const checkpoint = config.namespaces.checkpoint + '.tenant_consumer_checkpoint';
  const clinical = [...domains.map(d => config.namespaces[d] + '.' + d), config.namespaces.clock + '.tenant_write_clock'];
  const ordered = Object.entries(cataloguesFor(config)).filter(([, catalogue]) => insertion.isOrderedCatalogue(catalogue)).map(([domain]) => domain);
  const allowed = [...clinical, ...ordered.map(domain => config.namespaces[domain] + '.tenant_insertion_ordinal'), checkpoint, ...Object.values(config.namespaces).map(n => n + '.schema_migrations')];
  // The reviewed registry grant includes its migration ledger. This is the
  // only extra table read by the registry background-role identity; tenant
  // rows/keys and every unrelated table remain outside this clinical scope.
  if (config.registry) allowed.push(config.registry.namespace + '.schema_migrations');
  allowed.push(...await require('../../storage/postgres-operation-control')(client, operationWindow));
  const role = (await client.query(`SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,
    EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER') AND
      (r.rolname ~ '^pg_' OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)) AS operator
    FROM pg_roles WHERE rolname=current_user`)).rows[0];
  if (!role || Object.values(role).some(Boolean)) throw new Error('unsafe evaluator identity');
  const global = (await client.query(`WITH identities AS
    (SELECT oid FROM pg_roles WHERE pg_has_role(current_user,oid,'MEMBER')) SELECT
    EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN identities i WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
      AND has_schema_privilege(i.oid,n.oid,'CREATE')) AS creates,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN identities i
      WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')
      AND ((pg_has_role(current_user,c.relowner,'MEMBER')) OR
        ((n.nspname||'.'||c.relname)<>$1 AND
          (has_table_privilege(i.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
           has_any_column_privilege(i.oid,c.oid,'INSERT,UPDATE,REFERENCES'))) OR
        (NOT ((n.nspname||'.'||c.relname)=ANY($2::text[])) AND
          (has_table_privilege(i.oid,c.oid,'SELECT') OR has_any_column_privilege(i.oid,c.oid,'SELECT'))))) AS unrelated
    `, [checkpoint, allowed])).rows[0];
  if (!global || global.creates || global.unrelated) throw new Error('unsafe evaluator scope');
  for (const domain of ordered) await insertion.metadata(client, { namespace: config.namespaces[domain], domain, mode: 'reader' });
  for (const table of [...clinical, checkpoint]) {
    const row = (await client.query(`SELECT c.relrowsecurity AND c.relforcerowsecurity AS secured,
      has_table_privilege(c.oid,'SELECT') AS reads,
      EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER') AND
        (has_table_privilege(r.oid,c.oid,'INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
         has_any_column_privilege(r.oid,c.oid,'INSERT,REFERENCES'))) AS forbidden,
      EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER') AND
        has_any_column_privilege(r.oid,c.oid,'UPDATE')) AS updates,
      CASE WHEN c.oid=to_regclass($3) THEN has_column_privilege(c.oid,'checkpoint','UPDATE') AND
        has_column_privilege(c.oid,'projection','UPDATE') AND
        has_column_privilege(c.oid,'contract_digest','UPDATE') ELSE false END AS bookkeeping,
      EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN pg_roles r WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        AND pg_has_role(current_user,r.oid,'MEMBER') AND a.attname<>ALL($2::text[])
        AND has_column_privilege(r.oid,c.oid,a.attname,'UPDATE')) AS extra
      FROM pg_class c WHERE c.oid=to_regclass($1)`, [table, table === checkpoint ? ['checkpoint', 'projection', 'contract_digest'] : [], checkpoint])).rows[0];
    if (!row || !row.secured || !row.reads || row.forbidden || row.extra ||
        (table === checkpoint ? !row.bookkeeping : row.updates)) throw new Error('unsafe evaluator table privileges');
  }
}

async function provision (client, config) {
  for (const tenant of config.tenants.keys()) {
    const rows = (await client.query('SELECT c.checkpoint,w.last_stamp FROM ' + quote(config.namespaces.checkpoint) +
      '.tenant_consumer_checkpoint c JOIN ' + quote(config.namespaces.clock) +
      '.tenant_write_clock w USING(tenant_id) WHERE c.tenant_id=$1 AND c.consumer=$2', [tenant, config.consumer])).rows;
    if (rows.length !== 1) throw new Error('missing evaluator tenant provisioning');
    for (const [domain, catalogue] of Object.entries(cataloguesFor(config))) {
      if (insertion.isOrderedCatalogue(catalogue)) await insertion.floor(client, { namespace: config.namespaces[domain], domain, tenant });
    }
  }
}

function cataloguesFor (config) {
  const selected = config.socketOrderDomains === undefined ? [] : config.socketOrderDomains;
  const reviewed = require('../tenant-socket-order-port').catalogues;
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some(domain => !Object.hasOwn(reviewed, domain))) {
    throw new TypeError('Explicit reviewed socket order domain selection required');
  }
  const catalogues = Object.fromEntries(domains.map(domain => [domain, selected.includes(domain)
    ? reviewed[domain] : require('./postgres-domains').get(domain).catalogue]));
  catalogues.clock = require('../../../migrations/candidates/postgres-write-clock-v1.json');
  catalogues.checkpoint = require('../../../migrations/candidates/postgres-consumer-checkpoint-v1.json');
  if (config.namespaces?.changeStamps !== undefined) catalogues.changeStamps = require('../../change-stamps/postgres-candidate.json');
  return catalogues;
}

module.exports = async function readiness (config, options = {}) {
  const catalogues = cataloguesFor(config);
  const client = new Client({ connectionString: config.connectionString, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  try {
    await client.connect(); await client.query('BEGIN READ ONLY');
    // Shared metadata is unconditional. Tenant provisioning uses the registered
    // lower connection after this screen, inside its real operation window.
    await screen(client, config, options);
    await client.query('ROLLBACK');
  } finally { await client.end(); }
  for (const [kind, catalogue] of Object.entries(catalogues)) await run('check', {
    direct: true, connectionString: config.connectionString, namespace: config.namespaces[kind], catalogue, statementTimeoutMs: 5000
  });
};
module.exports.screen = screen;
module.exports.cataloguesFor = cataloguesFor;

// Deferred tenants repeat the exact provisioning checks through their registered,
// gated lower connection when initialization is eventually admitted.
module.exports.provisionTenant = (connection, config, tenant) => connection.withTenant(tenant,
  () => provision(connection, { ...config, tenants: new Map([[tenant, true]]) }));
