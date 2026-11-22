'use strict';

// Measures the tenant write-clock hold: per backend, the statements issued and
// the wall time from the statement that acquires the clock row (SELECT ... FOR
// UPDATE, or the reserving UPDATE ... RETURNING) to the end of its COMMIT.
// Test support only (INC-G); wraps pg.Client.prototype.query for the lab role.
const { performance } = require('node:perf_hooks');
const pg = require('pg');

function kind (sql) {
  if (/^\s*BEGIN/i.test(sql)) return 'begin';
  if (/^\s*COMMIT/i.test(sql)) return 'commit';
  if (/^\s*ROLLBACK(?! TO)/i.test(sql)) return 'rollback';
  if (/tenant_write_clock/.test(sql) && (/FOR UPDATE/.test(sql) || /^\s*UPDATE/.test(sql) && /RETURNING/.test(sql))) return 'clock-lock';
  return 'other';
}

module.exports = function holdProbe (role) {
  const original = pg.Client.prototype.query;
  let rows = null;
  pg.Client.prototype.query = function (...args) {
    const sql = typeof args[0] === 'string' ? args[0] : args[0] && args[0].text;
    const own = rows && this.connectionParameters && this.connectionParameters.user === role && typeof sql === 'string';
    const started = performance.now();
    const result = original.apply(this, args);
    if (own && result && typeof result.then === 'function') {
      const pid = this.processID;
      const record = ok => () => { if (rows) rows.push({ pid, kind: kind(sql), sql, started, ended: performance.now(), ok }); };
      result.then(record(true), record(false));
    }
    return result;
  };
  return {
    start () { rows = []; },
    // One entry per clock acquisition: statements from the lock statement to
    // the transaction end (inclusive) and that wall time.
    stop () {
      const observed = (rows || []).sort((a, b) => a.started - b.started);
      rows = null;
      const open = new Map(), holds = [];
      for (const row of observed) {
        if (row.kind === 'clock-lock' && !open.has(row.pid)) open.set(row.pid, { from: row.ended, statements: 1 });
        else if (open.has(row.pid)) {
          const hold = open.get(row.pid);
          hold.statements++;
          if (row.kind === 'commit' || row.kind === 'rollback') {
            holds.push({ statements: hold.statements, ms: row.ended - hold.from, committed: row.kind === 'commit' && row.ok });
            open.delete(row.pid);
          }
        }
      }
      return { holds, statements: observed.length };
    },
    restore () { rows = null; pg.Client.prototype.query = original; }
  };
};
