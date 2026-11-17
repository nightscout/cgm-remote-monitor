'use strict';

// Trusted background workers read scheduling metadata across their assigned
// roster. Ordinary role grants/policies provide that visibility; no tenant
// discriminator switching, definer function or per-call catalogue inspection.
const { createHash } = require('node:crypto');
const { resolveEffectiveSettings } = require('../tenant-settings/component');
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const quote = name => '"' + name + '"';
const failure = () => Object.assign(new Error('TRUSTED_WORKER_UNAVAILABLE'), { code: 'TRUSTED_WORKER_UNAVAILABLE' });
function parse (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'activity,clock,operatorPolicy,settings' ||
      Object.values(value).some(name => typeof name !== 'string' || !NAME.test(name) || ['public', 'information_schema'].includes(name) || name.startsWith('pg_')) ||
      new Set(Object.values(value)).size !== 4) throw new TypeError('Trusted worker requires four explicit metadata namespaces');
  return Object.freeze({ ...value });
}
function relations (input) {
  const ns = parse(input);
  return [
    { name: quote(ns.activity) + '.tenant_activity', columns: ['tenant_id', 'version', 'paused', 'suspended'] },
    { name: quote(ns.clock) + '.tenant_write_clock', columns: ['tenant_id', 'last_stamp', 'last_delete_stamp'] },
    { name: quote(ns.settings) + '.tenant_settings', columns: ['tenant_id', 'version', 'values'] },
    { name: quote(ns.operatorPolicy) + '.tenant_operator_policy', columns: ['tenant_id', 'generation', 'policy'] }
  ];
}
function grants ({ namespaces, roles }) {
  if (!Array.isArray(roles) || !roles.length || new Set(roles).size !== roles.length || roles.some(role => !NAME.test(role))) throw new TypeError('Explicit trusted worker roles required');
  const result = [];
  for (const role of roles) {
    // A policy is scoped to this trusted login, never PUBLIC or a serving role.
    const policy = 'trusted_worker_' + createHash('sha256').update(role).digest('hex').slice(0, 16);
    for (const table of relations(namespaces)) result.push(
      'GRANT USAGE ON SCHEMA ' + table.name.split('.')[0] + ' TO ' + quote(role),
      'GRANT SELECT (' + table.columns.map(quote).join(',') + ') ON ' + table.name + ' TO ' + quote(role),
      'DROP POLICY IF EXISTS ' + quote(policy) + ' ON ' + table.name,
      'CREATE POLICY ' + quote(policy) + ' ON ' + table.name + ' FOR SELECT TO ' + quote(role) + ' USING (true)');
  }
  return Object.freeze(result);
}
function create ({ connection, namespaces, now = Date.now, stream = false }) {
  if (typeof connection?.readOnly !== 'function' || typeof now !== 'function') throw new TypeError('Trusted worker read-only connection required');
  if(typeof stream!=='boolean')throw new TypeError('Explicit trusted stream metadata mode required');
  const [activity, clock, settings, policy] = relations(namespaces).map(row => row.name);
  const clockJoin=stream?'':`LEFT JOIN ${clock} c USING(tenant_id)`;
  const metadata = new Map(), settingsCache = new Map(), loading = new Map(), pendingReads = new Set(), revisions = new Map();
  let available = false, closed = false, generation = 0;
  const counters = { scans: 0, settingsReads: 0, settingsHits: 0, operationalChecks: 0, refusals: 0 };
  const ids = tenants => {
    const list = [...tenants];
    if (list.length > 20000 || new Set(list).size !== list.length || list.some(id => !UUID.test(id))) throw new TypeError('Distinct canonical worker tenants required');
    return list;
  };
  function invalidate () { generation++; available = false; metadata.clear(); settingsCache.clear(); }
  async function query (text, values) {
    if (closed || !available) throw failure();
    const expected = generation;
    try {
      const result = await connection.readOnly(text, values);
      if (closed || generation !== expected || !available) throw failure();
      return result;
    }
    catch { counters.refusals++; if (generation === expected) invalidate(); throw failure(); }
  }
  async function verify () {
    if (closed) throw failure();
    const verifyingGeneration = generation;
    counters.operationalChecks++;
    const expected = relations(namespaces).filter(row=>!stream||row.name!==clock);
    try {
      const rows = (await connection.readOnly(`SELECT c.oid::regclass::text AS relation,
        c.relrowsecurity AND c.relforcerowsecurity AS secured,
        pg_has_role(current_user,c.relowner,'MEMBER') AS owns,
        has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES') AS writes
        FROM pg_class c WHERE c.oid=ANY($1::regclass[])`, [expected.map(row => row.name)])).rows;
      if (rows.length !== expected.length || rows.some(row => !row.secured || row.owns || row.writes)) throw failure();
      // Planning the exact projection validates the required SELECT columns;
      // an empty roster does not scan tenants or load clinical/settings values.
      await connection.readOnly(`SELECT a.tenant_id,a.version,a.paused,a.suspended,${stream?'NULL::bigint AS last_stamp,NULL::bigint AS last_delete_stamp':'c.last_stamp,c.last_delete_stamp'},s.version,s.values,p.generation,p.policy
        FROM ${activity} a ${clockJoin} LEFT JOIN ${settings} s USING(tenant_id)
        LEFT JOIN ${policy} p USING(tenant_id) WHERE false`);
      if (closed || generation !== verifyingGeneration) throw failure();
      available = true;
    } catch { counters.refusals++; if (generation === verifyingGeneration) invalidate(); throw failure(); }
  }
  async function scan (tenants, { recovery = false } = {}) {
    const list = ids(tenants); counters.scans++;
    if (recovery) for (const tenant of list) { settingsCache.delete(tenant); revisions.set(tenant, (revisions.get(tenant) || 0) + 1); }
    const expectedRevisions = new Map(list.map(tenant => [tenant, revisions.get(tenant)]));
    if (!list.length) return new Map();
    const rows = (await query(`SELECT a.tenant_id::text AS tenant,a.version::text AS activity_version,a.paused,a.suspended,
      s.version AS settings,p.generation AS policy,${stream?'NULL::text AS stamp,NULL::text AS deleted':'c.last_stamp::text AS stamp,c.last_delete_stamp::text AS deleted'}
      FROM ${activity} a ${clockJoin} LEFT JOIN ${settings} s USING(tenant_id)
      LEFT JOIN ${policy} p USING(tenant_id) WHERE a.tenant_id=ANY($1::uuid[])`, [list])).rows;
    if (list.some(tenant => revisions.get(tenant) !== expectedRevisions.get(tenant))) throw failure();
    const found = new Map(list.map(tenant => [tenant, null]));
    for (const row of rows) {
      if (!found.has(row.tenant) || found.get(row.tenant) !== null || typeof row.paused !== 'boolean' || typeof row.suspended !== 'boolean' ||
          typeof row.activity_version !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.activity_version) || BigInt(row.activity_version) > 9223372036854775807n) { invalidate(); throw failure(); }
      const state = require('../tenant-activity/policy').stateOf(row);
      const value = Object.freeze({ ...row, activity: Object.freeze({ tenant: row.tenant, version: row.activity_version, paused: row.paused, suspended: row.suspended, state }),
        signature: row.stamp === null ? null : Object.freeze({ stamp: row.stamp, deleted: row.deleted }) });
      const previous = metadata.get(row.tenant);
      if (previous && (previous.settings !== value.settings || previous.policy !== value.policy)) { revisions.set(row.tenant, (revisions.get(row.tenant) || 0) + 1); settingsCache.delete(row.tenant); }
      found.set(row.tenant, value); metadata.set(row.tenant, value);
    }
    for (const [tenant, row] of found) if (!row) { metadata.delete(tenant); settingsCache.delete(tenant); }
    return found;
  }
  async function read (tenant, { force = false } = {}) {
    ids([tenant]);
    if (closed || !available) throw failure();
    const row = metadata.get(tenant), hit = settingsCache.get(tenant);
    if (!force && row && hit && hit.settings === row.settings && hit.policy === row.policy) { counters.settingsHits++; return hit.value; }
    if (force) { revisions.set(tenant, (revisions.get(tenant) || 0) + 1); settingsCache.delete(tenant); }
    const inFlight = loading.get(tenant);
    if (inFlight && inFlight.generation === generation && inFlight.revision === revisions.get(tenant)) return inFlight.promise;
    const readingGeneration = generation, readingRevision = revisions.get(tenant);
    const pending = (async () => {
      counters.settingsReads++;
      const result = (await query(`SELECT s.version,s.values,p.generation,p.policy FROM ${settings} s
        JOIN ${policy} p USING(tenant_id) WHERE s.tenant_id=$1`, [tenant])).rows[0];
      if (!result || closed || readingGeneration !== generation || readingRevision !== revisions.get(tenant) || !available) throw failure();
      const value = resolveEffectiveSettings({ version: result.version, values: result.values }, { ...result.policy, generation: result.generation });
      const snapshot = Object.freeze({ ...value, policyGeneration: result.generation, readAt: now() });
      settingsCache.set(tenant, { settings: result.version, policy: result.generation, value: snapshot });
      return snapshot;
    })().finally(() => { pendingReads.delete(pending); if (loading.get(tenant)?.promise === pending) loading.delete(tenant); });
    pendingReads.add(pending);
    loading.set(tenant, { promise: pending, generation: readingGeneration, revision: readingRevision }); return pending;
  }
  const state = () => Object.freeze({ available: available && !closed, generation });
  Object.defineProperty(scan, 'state', { value: state });
  return Object.freeze({ scan, read, verify, invalidate, state, current: tenant => metadata.get(tenant) || null,
    remove (tenant) { revisions.set(tenant, (revisions.get(tenant) || 0) + 1); metadata.delete(tenant); settingsCache.delete(tenant); },
    health: () => ({ available: available && !closed, ...counters }),
    async close () { closed = true; invalidate(); await Promise.allSettled([...pendingReads]); } });
}
module.exports = { parse, relations, grants, create };
