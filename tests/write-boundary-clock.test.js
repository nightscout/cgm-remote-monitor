'use strict';

// covers: scripts/check-write-boundary.js, lib/storage/postgres-entries-write.js

// Decision write-clock-complete: the write-boundary gate refuses a PostgreSQL
// clinical write path that does not advance the tenant write clock, and a new
// storage module with mutating SQL until it is classified.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const gate = require('../scripts/check-write-boundary');
const ROOT = path.resolve(__dirname, '..');
const writer = fs.readFileSync(path.join(ROOT, 'lib/storage/postgres-entries-write.js'), 'utf8');
const mutate = (from, to) => { assert.ok(writer.includes(from), 'the mutation applies'); return writer.replace(from, to); };

describe('write-boundary gate: every clinical write advances the tenant write clock', function () {
  it('passes the shipped writer and sees its four mutating statements', function () {
    assert.deepEqual(gate.checkClock(writer), []);
    const stripped = writer.replace(/recordWrite\(\{ deleted: true \}\)/g, 'void 0').replace(/recordWrite\(\)/g, 'void 0');
    assert.deepEqual(gate.checkClock(stripped).map(line => line.split(' ')[0]), ['insert', 'update', 'remove', 'replace']);
  });
  it('control: a hard delete without the clock advance is named', function () {
    const failures = gate.checkClock(mutate('if (Number(result.rows[0].deleted) > 0) recordWrite({ deleted: true });', ''));
    assert.equal(failures.length, 1);
    assert.match(failures[0], /^remove \(line \d+\) issues DELETE without advancing the tenant write clock/);
  });
  it('control: a hard delete that advances last_stamp but not last_delete_stamp is named', function () {
    const failures = gate.checkClock(mutate('recordWrite({ deleted: true })', 'recordWrite()'));
    assert.deepEqual(failures.map(line => line.replace(/line \d+/, 'line N')), ['remove (line N) issues DELETE without advancing last_delete_stamp: call recordWrite({ deleted: true })']);
  });
  it('control: an insert without the clock advance is named', function () {
    const failures = gate.checkClock(mutate('[row.id_kind, JSON.stringify(row.doc)]);\n    recordWrite();', '[row.id_kind, JSON.stringify(row.doc)]);'));
    assert.match(failures.join('\n'), /^insert \(line \d+\) issues INSERT without advancing/);
  });
  it('refuses a vacuous writer and an unclassified storage module with mutating SQL', function () {
    assert.deepEqual(gate.checkClock("'use strict'; module.exports = () => 1;"), ['clinical writer has no mutating statement: the gate would be vacuous']);
    assert.deepEqual(gate.checkClockInventory(ROOT), []);
    const exempt = { ...gate.CLOCK_EXEMPT };
    try {
      delete gate.CLOCK_EXEMPT['lib/storage/postgres-durable-replay.js'];
      assert.match(gate.checkClockInventory(ROOT).join('\n'), /postgres-durable-replay\.js: mutating SQL at line \d+ in an unclassified PostgreSQL storage module/);
    } finally { Object.assign(gate.CLOCK_EXEMPT, exempt); }
  });
  it('treats privilege names, comments and row locks as not mutating', function () {
    assert.deepEqual(gate.checkClock("async function f (c) { await c.query(`SELECT /* UPDATE */ has_table_privilege(r.oid,$1,'UPDATE') FROM x FOR UPDATE`); await c.query('INSERT INTO t VALUES (1)'); }")
      .map(line => line.split(' (')[0]), ['f']);
  });
  it('classifies only fixed receipt updates in the shared connection', function () {
    const file = 'lib/storage/postgres-connection.js';
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const name of ['observeEvaluator', 'observeEvaluatorMany']) {
      const classification = gate.CLOCK_METADATA_WRITES[file][name];
      try {
        delete gate.CLOCK_METADATA_WRITES[file][name];
        assert(gate.checkClockInventory(ROOT).some(line => line.startsWith(file + ':')), name + ' must be measured by the inventory');
      } finally { gate.CLOCK_METADATA_WRITES[file][name] = classification; }
    }
    const needle = 'UPDATE ${relation} SET projection=jsonb_build_array(';
    assert(source.includes(needle));
    const clinical = source.replace(needle, 'UPDATE clinical_rows SET projection=jsonb_build_array(');
    assert(gate.checkClockInventory(ROOT, { [file]: clinical }).some(line => line.startsWith(file + ':')),
      'a clinical table in an otherwise classified method must remain unclassified');
    assert.deepEqual(gate.checkClockInventory(ROOT), []);
  });
  it('detects the mutating statement after a read-only WITH clause', function () {
    assert.match(gate.checkClock('async function f(c) { await c.query("WITH p AS (SELECT 1) UPDATE clinical_rows SET x=1"); }').join('\n'), /issues UPDATE without advancing/);
  });
});
