'use strict';

// Opt-in clinical stage records for delay localization (operator diagnostics).
// NS_CLINICAL_STAGE_TRACE=<fraction in (0,1]> selects tenants by a stable hash,
// so every process traces the same tenants and records can be joined:
//   evaluator.receipt  tenant, clock          durable clock observation accepted
//   evaluator.complete tenant, covered clock, outputRevision, changed
//   realtime.frame     tenant, outputRevision, sent, held sockets
// Each record is one bounded JSON line on stdout with a wall-clock `at`.
// Records carry tenant identifiers and versions only: no clinical values,
// tokens or settings. A per-process rate cap drops (and counts) excess records.
const { createHash } = require('node:crypto');
const NOOP = Object.freeze({ enabled: false, record () { return false; }, stats () { return { enabled: false }; } });
const STAGES = new Set(['evaluator.receipt', 'evaluator.complete', 'realtime.frame']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const scalar = value => value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ||
  (typeof value === 'string' && value.length <= 64);

function create ({ fraction, maxPerSecond = 200, write = line => process.stdout.write(line), now = Date.now } = {}) {
  if (fraction === undefined || fraction === null || fraction === '') return NOOP;
  const share = Number(fraction);
  if (!Number.isFinite(share) || share <= 0 || share > 1 || !Number.isSafeInteger(maxPerSecond) || maxPerSecond < 1) {
    throw new TypeError('NS_CLINICAL_STAGE_TRACE must be a fraction in (0,1]');
  }
  const threshold = Math.round(share * 10000), selected = new Map();
  const counters = { written: 0, dropped: 0, refused: 0 };
  let second = 0, used = 0;
  function sampled (tenant) {
    if (!selected.has(tenant)) {
      if (selected.size >= 100000) selected.clear();
      selected.set(tenant, createHash('sha256').update(tenant).digest().readUInt32BE(0) % 10000 < threshold);
    }
    return selected.get(tenant);
  }
  return Object.freeze({ enabled: true,
    record (stage, fields) {
      try {
        if (!STAGES.has(stage) || !fields || !UUID.test(fields.tenant) || Object.values(fields).some(value => !scalar(value))) { counters.refused++; return false; }
        if (!sampled(fields.tenant)) return false;
        const at = now(), bucket = Math.floor(at / 1000);
        if (bucket !== second) { second = bucket; used = 0; }
        if (used >= maxPerSecond) { counters.dropped++; return false; }
        used++;
        write('CLINICAL_STAGE ' + JSON.stringify({ stage, at, ...fields }) + '\n');
        counters.written++;
        return true;
      } catch { counters.refused++; return false; }
    },
    stats () { return { enabled: true, ...counters }; } });
}

let shared;
// One process-wide tracer from the environment; a malformed value refuses boot.
function fromEnvironment (env = process.env) {
  if (!shared) shared = create({ fraction: env.NS_CLINICAL_STAGE_TRACE });
  return shared;
}
module.exports = { create, fromEnvironment, NOOP };
