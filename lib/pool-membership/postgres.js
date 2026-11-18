'use strict';

const connectionAdmission = require('../storage/connection-admission');

// One member of one pool kind, backed by the tables of
// lib/pool-membership/postgres-candidate.json:
//   pool_membership  one heartbeat row per member, keyed by pool kind, ordinal
//                    and member incarnation, so two processes claiming one
//                    ordinal are two visible rows (a conflict), not one
//                    overwritten row. Lease times are the database clock's.
//   pool_desired     one row per pool kind: the operator-set member count, the
//                    count it replaced, the slice rule and a revision. Pods
//                    carry only their ordinal (lib/pool-membership/assess.js).
//
// Capabilities, each a separate database identity:
//   member     pool_membership: SELECT; INSERT; UPDATE (heartbeat_at,
//              lease_expires_at, applied_members) only; DELETE (its own row on
//              close, its ordinal's expired rows on register). pool_desired: SELECT.
//   inspector  SELECT on both (operational reads; never writes, never alerts)
//   operator   pool_membership: SELECT. pool_desired: SELECT; INSERT; UPDATE
//              (members, previous_members, slice_rule, revision, updated_at).
//              The only writer of the member count (lib/pool-membership/operator.js).
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { run } = require('../migrations/postgres');
const { RULE, predicate, MAX_MEMBERS } = require('./slice');
const { assess } = require('./assess');
const { checkKind } = require('./config');
const transactionLock = require('./transaction-lock');

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const catalogue = require('./postgres-candidate.json');
const refuse = code => Object.assign(new Error(code), { code });
const q = name => '"' + name + '"';
function checkNamespace (namespace) {
  if (typeof namespace !== 'string' || !NAME.test(namespace) || ['public', 'information_schema'].includes(namespace) ||
      namespace.startsWith('pg_')) throw new TypeError('Explicit pool namespace required');
  return namespace;
}
const DESIRED_UPDATES = Object.freeze(['members', 'previous_members', 'revision', 'slice_rule', 'updated_at']);

function grants ({ namespace, member, inspector, operator }) {
  const table = q(checkNamespace(namespace)) + '.pool_membership', desired = q(namespace) + '.pool_desired';
  const statements = [];
  for (const role of [member, inspector, operator].filter(Boolean)) {
    if (!NAME.test(role)) throw new TypeError('Explicit pool role required');
    statements.push('GRANT USAGE ON SCHEMA ' + q(namespace) + ' TO ' + q(role),
      'GRANT SELECT ON ' + q(namespace) + '.schema_migrations TO ' + q(role),
      'GRANT SELECT ON ' + table + ' TO ' + q(role), 'GRANT SELECT ON ' + desired + ' TO ' + q(role));
  }
  if (member) statements.push('GRANT INSERT, DELETE, UPDATE (applied_members, heartbeat_at, lease_expires_at) ON ' + table + ' TO ' + q(member));
  if (operator) statements.push('GRANT INSERT, UPDATE (' + DESIRED_UPDATES.join(', ') + ') ON ' + desired + ' TO ' + q(operator));
  return Object.freeze(statements);
}

// Per table: [inserts, deletes, updatable columns]. Anything else refuses at boot.
const EXPECTED = Object.freeze({
  member: { pool_membership: [true, true, ['applied_members', 'heartbeat_at', 'lease_expires_at']], pool_desired: [false, false, []] },
  inspector: { pool_membership: [false, false, []], pool_desired: [false, false, []] },
  operator: { pool_membership: [false, false, []], pool_desired: [true, false, [...DESIRED_UPDATES]] }
});

const SNAPSHOT = `SELECT
  (SELECT json_build_object('members', d.members, 'previousMembers', d.previous_members, 'rule', d.slice_rule, 'revision', d.revision::text)
     FROM DESIRED d WHERE d.pool_kind = $1) AS desired,
  (SELECT coalesce(json_agg(json_build_object('ordinal', m.ordinal, 'memberId', m.member_id::text, 'rule', m.slice_rule, 'appliedMembers', m.applied_members,
     'live', m.lease_expires_at > now(),
     'leaseRemainingMs', floor(extract(epoch FROM (m.lease_expires_at - now())) * 1000)::bigint,
     'heartbeatAgeMs', floor(extract(epoch FROM (now() - m.heartbeat_at)) * 1000)::bigint) ORDER BY m.ordinal, m.member_id), '[]'::json)
     FROM TABLE m WHERE m.pool_kind = $1) AS rows`;

