'use strict';
// History ordering is exercised against actual PostgreSQL in the commit-clock
// port suite. This inventory retains the canonical SQL writer boundary after
// removing the old requirement that every mutation emit a CDC clock seal.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const gate = require('../scripts/check-write-boundary');
const ROOT = path.resolve(__dirname, '..');
describe('PostgreSQL canonical mutation inventory', function () {
  it('classifies existing writes and rejects an unclassified connection-local mutation', function () {
    assert.deepEqual(gate.checkClockInventory(ROOT), []);
    const file = 'lib/storage/postgres-connection.js';
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const sql of ['UPDATE clinical_rows SET value=1', 'WITH p AS (SELECT 1) UPDATE clinical_rows SET value=1']) {
      const planted = source + '\nasync function unclassified(c) { await c.query(' + JSON.stringify(sql) + '); }';
      assert(gate.checkClockInventory(ROOT, { [file]: planted }).some(line => line.startsWith(file + ':')));
    }
    assert.deepEqual(gate.checkClockInventory(ROOT), []);
  });
});
