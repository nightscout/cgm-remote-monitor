'use strict';

const platform = require('./platform-verification');

const connectionAdmission = require('../../storage/connection-admission');

const { Client } = require('pg');
const { run } = require('../../migrations/postgres');
const domains = () => require('../../data/tenant-projection-evaluator').domains;
const insertion = require('../../storage/postgres-insertion-readiness');
const quote = name => '"' + name + '"'; // config validated namespaces before calling

function recognizedProfile (value) {
  return value?.binding?.protocol === require('../../pgstream/pool-intake-profile').PROTOCOL
    ? require('../../pgstream/pool-intake-profile').validate(value)
    : require('../../pgstream/intake-profile').validate(value);
}
function isPoolProfile (value) { return value.binding.protocol === require('../../pgstream/pool-intake-profile').PROTOCOL; }

async function screen (client, config, { operationWindow, intakeProfile,ordinal } = {}) {
  const checkpoint = config.namespaces.checkpoint + '.tenant_consumer_checkpoint';
  const completed = !!config.completedOutput;
  const clinical = [...(completed ? [] : domains().map(d => config.namespaces[d] + '.' + d)), config.namespaces.clock + '.tenant_write_clock'];
  const ordered = Object.entries(cataloguesFor(config)).filter(([, catalogue]) => insertion.isOrderedCatalogue(catalogue)).map(([domain]) => domain);
  const allowed = [...clinical, ...ordered.map(domain => config.namespaces[domain] + '.tenant_insertion_ordinal'), checkpoint, ...Object.keys(cataloguesFor(config)).map(kind => config.namespaces[kind] + '.schema_migrations')];
  // The reviewed registry grant includes its migration ledger. This is the
  // only extra table read by the registry background-role identity; tenant
  // rows/keys and every unrelated table remain outside this clinical scope.
  if (config.registry) allowed.push(config.registry.namespace + '.schema_migrations');
  if (config.platformVerification) allowed.push(config.platformVerification.namespace + '.verified_role', config.platformVerification.namespace + '.verification_control');
  if (config.trustedWorker) allowed.push(...require('../../trusted-worker/postgres').relations(config.trustedWorker).map(row => row.name.replaceAll('"', '')));
  if(config.pgstream&&!completed&&!intakeProfile)allowed.push('pgstream.webhook_subscriptions');
  if(config.completedOutput)allowed.push(config.completedOutput.namespace+'.tenant_consumer_checkpoint');
  if(intakeProfile){
    const p=recognizedProfile(intakeProfile),b=p.binding;
    if(p.digest!==operationWindow?.intakeProfileDigest||b.namespace!==config.namespaces.checkpoint||b.consumer!==config.consumer)throw new Error('PGSTREAM_SELECTED_READINESS_BINDING');
    allowed.push(b.membershipNamespace+'.pool_membership',b.membershipNamespace+'.pool_desired');
    if(isPoolProfile(p)){
      const grants=require('../../pgstream/pool-worker-grants');
      allowed.push(b.membershipNamespace+'.schema_migrations',b.namespace+'.schema_migrations',b.namespace+'.pgstream_intake_profile',...Object.keys(grants.lifecycleReads(p)).map(table=>b.lifecycleNamespace+'.'+table));
      const expectedRole=typeof config.connectionString==='string'?decodeURIComponent(new URL(config.connectionString).username):undefined;
      await grants.assertReady(client.query.bind(client),{profile:p,ordinal,...(expectedRole===undefined?{}:{expectedRole})});
      await require('../../pgstream/assignment-protocol').assertInstalled(client.query.bind(client),{namespace:b.namespace,membershipNamespace:b.membershipNamespace,lifecycleNamespace:b.lifecycleNamespace,poolProfile:p,poolIntake:true,predecessorProfile:config.selectedIntake?.predecessorProfile});
    }else{
      await require('../../pgstream/worker-grants').assertReady(client.query.bind(client),{namespace:b.namespace,consumer:b.consumer,assignment:p.assignment,ordinal,membershipNamespace:b.membershipNamespace});
      await require('../../pgstream/assignment-protocol').assertInstalled(client.query.bind(client),{namespace:b.namespace,membershipNamespace:b.membershipNamespace,lifecycleNamespace:b.lifecycleNamespace,intakeProfile:p});
    }
  }
  const bookkeepingColumns = intakeProfile ? require('../../pgstream/worker-grants').UPDATES : completed ? require('../../pgstream/realtime-receipt').COLUMNS :
    ['checkpoint', 'projection', 'contract_digest', ...(config.pgstream ? require('../../pgstream/checkpoint').WORK_COLUMNS : [])];
  const writable=[checkpoint];
  allowed.push(...await require('../../storage/postgres-operation-control')(client, operationWindow));
  // pg_use_reserved_connections (PostgreSQL 16) only lets a role use the
  // reserved_connections slots a deployment keeps for clinical work; it grants
  // no data, signal or administration right. Every other pg_* role is refused.
  const role = (await client.query(`SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,
    EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER') AND
      ((r.rolname ~ '^pg_' AND r.rolname <> 'pg_use_reserved_connections') OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)) AS operator
    FROM pg_roles WHERE rolname=current_user`)).rows[0];
  if (!role || Object.values(role).some(Boolean)) throw new Error('unsafe evaluator identity');
  const global = (await client.query(`WITH identities AS
    (SELECT oid FROM pg_roles WHERE pg_has_role(current_user,oid,'MEMBER')) SELECT
    EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN identities i WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
      AND has_schema_privilege(i.oid,n.oid,'CREATE')) AS creates,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN identities i
      WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')
      AND ((pg_has_role(current_user,c.relowner,'MEMBER')) OR
        (NOT ((n.nspname||'.'||c.relname)=ANY($1::text[])) AND
          (has_table_privilege(i.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
           has_any_column_privilege(i.oid,c.oid,'INSERT,UPDATE,REFERENCES'))) OR
        (NOT ((n.nspname||'.'||c.relname)=ANY($2::text[])) AND
          (has_table_privilege(i.oid,c.oid,'SELECT') OR has_any_column_privilege(i.oid,c.oid,'SELECT'))))) AS unrelated
    `, [writable, allowed])).rows[0];
  if (!global || global.creates || global.unrelated) throw new Error('unsafe evaluator scope');
  if(config.pgstream&&!completed&&!intakeProfile)for(const domain of domains()){await require('../../storage/clinical-storage-size-readiness').assertReady(client,{namespace:config.namespaces[domain],domain});await require('../../storage/storage-event-identity-sql').assertReady(client,{namespace:config.namespaces[domain],domain});}
  for (const domain of ordered) await insertion.metadata(client, { namespace: config.namespaces[domain], domain, mode: 'reader' });
  for (const table of [...new Set([...clinical, checkpoint, ...(completed ? [config.completedOutput.namespace + '.tenant_consumer_checkpoint'] : [])])]) {
    const row = (await client.query(`SELECT c.relrowsecurity AND c.relforcerowsecurity AS secured,
      has_table_privilege(c.oid,'SELECT') AS reads,
      EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER') AND
        (has_table_privilege(r.oid,c.oid,'INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
         has_any_column_privilege(r.oid,c.oid,'INSERT,REFERENCES'))) AS forbidden,
      EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER') AND
        has_any_column_privilege(r.oid,c.oid,'UPDATE')) AS updates,
      CASE WHEN c.oid=to_regclass($3) THEN NOT EXISTS
        (SELECT 1 FROM unnest($2::text[]) required(column_name)
          WHERE NOT has_column_privilege(c.oid,required.column_name,'UPDATE')) ELSE false END AS bookkeeping,
      EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN pg_roles r WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        AND pg_has_role(current_user,r.oid,'MEMBER') AND a.attname<>ALL($2::text[])
        AND has_column_privilege(r.oid,c.oid,a.attname,'UPDATE')) AS extra
      FROM pg_class c WHERE c.oid=to_regclass($1)`, [table, table === checkpoint ? bookkeepingColumns : [], checkpoint])).rows[0];
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
  if (config.completedOutput) return {
    clock: require('../../../migrations/candidates/postgres-write-clock-v1.json'),
    checkpoint: require('../../../migrations/candidates/postgres-realtime-output-v2.json')
  };
  const selected = config.socketOrderDomains === undefined ? [] : config.socketOrderDomains;
  const reviewed = require('../tenant-socket-order-port').catalogues;
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some(domain => !Object.hasOwn(reviewed, domain))) {
    throw new TypeError('Explicit reviewed socket order domain selection required');
  }
  const catalogues = Object.fromEntries(domains().map(domain => [domain, selected.includes(domain)
    ? reviewed[domain] : require('./postgres-domains').get(domain).catalogue]));
  catalogues.clock = require('../../../migrations/candidates/postgres-write-clock-v1.json');
  catalogues.checkpoint = config.selectedIntake?(isPoolProfile(recognizedProfile(config.selectedIntake.profile))
    ? require('../../pgstream/pool-catalogue').build(config.selectedIntake.profile,{predecessorProfile:config.selectedIntake.predecessorProfile}).catalogue
    : require('../../pgstream/assignment-candidate').build({membershipNamespace:config.selectedIntake.profile.binding.membershipNamespace,lifecycleNamespace:config.selectedIntake.profile.binding.lifecycleNamespace,intakeProfile:config.selectedIntake.profile}).catalogue):config.pgstream
    ? require('../../../migrations/candidates/postgres-evaluator-work-v2.json')
    : config.completedOutput ? require('../../../migrations/candidates/postgres-realtime-output-v2.json')
      : require('../../../migrations/candidates/postgres-consumer-checkpoint-v1.json');
  return catalogues;
}

module.exports = async function readiness (config, options = {}) {
  if (config.platformVerification && !options.platformCheck) return platform.admit(config, config.platformVerification.role, platform.operationProfileDigest(options.operationWindow));
  const catalogues = cataloguesFor(config);
  const client = new (connectionAdmission.wrapClient(Client, 'clinical-readiness'))({ connectionString: config.connectionString, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
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
