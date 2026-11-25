'use strict';

// A conservative superset of the property view's actual reads. Keep every row
// in each time range so deleting/correcting a winner needs no ranked fallback,
// except profiles (one winner, with explicit historical recovery on mutation).
const loader = require('../data/dataloader');
const bounds = require('../data/views/bounds');
const { fromMongo } = require('./filter');
const { selectRows } = require('./projection-memory-read');
const { Params, compileFilter, compileSort } = require('./postgres-filter');
const KIND = 'clinical-window-v1';
const AGE_EVENTS = Object.freeze(['Sensor Start', 'Sensor Change', 'Sensor Stop', 'Site Change', 'Insulin Change', 'Pump Battery Change']);
function create (env, at) {
  if (!Number.isSafeInteger(at) || Math.abs(at) >= 8640000000000000 - 372 * 86400000) throw new TypeError('CLINICAL_WINDOW_INSTANT');
  return Object.freeze({ kind: KIND, at, devicestatusMs: bounds.devicestatusLookback(env) });
}
function validate (policy) {
  if (policy?.kind !== KIND || !Number.isSafeInteger(policy.at) || ![86400000, 172800000].includes(policy.devicestatusMs)) throw new Error('CLINICAL_WINDOW_CONTRACT');
  create({ extendedSettings: {} }, policy.at);
  return policy;
}
function filters (policy) {
  const { at, devicestatusMs } = validate(policy);
  const env = { extendedSettings: { devicestatus: { days: devicestatusMs / 86400000 } } };
  const context = { cache: { isEmpty: () => true } };
  const visible = find => fromMongo({ $and: [{ isValid: { $ne: false } }, find] });
  return {
    entries: visible(loader.rawQuery('entries', { lastUpdated: at }, context, env).find),
    treatments: visible({ $or: [...bounds.properties.treatments(at).map(q => q.find),
      loader.profileSwitchQuery(at).find, ...AGE_EVENTS.map(event => loader.latestSingleQuery(at, event).find)] }),
    devicestatus: visible(loader.rawQuery('devicestatus', { lastUpdated: at }, context, env).find),
    profile: visible({}), food: fromMongo({ _id: { $in: [] } }), activity: fromMongo({ _id: { $in: [] } })
  };
}
function select (rows, policy) {
  const ast = filters(policy), out = [];
  for (const domain of Object.keys(ast)) out.push(...selectRows(rows.filter(row => row.domain === domain), ast[domain],
    domain === 'profile' ? { sort: { startDate: -1, _id: -1 }, limit: 1 } : {}));
  return out;
}
function compatible (saved, next) {
  return saved?.kind === KIND && next?.kind === KIND && saved.devicestatusMs >= next.devicestatusMs && saved.at <= next.at;
}
// Apply exactly the same filter AST in PostgreSQL and in receipt/expiry memory.
// The existing profile reader refuses array/object sort keys across the whole
// matching population; retain that guard even for the one-row winner.
// Spike S1b: the window reads each table's stored time column directly.
// Single tenant asks MongoDB for date/created_at $gte a bound (dataloader
// rawQuery, profileSwitchQuery, latestSingleQuery), with type bracketing: a
// numeric bound matches only numbers, a string bound only strings compared
// bytewise, and an array matches when any element does. Migration 0001 of
// each windowed table stores that once at write: entries "date" is the
// greatest numeric element, floored, in int8 (window_time_ms); devicestatus
// and treatments created_at is the greatest string element in C collation
// (window_time_text); NULL matches no bound. So "column >= bound" is exactly
// the single-tenant time predicate, needs no NULL branch, and is an index
// condition under the tenant's row-level security binding (int8 and text
// comparisons are leakproof; numeric is not). The rest of each find (isValid,
// eventType, duration) stays the compiled document filter, which follows
// MongoDB semantics. Treatments' age-event and profile-switch arms read
// through the (tenant_id, "eventType", created_at) index; a row whose
// eventType is not a string (an array) has its own small branch.
// An unrecognised filter shape falls back to one unbounded branch with the
// whole document filter (exact, not index-bounded); bounded() reports it.
const RANGE = Object.freeze({
  entries: Object.freeze({ field: 'date', type: 'number', key: '"date"', cast: '::bigint' }),
  devicestatus: Object.freeze({ field: 'created_at', type: 'string', key: 'created_at COLLATE "C"', cast: '::text COLLATE "C"' }),
  treatments: Object.freeze({ field: 'created_at', type: 'string', key: 'created_at COLLATE "C"', cast: '::text COLLATE "C"' })
});
// A numeric bound must be an integer for floor(date) >= bound to equal date >= bound.
const isBound = (node, spec) => node?.op === 'gte' && node.field === spec.field && typeof node.value === spec.type &&
  (spec.type === 'string' || Number.isSafeInteger(node.value));
