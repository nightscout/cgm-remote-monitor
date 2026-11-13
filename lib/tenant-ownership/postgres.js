'use strict';

const { randomUUID } = require('node:crypto');
const postgresConnection = require('../storage/postgres-connection');
const scope = require('../storage/tenant-scope');
const { permissionsValid, permissionsContained } = require('../subject-admin/permission-implication');
const { plan, sort, key } = require('./component');
const phase = require('../tenant-lifecycle/tenant-phase');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KNOWN = ['OWNERSHIP_FORBIDDEN', 'OWNERSHIP_TENANT_UNKNOWN', 'OWNERSHIP_INVALID'];
const VERB = { add: 'owner-add', transfer: 'owner-transfer', recover: 'owner-recover' };

function failure (code) {
  return Object.assign(new Error(code), { code });
}

function validNamespace (value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(value) &&
    value !== 'public' && !value.startsWith('pg_') && value !== 'information_schema';
}

// The operator ownership identity: reads authority rows, changes only owner actor
// rows and appends audit. It cannot delete rows, edit roles, subjects or policy
// values, or read any credential, secret or audit table.
const SHAPE = {
  tenant_authorization_config: { reads: true, inserts: false, updates: ['owner_fence'] },
  tenant_owner_policy: { reads: true, inserts: false, updates: ['owner_fence'] },
  tenant_owner_actors: { reads: true, inserts: true, updates: ['active', 'can_update', 'delegable'] },
  tenant_authorization_subjects: { reads: true, inserts: false, updates: [] },
  tenant_subject_admin_audit: { reads: false, inserts: true, updates: [] }
};
// Lifecycle control (tenant-phase.js): read-only, to refuse a change on a tenant
// that is suspended, mid-restore or in a deletion ceremony.
const CONTROL = Object.fromEntries(phase.TABLES.map(name => [name, { reads: true, inserts: false, updates: [] }]));