// Open a pool on a checked identity: schema current, privileges exactly the capability's.
function fixedObserver(window,profile){
 const windows=require('../tenant-lifecycle/operation-window'),data=require('../storage/postgres-datastore'),same=require('node:util').isDeepStrictEqual;
 if(!windows.isWindow(window)||window.intakeProfileDigest!==profile.digest||!window.datastore)throw refuse('POOL_FIXED_WINDOW_REQUIRED');
 const seen=new WeakMap(),live=new Map(),watched=new WeakSet();let failure;
 const observer=Object.freeze({backends:()=>{if(failure)throw failure;return Object.freeze([...live.values()]);},async observe(client){
  if(failure)throw failure;
  try{
  if(!windows.isWindow(window)||window.intakeProfileDigest!==profile.digest)throw refuse('POOL_FIXED_WINDOW_REQUIRED');
  const row=(await client.query('SELECT /* fixed-member-backend */ pg_backend_pid() AS pid,'+data.SQL+",current_user AS role,extract(epoch from (SELECT backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()))::text AS birth,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication,r.rolinherit,EXISTS(SELECT 1 FROM pg_roles other WHERE other.oid<>r.oid AND pg_has_role(r.oid,other.oid,'MEMBER')) AS memberships,EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_schema_privilege(n.oid,'CREATE')) AS schema_writes,EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f') AND NOT(n.nspname=$1 AND c.relname='pool_membership') AND (pg_has_role(current_user,c.relowner,'MEMBER') OR has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES'))) AS unrelated_writes FROM pg_roles r WHERE rolname=current_user",[profile.binding.membershipNamespace])).rows[0];
  if(!row||row.pid!==client.processID||!Number.isSafeInteger(row.pid)||row.pid<1||typeof row.role!=='string'||!row.role||typeof row.birth!=='string'||!row.birth||['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication','rolinherit','memberships','schema_writes','unrelated_writes'].some(key=>row[key]!==false))throw refuse('POOL_FIXED_BACKEND_REFUSED');
  const identity=Object.freeze({pid:row.pid,role:row.role,birth:row.birth}),database=data.identity(row),prior=seen.get(client);
  if(!same(database,window.datastore))throw refuse('POOL_FIXED_DATASTORE_REFUSED');
  if(prior&&(!same(prior.identity,identity)||!same(prior.database,database)))throw refuse('POOL_FIXED_BACKEND_CHANGED');
  if(!watched.has(client)){client.on('end',()=>live.delete(client));client.on('error',()=>live.delete(client));watched.add(client);}seen.set(client,{identity,database});live.set(client,identity);
  }catch(error){live.delete(client);failure=error;throw error;}
 }});
 return observer;
}