const lowest = values => values.reduce((a, b) => (b < a ? b : a));
function ranges (domain, ast) {
  const spec = RANGE[domain];
  if (!spec || ast?.op !== 'and') return null;
  const valid = ast.nodes.filter(node => node.op === 'ne' && node.field === 'isValid');
  const rest = ast.nodes.filter(node => !valid.includes(node));
  if (valid.length !== 1 || rest.length !== 1) return null;
  const [node] = rest;
  if (isBound(node, spec)) return { spec, valid: valid[0], recent: node.value, arms: [] };
  if (node.op !== 'or' || domain !== 'treatments') return null;
  const recent = node.nodes.filter(arm => isBound(arm, spec));
  if (recent.length !== 1) return null;
  const arms = [];
  for (const arm of node.nodes) {
    if (arm === recent[0]) continue;
    if (arm.op !== 'and') return null;
    const eq = arm.nodes.filter(n => n.op === 'eq' && n.field === 'eventType' && typeof n.value === 'string');
    const gte = arm.nodes.filter(n => isBound(n, spec));
    if (eq.length !== 1 || gte.length !== 1) return null;
    arms.push({ arm, event: eq[0].value, lo: gte[0].value });
  }
  return { spec, valid: valid[0], recent: recent[0].value, arms };
}
function branches (domain, ast, params) {
  const found = ranges(domain, ast);
  if (!found) return [compileFilter(ast, params)];
  const { spec, valid, recent, arms } = found, bound = value => params.add(value) + spec.cast;
  const filter = node => compileFilter({ op: 'and', nodes: [valid, node] }, params);
  const lo0 = bound(recent), out = ['(' + spec.key + ' >= ' + lo0 + ') AND ' + compileFilter(valid, params)];
  if (!arms.length) return out;
  // Rows at or after the recent bound are all in the first branch; below it
  // only the arms can match, each by its own compiled conditions.
  for (const { arm, event, lo } of arms) {
    out.push('("eventType" = ' + params.add(event) + '::text AND ' + spec.key + ' >= ' + bound(lo) + ' AND ' + spec.key + ' < ' + lo0 + ') AND ' + filter(arm));
  }
  out.push('("eventType" IS NULL AND ' + spec.key + ' >= ' + bound(lowest(arms.map(a => a.lo))) + ' AND ' + spec.key + ' < ' + lo0 + ') AND ' +
    filter({ op: 'or', nodes: arms.map(a => a.arm) }));
  return out;
}
function bounded (domain, policy) { return !!ranges(domain, filters(policy)[domain]); }
function sql (domain, policy, params = new Params()) {
  const ast = filters(policy)[domain];
  if (domain !== 'profile') return { branches: branches(domain, ast, params), tail: '', guard: 'false' };
  const where = compileFilter(ast, params), order = compileSort({ startDate: -1, _id: -1 }, params);
  return { branches: [where], tail: ' ORDER BY ' + order.orderBy + ', ordinal ASC NULLS LAST, id_kind COLLATE "C", "_id" COLLATE "C" LIMIT 1',
    guard: 'bool_or(' + order.unsortable + ') OVER ()' };
}
// Schedule only a real membership edge, using canonical timestamps as an
// optimization. Noncanonical values retain native lexical/array semantics and
// remain cap-bounded; the policy never discards them through Date.parse.
function nextExpiry (rows, policy) {
  let next = Infinity;
  for (const row of rows) {
    const spans = row.domain === 'entries' ? [172800000] : row.domain === 'devicestatus' ? [policy.devicestatusMs]
      : row.domain === 'treatments' ? [60 * 3600000, 62 * 86400000, 372 * 86400000] : [];
    const value = row.doc[row.domain === 'entries' ? 'date' : 'created_at'];
    for (const v of Array.isArray(value) ? value : [value]) {
      const t = row.domain === 'entries' && typeof v === 'number' ? v
        : typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v ? Date.parse(v) : NaN;
      for (const span of spans) if (Number.isFinite(t) && t + span + 1 > policy.at) next = Math.min(next, t + span + 1);
    }
  }
  return Number.isFinite(next) ? next : null;
}
// Resident window: the instants at which one row leaves a window by
// nextExpiry's rule, ascending. A resident row's are computed once; the next
// expiry of a window is then the first of each row's that is after the instant.
function expiryInstants (row, devicestatusMs) {
  const spans = row.domain === 'entries' ? [172800000] : row.domain === 'devicestatus' ? [devicestatusMs]
    : row.domain === 'treatments' ? [60 * 3600000, 62 * 86400000, 372 * 86400000] : [];
  const out = [];
  const value = row.doc[row.domain === 'entries' ? 'date' : 'created_at'];
  for (const v of Array.isArray(value) ? value : [value]) {
    const t = row.domain === 'entries' && typeof v === 'number' ? v
      : typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v ? Date.parse(v) : NaN;
    for (const span of spans) if (Number.isFinite(t)) out.push(t + span + 1);
  }
  return out.sort((a, b) => a - b);
}
// Resident window (lib/storage/resident-window.js): the membership of rows
// already read, by the stored window time each was read with. Per bounded
// domain: `recent`, at or above which every visible row is a member (the first
// branch of sql()); and for treatments the whole filter, which decides the
// rows between `lowest` and `recent` (the event arms). null when a domain's
// filter is not of the bounded shape: such a policy has no resident window.
function membership (policy) {
  const ast = filters(policy), out = {};
  for (const domain of Object.keys(RANGE)) {
    const found = ranges(domain, ast[domain]);
    if (!found) return null;
    out[domain] = { recent: found.recent, lowest: found.arms.length ? lowest(found.arms.map(arm => arm.lo)) : found.recent,
      ast: found.arms.length ? ast[domain] : null };
  }
  return out;
}
module.exports = { KIND, AGE_EVENTS, RANGE, create, validate, filters, select, compatible, sql, bounded, nextExpiry, expiryInstants, membership };
