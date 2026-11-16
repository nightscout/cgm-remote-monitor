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
function sql (domain, policy, params = new Params()) {
  const where = compileFilter(filters(policy)[domain], params);
  if (domain !== 'profile') return { where, tail: '', guard: 'false' };
  const order = compileSort({ startDate: -1, _id: -1 }, params);
  return { where, tail: ' ORDER BY ' + order.orderBy + ', ordinal ASC NULLS LAST, id_kind COLLATE "C", "_id" COLLATE "C" LIMIT 1',
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
module.exports = { KIND, AGE_EVENTS, create, validate, filters, select, compatible, sql, nextExpiry };