async function connect ({ kind, connectionString, namespace, capability, applicationName, fixedProtocol = false,observer, platformVerified = false }) {
  checkKind(kind); checkNamespace(namespace);
  if (!Object.hasOwn(EXPECTED, capability)) throw new TypeError('Pool capability must be member, inspector or operator');
  if (typeof fixedProtocol !== 'boolean') throw new TypeError('Explicit fixed protocol selection required');
  const selectedCatalogue = fixedProtocol ? require('../../migrations/candidates/postgres-pool-mutation-v1.json') : catalogue;
  // platformVerified: a serving role that checked its platform proof at start;
  // the admin pre-start step ran these ledger and privilege screens (vcpool-proof-role).
  if (!platformVerified) await run('check', { direct: true, connectionString, namespace, catalogue: selectedCatalogue, statementTimeoutMs: 5000 });
  const selectedPoolOptions = { connectionString, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 5000,
    application_name: applicationName || 'nightscout-pool-' + kind };
  const pool = new (connectionAdmission.wrapPool(Pool, require('pg').Client, selectedPoolOptions.application_name))(
    connectionAdmission.poolOptions(selectedPoolOptions.application_name, selectedPoolOptions));
  // An idle client that loses its backend emits on the pool; without a listener
  // that is an uncaught exception (decision datastore-loss-recover-in-place).
  // The pool opens a new backend on its next statement; the heartbeat retries.
  pool.on('error', error => console.error('PostgreSQL pool-membership idle connection error:', error.code || error.name));
  require('../diagnostics/m7').observePool(pool, 'storage');
  if (!platformVerified) try {
    for (const [name, [inserts, deletes, updates]] of Object.entries(EXPECTED[capability])) {
      const row = (await pool.query(`SELECT pg_has_role(current_user, c.relowner, 'MEMBER') AS owns,
          has_table_privilege(c.oid, 'SELECT') AS reads, has_table_privilege(c.oid, 'INSERT') AS inserts,
          has_table_privilege(c.oid, 'DELETE') AS deletes, has_table_privilege(c.oid, 'TRUNCATE,TRIGGER,REFERENCES') AS destroys,
          ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            AND has_column_privilege(c.oid, a.attnum, 'UPDATE') ORDER BY a.attname) AS updates
        FROM pg_class c WHERE c.oid = to_regclass($1)`, [q(namespace) + '.' + name])).rows[0];
      if (!row || row.owns || row.destroys || !row.reads || row.inserts !== inserts || row.deletes !== deletes ||
          JSON.stringify(row.updates) !== JSON.stringify(updates)) throw refuse('POOL_STORE_UNSAFE');
    }
  } catch (error) {
    await pool.end();
    throw error.code === 'POOL_STORE_UNSAFE' ? error : refuse('POOL_STORE_UNAVAILABLE');
  }
  if (fixedProtocol) {
    try { await require('./fixed-protocol').assertInstalled(pool.query.bind(pool), namespace); }
    catch (error) { await pool.end(); throw error; }
  }
  const table = q(namespace) + '.pool_membership', desired = q(namespace) + '.pool_desired';
  async function snapshot (client = pool, which = kind) {
    let owned;if(observer&&client===pool)owned=client=await pool.connect();
    try{
    if(observer)await observer.observe(client);
    const row = (await client.query(SNAPSHOT.replace('DESIRED', desired).replace('TABLE', table), [checkKind(which)])).rows[0];
    const d = row.desired;
    return { desired: d ? Object.freeze({ members: d.members, previousMembers: d.previousMembers, rule: d.rule, revision: fixedProtocol ? String(d.revision) : Number(d.revision) }) : null,
      rows: row.rows.map(r => Object.freeze({ ...r, leaseRemainingMs: Number(r.leaseRemainingMs), heartbeatAgeMs: Number(r.heartbeatAgeMs) })) };
    }finally{owned?.release();}
  }
  return { pool, table, desired, snapshot };
}

