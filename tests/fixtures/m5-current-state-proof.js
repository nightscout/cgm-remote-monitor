'use strict';

// Synthetic uncertainty probe, not a runtime/reconciliation implementation.
const { EventEmitter } = require('node:events');
const baseLab = require('./tenant-projection-evaluator');
const createPort = require('../../lib/storage/postgres-collection-intent');
const createV3 = require('../../lib/storage/postgres-entries-intent');
const scope = require('../../lib/storage/tenant-scope');
const { INTENT_EVENT } = require('../../lib/storage/write-intent');

const copy = value => JSON.parse(JSON.stringify(value));
const key = (domain, row) => JSON.stringify([domain, row.id_kind, row.doc._id]);
const projected = rows => rows.map(row => ({ domain: row.domain,
  id_kind: typeof row.document._id === 'string' ? 'string'
    : row.document._id && row.document._id._bsontype === 'ObjectId' ? 'objectid' : 'unknown',
  doc: copy(row.document) }));

module.exports = function currentStateProof () {
  const lab = baseLab();
  const records = [];
  lab.trace = (phase, observation) => {
    const record = { phase, ...observation };
    const json = JSON.stringify(record, (name, value) => {
      if (value === undefined) return { m5ProbeType: 'undefined' };
      if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) {
        return { m5ProbeType: 'number', value: Object.is(value, -0) ? '-0' : String(value) };
      }
      return value;
    });
    records.push(JSON.parse(json));
    console.log('M5_CURRENT_STATE_OBSERVATION ' + json);
    return record;
  };
  lab.records = records;
  lab.physical = async (tenant = lab.A) => {
    const tables = {};
    for (const [logical, table] of Object.entries(lab.tables)) {
      tables[logical] = (await lab.admin.query('SELECT tenant_id,id_kind,doc FROM ' +
        table.split('.').map(part => '"' + part + '"').join('.') +
        ' WHERE tenant_id=$1 ORDER BY id_kind COLLATE "C",doc->>\'_id\' COLLATE "C"', [tenant])).rows;
    }
    return { tables, floor: await lab.floor(tenant), checkpoint: await lab.checkpointView(tenant) || null };
  };
  lab.currentKeys = physical => Object.entries(physical.tables).flatMap(([domain, rows]) =>
    rows.filter(row => row.doc.isValid !== false).map(row => key(domain, row))).sort();
  lab.projectionKeys = recovered => projected(recovered.rows).map(row => key(row.domain, row)).sort();
  lab.catchUp = async (tenant = lab.A) => scope.withTenant(tenant, () => lab.consumer().reconcile({ maxRows: 10000, maxBytes: 4 * 1024 * 1024 }));
  lab.compare = async (at, tenant = lab.A) => lab.at(at, async () => {
    const recovered = await lab.catchUp(tenant);
    const instance = lab.evaluator(tenant);
    try {
      const clinical = await instance.evaluate({ at });
      const fresh = await lab.fresh(tenant, at); // independently materialized CURRENT physical tables
      return { recovered: { ...recovered, rows: projected(recovered.rows) },
        projectionKeys: lab.projectionKeys(recovered), clinical, fresh,
        physical: await lab.physical(tenant), foreign: await lab.physical(tenant === lab.A ? lab.B : lab.A) };
    } finally { instance.close(); }
  });
  lab.writeCanonical = async ({ logical = 'entries', source = 'socket', planned, tenant = lab.A }) => {
    const bus = new EventEmitter(), events = [], commits = [];
    bus.on(INTENT_EVENT, event => events.push({ event: copy(event), committedReceipts: commits.length }));
    const clock = lab.clocks[0];
    const observed = { ...clock, async transaction (fn) {
      let xid, earlyEvents;
      const result = await clock.transaction(async () => {
        xid = (await clock.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid;
        const value = await fn();
        earlyEvents = events.length;
        return value;
      });
      // Independent admin checks the actual transaction's committed state.
      const state = (await lab.admin.query('SELECT pg_xact_status($1::xid8) AS status', [xid])).rows[0].status;
      commits.push({ xid, status: state, earlyEvents });
      return result;
    } };
    const port = source === 'v3' && logical === 'entries'
      ? createV3({ connection: observed, table: lab.tables.entries, bus, env: lab.env })
      : createPort({ connection: observed, table: lab.tables[logical], logical, source, bus, env: lab.env,
        naturalOrder: logical === 'entries' && source === 'v1/internal' });
    const before = await lab.physical(tenant);
    const result = await scope.withTenant(tenant, () => port.write(planned));
    return { logical, source, op: planned.op, result: copy(result), commits, events,
      before, after: await lab.physical(tenant) };
  };
  lab.writeAtomicEntries = async updates => {
    const clock = lab.clocks[1], events = [], bus = new EventEmitter();
    bus.on(INTENT_EVENT, event => events.push(copy(event)));
    const port = createPort({ connection: clock, table: lab.tables.entries, logical: 'entries', source: 'socket', bus, env: lab.env });
    let xid, earlyEvents;
    const before = await lab.physical();
    await scope.withTenant(lab.A, () => clock.transaction(async () => {
      xid = (await clock.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid;
      for (const { id, value } of updates) await port.write({ op: 'update', form: 'merge', target: { _id: id }, fields: { sgv: value } });
      earlyEvents = events.length;
    }));
    const status = (await lab.admin.query('SELECT pg_xact_status($1::xid8) AS status', [xid])).rows[0].status;
    return { before, after: await lab.physical(), xid, status, earlyEvents, events };
  };
  lab.replayAttempt = async () => {
    try { return { recovered: await scope.withTenant(lab.A, () => lab.consumer().catchUp()), error: null }; }
    catch (error) { return { recovered: null, error: { name: error.name, code: error.code || null, message: error.message } }; }
  };
  return lab;
};