module.exports = async function createPostgresOwnership ({ connectionString, namespace, lifecycleNamespace }) {
  if (scope.getTenancyMode() !== 'multi' || !validNamespace(namespace) || !validNamespace(lifecycleNamespace) || lifecycleNamespace === namespace) {
    throw new TypeError('Ownership operations require explicit multi mode, a non-system namespace and a separate lifecycle control namespace');
  }
  let connection;
  try {
    connection = await postgresConnection({ connectionString, max: 4, connectionTimeoutMillis: 5000,
      statement_timeout: 5000, query_timeout: 5000, application_name: 'nightscout-ownership-ops' });
  } catch { throw failure('OWNERSHIP_STORE_UNAVAILABLE'); }
  const t = name => '"' + namespace + '".' + name;
  const config = t('tenant_authorization_config'), policy = t('tenant_owner_policy'), actors = t('tenant_owner_actors');
  const subjects = t('tenant_authorization_subjects'), audit = t('tenant_subject_admin_audit');

  async function transaction (tenant, fn) {
    if (typeof tenant !== 'string' || !UUID.test(tenant)) throw failure('OWNERSHIP_INVALID');
    try {
      return await connection.withTenant(tenant, async () => {
        await connection.query("SET LOCAL synchronous_commit = 'on'");
        return fn();
      });
    } catch (error) {
      if (KNOWN.includes(error.code)) throw failure(error.code);
      throw failure('OWNERSHIP_STORE_UNAVAILABLE');
    }
  }

  try {
    const lifecycle = name => '"' + lifecycleNamespace + '".' + name;
    const expected = new Map([...Object.entries(SHAPE).map(([name, shape]) => [t(name), shape]),
      ...Object.entries(CONTROL).map(([name, shape]) => [lifecycle(name), shape])]);
    const names = [...expected.keys()];
    const result = await transaction('00000000-0000-0000-0000-000000000000', () => connection.query(`
      SELECT '"' || n.nspname || '".' || c.relname AS name, c.relrowsecurity AND c.relforcerowsecurity AS secured,
        pg_has_role(current_user, c.relowner, 'MEMBER') AS owns,
        has_table_privilege(c.oid, 'SELECT') AS reads, has_any_column_privilege(c.oid, 'SELECT') AS column_reads,
        has_table_privilege(c.oid, 'INSERT') AS inserts, has_any_column_privilege(c.oid, 'INSERT') AS column_inserts,
        has_table_privilege(c.oid, 'UPDATE') AS table_updates,
        has_table_privilege(c.oid, 'DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(c.oid, 'REFERENCES') AS unsafe,
        ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          AND has_column_privilege(c.oid, a.attnum, 'UPDATE') ORDER BY a.attname) AS update_columns
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = ANY($1::regclass[])`, [names]));
    if (result.rows.length !== names.length || result.rows.some(row => {
      const shape = expected.get(row.name);
      return !shape || !row.secured || row.owns || row.unsafe || row.table_updates ||
        row.reads !== shape.reads || row.column_reads !== shape.reads ||
        row.inserts !== shape.inserts || row.column_inserts !== shape.inserts ||
        JSON.stringify(row.update_columns) !== JSON.stringify(shape.updates.slice().sort());
    })) throw failure('OWNERSHIP_STORE_UNSAFE');
  } catch (error) {
    await connection.end();
    throw failure(error.code === 'OWNERSHIP_STORE_UNSAFE' ? error.code : 'OWNERSHIP_STORE_UNSAFE');
  }

  // Lock order matches subject administration: configuration, then policy, then
  // actor rows. The policy row is taken FOR UPDATE, so every ownership change and
  // every owner-plane mutation (which holds it FOR SHARE) for the tenant serialize.
  async function locked (tenant) {
    const cfg = (await connection.query('SELECT tenant_id FROM ' + config + ' WHERE tenant_id=$1 FOR SHARE', [tenant])).rows[0];
    const current = (await connection.query('SELECT ceiling FROM ' + policy + ' WHERE tenant_id=$1 FOR UPDATE', [tenant])).rows[0];
    if (!cfg || !current || !permissionsValid(current.ceiling)) throw failure('OWNERSHIP_TENANT_UNKNOWN');
    const rows = (await connection.query('SELECT principal,consumer,active,can_update,delegable FROM ' + actors +
      ' WHERE tenant_id=$1 ORDER BY principal,consumer FOR UPDATE', [tenant])).rows;
    return { ceiling: current.ceiling, rows };
  }

  async function snapshot (tenant, extra = []) {
    const { ceiling, rows } = await locked(tenant);
    const wanted = [...new Set(rows.map(row => row.principal).concat(extra))];
    const present = new Set((await connection.query('SELECT subject_id FROM ' + subjects +
      ' WHERE tenant_id=$1 AND subject_id=ANY($2::text[])', [tenant, wanted])).rows.map(row => row.subject_id));
    // An owner is an active, updating actor whose subject still exists.
    const owners = sort(rows.filter(row => row.active === true && row.can_update === true && present.has(row.principal))
      .map(row => ({ principal: row.principal, consumer: row.consumer })));
    return { ceiling, actors: rows, subjects: present, owners,
      contained: permissions => permissionsContained(permissions, ceiling) };
  }

  async function record (actor, operation, target, outcome, detail) {
    const event = randomUUID();
    await connection.query('INSERT INTO ' + audit + ' (event_id,tenant_id,principal,consumer,subject_id,operation,event_time,outcome,detail)' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [event, actor.tenant, actor.principal, actor.consumer, target.principal, VERB[operation], Date.now(), outcome, JSON.stringify(detail)]);
    return event;
  }

  function targetOf (operation, proposal) { return operation === 'transfer' ? proposal.to : proposal.owner; }
  function describe (operation, proposal) {
    return operation === 'transfer' ? { from: proposal.from, to: proposal.to } : { owner: proposal.owner };
  }

  return Object.freeze({
    async list (actor, authorize) {
      return transaction(actor.tenant, async () => {
        await authorize(connection);
        const state = await snapshot(actor.tenant);
        return { owners: state.owners };
      });
    },
    async change (actor, operation, proposal, authorize) {
      if (!Object.hasOwn(VERB, operation)) throw failure('OWNERSHIP_INVALID');
      return transaction(actor.tenant, async () => {
        // Current operator authority first: an unauthorized or foreign operator
        // leaves no row, lock or audit effect in this tenant.
        await authorize(connection);
        // Lifecycle phase before any ownership row lock: a tenant that is
        // suspended, mid-restore or in a deletion ceremony takes no ownership
        // change. The shared window lock held to commit keeps a restore from
        // starting its data phase under this change.
        const lifecycle = await phase.tenantPhase(connection, { namespace: lifecycleNamespace, tenant: actor.tenant, hold: true });
        const target = targetOf(operation, proposal);
        const state = await snapshot(actor.tenant, [target.principal]);
        const decision = lifecycle.active ? plan(operation, proposal, state) : { code: 'OWNERSHIP_TENANT_INACTIVE' };
        const base = { ...describe(operation, proposal), expected: proposal.expectedOwners, before: state.owners,
          ...(lifecycle.active ? {} : { lifecycle: lifecycle.state }) };
        if (decision.code) {
          const event = await record(actor, operation, target, 'refused', { ...base, code: decision.code });
          return { outcome: 'refused', code: decision.code, event, owners: state.owners };
        }
        await connection.query('SAVEPOINT ownership_change');
        let changed = true;
        for (const row of decision.deactivate) {
          const result = await connection.query('UPDATE ' + actors + ' SET active=false WHERE tenant_id=$1 AND principal=$2 AND consumer=$3 AND active=true',
            [actor.tenant, row.principal, row.consumer]);
          if (result.rowCount !== 1) changed = false;
        }
        if (changed && decision.activate) {
          const { principal, consumer, delegable } = decision.activate;
          const result = await connection.query('INSERT INTO ' + actors + ' AS a (tenant_id,principal,consumer,active,can_update,delegable)' +
            ' VALUES ($1,$2,$3,true,true,$4) ON CONFLICT (tenant_id,principal,consumer) DO UPDATE' +
            ' SET active=true, can_update=true, delegable=EXCLUDED.delegable WHERE a.active=false OR a.can_update=false',
          [actor.tenant, principal, consumer, delegable]);
          if (result.rowCount !== 1) changed = false;
        }
        const after = changed ? await snapshot(actor.tenant) : null;
        if (!changed || !after.owners.length || !after.owners.some(owner => key(owner) === key(target))) {
          // A conditional write lost a race or would orphan the tenant: undo every
          // ownership write, keep the audit of the attempt.
          await connection.query('ROLLBACK TO SAVEPOINT ownership_change');
          const event = await record(actor, operation, target, 'refused', { ...base, code: 'OWNERSHIP_CONFLICT' });
          return { outcome: 'refused', code: 'OWNERSHIP_CONFLICT', event, owners: state.owners };
        }
        const event = await record(actor, operation, target, 'applied', { ...base, after: after.owners });
        return { outcome: 'applied', code: null, event, owners: after.owners };
      });
    },
    async close () { await connection.end(); }
  });
};