async function create ({ kind, ordinal, leaseMs, connectionString, namespace, capability = 'member',
  onAlert = event => console.error('Pool membership alert:', JSON.stringify(event)), applicationName, fixedProtocol = false, intakeProfile,operationWindow, platformVerified = false } = {}) {
  checkKind(kind); checkNamespace(namespace);
  const selected=intakeProfile===undefined?undefined:require('../pgstream/intake-profile').validate(intakeProfile);
  if(selected&&(!fixedProtocol||kind!=='evaluator'||namespace!==selected.binding.membershipNamespace||!Number.isSafeInteger(ordinal)||ordinal<0||ordinal>=selected.binding.members||capability!=='member'))throw new TypeError('POOL_FIXED_INTAKE_PROFILE_BINDING');
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= MAX_MEMBERS) throw new TypeError('Pool ordinal must be 0..' + (MAX_MEMBERS - 1));
  if (!['member', 'inspector'].includes(capability)) throw new TypeError('Pool capability must be member or inspector');
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 600000) throw new TypeError('Pool lease must be 100..600000 ms');
  if (typeof onAlert !== 'function') throw new TypeError('Pool alert sink must be a function');
  if(selected)await operationWindow?.ready();
  const observer=selected?fixedObserver(operationWindow,selected):null;
  // The reviewed schema must be current before any membership statement.
  if (typeof platformVerified !== 'boolean' || platformVerified && (fixedProtocol || capability !== 'member')) throw new TypeError('Platform-verified pool members are plain members');
  const { pool, table, snapshot } = await connect({ kind, connectionString, namespace, capability, applicationName, fixedProtocol,observer, platformVerified });

  const memberId = randomUUID();
  const self = Object.freeze({ memberId, ordinal, rule: RULE });
  const predicates = new Map();
  const none = Object.freeze(() => false);
  const sliceOf = members => {
    if (ordinal >= members) return none;
    if (!predicates.has(members)) predicates.set(members, predicate(members, ordinal));
    return predicates.get(members);
  };
  let registered = false, closed = false, retired = false, registrationAttempted = false, alerted = null, applied = selected?.binding.members??null;
  const ownRow = [kind, ordinal, memberId];
  // Configured: what this process was started with. The member count is not
  // configuration; it is observed from the desired row.
  const configured = Object.freeze({ mode: 'partitioned', ordinal, rule: RULE, leaseMs, memberId });

  async function observe () {
    const { desired, rows } = await snapshot();
    return { desired, rows: rows.map(row => Object.freeze({ ...row, self: row.memberId === memberId })) };
  }
  function signal (reason, detail) {
    if (reason === alerted) return;
    const previous = alerted; alerted = reason;
    try {
      if (reason) onAlert({ kind, ordinal, state: 'refused', reason, ...detail });
      else if (previous) onAlert({ kind, ordinal, state: 'recovered', previous });
    } catch { /* an alert sink never changes the verdict */ }
  }
  async function write (fn) {
    const client = await pool.connect(); let failure;
    try {
      if(observer)await observer.observe(client);
      await client.query('BEGIN');
      const lock=await transactionLock.lock(client.query.bind(client), namespace, kind);
      if(observer&&lock.backend_pid!==client.processID)throw refuse('POOL_FIXED_BACKEND_CHANGED');
      const result = await fn(client);
      const committed = await client.query('COMMIT');
      if (committed.command !== 'COMMIT') throw refuse('POOL_COMMIT_UNCONFIRMED');
      return result;
    } catch (error) { failure = error; await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(failure); }
  }
  async function renew (client, initial = false) {
    if (fixedProtocol && !initial) {
      const result = await client.query(`UPDATE ${table} SET heartbeat_at=clock_timestamp(),
        lease_expires_at=clock_timestamp()+$5*interval '1 millisecond',applied_members=$4
        WHERE pool_kind=$1 AND ordinal=$2 AND member_id=$3 AND lease_expires_at>clock_timestamp()`, [...ownRow,applied,leaseMs]);
      if (result.rowCount !== 1) { retired = true; throw refuse('POOL_INCARNATION_EXPIRED'); }
      return;
    }
    await client.query(`INSERT INTO ${table} (pool_kind, ordinal, member_id, slice_rule, applied_members, registered_at, heartbeat_at, lease_expires_at)
      VALUES ($1, $2, $3, $4, $5, clock_timestamp(), clock_timestamp(), clock_timestamp() + $6 * interval '1 millisecond')
      ON CONFLICT (pool_kind, ordinal, member_id) DO UPDATE SET heartbeat_at = clock_timestamp(), lease_expires_at = EXCLUDED.lease_expires_at,
        applied_members = EXCLUDED.applied_members`,
    [...ownRow, RULE, applied, leaseMs]);
  }
  const writer = capability === 'member';
  const member = {
    kind, capability, configured,...(observer?{backends:observer.backends}:{}),
    async register () {
      if (!writer) throw refuse('POOL_FORBIDDEN');
      if (closed || retired) throw refuse(closed ? 'POOL_CLOSED' : 'POOL_INCARNATION_EXPIRED');
      if (registered) return { registered: true, memberId };
      if (fixedProtocol && registrationAttempted) { retired = true; throw refuse('POOL_INCARNATION_UNCERTAIN'); }
      registrationAttempted = true;
      try {
        // The predecessor incarnation of this ordinal, if its lease expired, is
        // removed; a live one stays and is reported as a duplicate ordinal.
        await write(async client => {
          await client.query(`DELETE FROM ${table} WHERE pool_kind = $1 AND ordinal = $2 AND lease_expires_at <= clock_timestamp()`, [kind, ordinal]);
          await renew(client, true);
        });
      } catch (error) {const failure=refuse('POOL_UNAVAILABLE');if(observer)failure.cause=error;throw failure;}
      registered = true;
      return { registered: true, memberId };
    },
    async heartbeat () {
      if (!writer) throw refuse('POOL_FORBIDDEN');
      if (closed || retired || !registered) return { renewed: false, reason: closed ? 'POOL_CLOSED' : retired ? 'POOL_INCARNATION_EXPIRED' : 'POOL_NOT_REGISTERED' };
      try { await write(client => renew(client)); return { renewed: true }; } catch { return { renewed: false, reason: retired ? 'POOL_INCARNATION_EXPIRED' : 'POOL_UNAVAILABLE' }; }
    },
    // Read before each cycle. A refusal is fail-closed and raises the alert on
    // each change of reason; recovery is signalled once. The slice follows the
    // effective member count of this read, so it changes in-process when the
    // operator's count takes effect.
    async slice () {
      if (!writer) throw refuse('POOL_FORBIDDEN');
      if (closed || retired || !registered) return Object.freeze({ eligible: false, reason: closed ? 'POOL_CLOSED' : retired ? 'POOL_INCARNATION_EXPIRED' : 'POOL_NOT_REGISTERED', conflicts: [] });
      if(selected){
        let verdict;try{const seen=await observe();verdict=selected.assignment.select({self,rows:seen.rows,desired:seen.desired});}catch{return Object.freeze({eligible:false,reason:'POOL_UNAVAILABLE',conflicts:[]});}
        signal(verdict.eligible?null:verdict.reason,{});return verdict;
      }
      let verdict;
      try { const seen = await observe(); verdict = assess(self, seen.rows, seen.desired); } catch {
        signal('POOL_UNAVAILABLE', {});
        return Object.freeze({ eligible: false, reason: 'POOL_UNAVAILABLE', conflicts: [] });
      }
      if (!verdict.eligible) {
        signal(verdict.reason, { conflicts: verdict.conflicts });
        return Object.freeze({ eligible: false, reason: verdict.reason, conflicts: verdict.conflicts });
      }
      signal(null);
      // Record the count this member now works, at once, so that peers stop
      // falling back to the previous count after this member has switched.
      if (verdict.members !== applied) {
        applied = verdict.members;
        try { await write(client => renew(client)); } catch { return Object.freeze({ eligible: false, reason: 'POOL_UNAVAILABLE', conflicts: [] }); }
      }
      return Object.freeze({ eligible: true, includes: sliceOf(verdict.members), members: verdict.members, ordinal, rule: RULE,
        desiredMembers: verdict.desiredMembers, revision: verdict.revision, switching: verdict.switching, outside: verdict.outside,
        missingOrdinals: verdict.missingOrdinals });
    },
    // Read-only: configured values beside observed membership. Never writes,
    // renews, alerts or changes eligibility.
    async inspect () {
      let observed;
      try {
        const seen = await observe();
        const verdict = selected?selected.assignment.select({self,rows:seen.rows,desired:seen.desired}):assess(self, seen.rows, seen.desired);
        observed = { rows: seen.rows, desired: seen.desired, members: verdict.members??selected?.binding.members, switching: verdict.switching, outside: verdict.outside,
          liveOrdinals: verdict.liveOrdinals, missingOrdinals: verdict.missingOrdinals,
          conflicts: verdict.conflicts, eligible: writer && registered && !closed && !retired && verdict.eligible,
          reason: !writer ? 'POOL_INSPECTOR' : !registered ? 'POOL_NOT_REGISTERED' : closed ? 'POOL_CLOSED' : retired ? 'POOL_INCARNATION_EXPIRED' : verdict.reason };
      } catch { observed = { unavailable: true, eligible: false, reason: 'POOL_UNAVAILABLE' }; }
      return Object.freeze({ kind, configured, observed: Object.freeze(observed) });
    },
    async close () {
      if (closed) return;
      closed = true;
      try {
        if (registered) await write(client => client.query(`DELETE FROM ${table} WHERE pool_kind = $1 AND ordinal = $2 AND member_id = $3`, ownRow));
      } finally { await pool.end(); }
    }
  };
  return Object.freeze(member);
}

module.exports = { create, connect, grants, catalogue, checkNamespace };
