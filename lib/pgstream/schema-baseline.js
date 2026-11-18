'use strict';

// Decision stable-evaluator-runtime: the evaluator verifies the schema once at
// startup and records the change-stream position that verification covers.
// Relevant DDL committed at or before that position (provisioning or a
// deployment migration replayed from the slot) is acknowledged without
// invalidation. Relevant DDL after it is unsupported while serving: the owner
// stops the role and the operator restarts it after the migration.
//
// The position is read before startup verification begins. A transaction whose
// commit record ends at or before it may still be finishing its visibility
// step, so capture waits for every transaction in progress at that instant to
// end. Startup verification, which starts after capture, then sees all DDL at
// or before the position.
const { position: parse } = require('../storage/clinical-stream-state');
const fail = code => Object.assign(new Error(code), { code });

function parsed (text) {
  try { return parse(text); } catch { return null; }
}

function create ({ read, timeoutMs, pollMs = 25, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (typeof read !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(pollMs) || pollMs < 1) {
    throw new TypeError('Explicit schema baseline reader and bound required');
  }
  // startup: no position yet; any event received now committed before capture.
  let phase = 'startup', baseline = null, baselineText = null, positionRead = null;
  let lastAcknowledged = null, terminalPosition;
  const counts = { acknowledged: 0, startupAcknowledged: 0, repeated: 0 };

  async function capture () {
    if (phase !== 'startup') throw fail('PGSTREAM_SCHEMA_BASELINE_ALREADY_CAPTURED');
    phase = 'capturing';
    positionRead = (async () => {
      const row = (await read('SELECT pg_current_wal_insert_lsn()::text AS position')).rows?.[0];
      const value = parsed(row?.position);
      if (value === null) throw fail('PGSTREAM_SCHEMA_BASELINE_REFUSED');
      baseline = value; baselineText = row.position;
      return value;
    })();
    try {
      await positionRead;
      const snapshot = (await read('SELECT pg_current_snapshot()::text AS snapshot')).rows?.[0]?.snapshot;
      if (typeof snapshot !== 'string') throw fail('PGSTREAM_SCHEMA_BASELINE_REFUSED');
      const deadline = now() + timeoutMs;
      for (;;) {
        const row = (await read("SELECT count(*)::integer AS running FROM unnest(pg_snapshot_xip($1::pg_snapshot)) AS x WHERE pg_xact_status(x) = 'in progress'", [snapshot])).rows?.[0];
        if (!Number.isSafeInteger(row?.running) || row.running < 0) throw fail('PGSTREAM_SCHEMA_BASELINE_REFUSED');
        if (row.running === 0) break;
        if (now() >= deadline) throw fail('PGSTREAM_SCHEMA_BASELINE_UNSETTLED');
        await sleep(pollMs);
      }
      phase = 'established';
    } catch (error) {
      phase = 'failed';
      throw error;
    }
  }

  // Returns 'startup' | 'covered' | 'repeated' | 'after'. Only 'after' refuses.
  async function observe (text) {
    if (phase === 'terminal') return 'after';
    const value = parsed(text);
    if (phase === 'startup') {
      // Committed before the position read is issued, so at or before it.
      if (value !== null && lastAcknowledged !== null && value <= lastAcknowledged) { counts.repeated++; return 'repeated'; }
      if (value !== null) lastAcknowledged = value;
      counts.acknowledged++; counts.startupAcknowledged++;
      return 'startup';
    }
    if (phase === 'capturing') { try { await positionRead; } catch { /* the failed capture refuses below */ } }
    if (phase === 'failed' || baseline === null || value === null || value > baseline) {
      phase = 'terminal'; terminalPosition = typeof text === 'string' && value !== null ? text : null;
      return 'after';
    }
    if (lastAcknowledged !== null && value <= lastAcknowledged) { counts.repeated++; return 'repeated'; }
    lastAcknowledged = value; counts.acknowledged++;
    return 'covered';
  }

  const stats = () => ({ phase, baseline: baselineText, ...counts, terminalPosition: terminalPosition ?? null });
  return Object.freeze({ capture, observe, stats });
}

module.exports = { create };
