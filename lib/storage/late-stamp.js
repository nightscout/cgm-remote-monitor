'use strict';

// NS_CLOCK_LATE_STAMP (INC-G, off by default): the tenant write clock is taken
// last. A late-stamp transaction does its reads without the clock row; when a
// batch only inserts new rows it then takes the clock row and inserts them in
// one set-based statement. The clock row is held across a fixed number of
// statements, whatever the batch size:
//
//   UPDATE tenant_write_clock ... RETURNING   (reserve every stamp handed out)
//   SELECT the rows committed since the transaction began (srvModified > S0)
//   INSERT ... SELECT (the batch, one statement)
//   [the writer-driven pending mark]
//   COMMIT
//
// What the clock guarantees is unchanged: every stamp is reserved under the
// clock row and the row is held until COMMIT, so a v3 history cursor never
// passes a stamp whose transaction has not committed.
//
// What the clock also did implicitly, and how this path keeps it:
//   - dedup lookups saw the last committed state. Every history write commits
//     under the clock with stamps above S0, the clock value read before the
//     first read here. Under the clock, one statement reads the rows committed
//     since; if any matches a filter read here, or is a row read here, the
//     batch is not inserted set-based: it runs the per-operation path, which
//     decides each row again under the clock (SELECT ... FOR UPDATE, and the
//     unique indexes whose races write-intent already resolves). Two
//     concurrent batches with the same identities therefore never both insert.
//   - lock order: rows are inserted after the clock row is held (clock, then
//     the per-tenant insertion-ordinal row), as in every other path, so the
//     paths cannot deadlock. A write this path does not insert set-based takes
//     the clock first and then runs as before.
//   - decisions write-intent makes from reads before the clock (carried server
//     dates, on-deleted, merge on match) follow MongoDB's race model, which
//     write-intent was written for: the stored row itself is still decided
//     under the clock.
//
// Stamps handed out before the clock is held are provisional (PROVISIONAL +
// k): visible only inside this transaction. Under the clock they are
// translated to the reserved range in allocation order, in the rows written
// and in the documents and reply the caller keeps.
const { AsyncLocalStorage } = require('node:async_hooks');

const SWITCH = 'NS_CLOCK_LATE_STAMP';
// Above any real millisecond stamp (year ~144,000) and below the clock LIMIT.
const PROVISIONAL = 2 ** 52;
const PROVISIONAL_SPAN = 2 ** 31;
const FIELDS = ['srvModified', 'srvCreated'];
const contexts = new AsyncLocalStorage();

function enabled (source = process.env) {
  const raw = source?.[SWITCH];
  if (raw === undefined || raw === '' || raw === '0') return false;
  if (raw !== '1') throw new TypeError('invalid ' + SWITCH + ': 0 or 1 is required');
  return true;
}

function isProvisional (value) {
  return typeof value === 'number' && value >= PROVISIONAL && value < PROVISIONAL + PROVISIONAL_SPAN;
}

// The unlocked context of the current late-stamp transaction, or null.
function unlocked () {
  const ctx = contexts.getStore();
  return ctx && !ctx.locked ? ctx : null;
}

function current () { return contexts.getStore() || null; }

function recordRead (table, ast, rows) {
  const ctx = unlocked();
  if (!ctx) return;
  let entry = ctx.reads.get(table);
  if (!entry) ctx.reads.set(table, entry = { asts: [], ids: new Set() });
  entry.asts.push(ast === undefined ? null : ast);
  for (const row of rows || []) {
    if (row && row.id_kind !== undefined && row.doc && row.doc._id !== undefined) entry.ids.add(row.id_kind + ':' + String(row.doc._id));
  }
}

// Take the clock row now (idempotent). True when a row committed since the
// transaction began overlaps what it read before the clock.
// With { validate: false } (INC-U: a write whose dedup a unique index decides
// under the clock) the validation statement is not run; the first call decides.
async function lock (options) {
  const ctx = current();
  return ctx ? ctx.lock(options) : false;
}

// In place: provisional server dates on one object become reserved stamps.
function translateFields (target) {
  const ctx = current();
  if (!ctx || !ctx.locked || !target || typeof target !== 'object') return target;
  for (const field of FIELDS) {
    if (Object.hasOwn(target, field) && isProvisional(target[field])) target[field] = ctx.translate(target[field]);
  }
  return target;
}

// After COMMIT: every provisional server date still reachable from the
// caller's objects (plain objects, arrays, Map and Set values).
function translateDeep (root, translate) {
  const seen = new Set();
  (function visit (value, depth) {
    if (!value || typeof value !== 'object' || depth > 12 || seen.has(value)) return;
    if (value._bsontype || value instanceof Date || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return;
    seen.add(value);
    if (value instanceof Map) { value.forEach(item => visit(item, depth + 1)); return; }
    if (value instanceof Set) { value.forEach(item => visit(item, depth + 1)); return; }
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return;
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (FIELDS.includes(key) && isProvisional(item)) value[key] = translate(item);
      else visit(item, depth + 1);
    }
  })(root, 0);
}

function run (ctx, fn) { return contexts.run(ctx, fn); }

module.exports = { SWITCH, PROVISIONAL, PROVISIONAL_SPAN, enabled, isProvisional, unlocked, current, recordRead, lock,
  translateFields, translateDeep, run };
