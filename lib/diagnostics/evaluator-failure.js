'use strict';

const { createHash } = require('node:crypto');
const { failureGuard } = require('../tenant-lifecycle/operation-window');

// Match complete, fixed codes only. An exception's text, detail and stack can
// contain clinical data, database parameters or connection details.
const CODES = new Set([
  'PLATFORM_VERIFICATION_REQUIRED', 'PGSTREAM_NOT_READY', 'EVALUATOR_FEED_UNAVAILABLE', 'TRUSTED_WORKER_UNAVAILABLE',
  'TRUSTED_ACTIVITY_NOT_CURRENT', 'EVALUATOR_COMPLETION_ACTIVITY_CHANGED', 'EVALUATOR_COMPLETION_CONFIG_CHANGED',
  'EVALUATOR_CONFIG_REFUSED', 'EVALUATOR_ACQUISITION_REFUSED', 'EVALUATOR_TIME_REFUSED',
  'EVALUATOR_ACQUISITION_REQUIRED', 'EVALUATOR_STARTING', 'EVALUATOR_WORKER_UNAVAILABLE',
  'EVALUATOR_TENANT_DISABLED', 'EVALUATOR_WINDOW_REFUSED', 'EVALUATOR_RECEIPT_CONTRACT',
  'EVALUATOR_COMPLETION_VERSION_REFUSED', 'EVALUATOR_RECEIPT_ELIGIBILITY', 'EVALUATOR_RECEIPT_NOT_PROVISIONED', 'EVALUATOR_RECEIPT_COMMIT_UNCONFIRMED',
  'CLINICAL_STREAM_RESTORE_FENCE', 'CLINICAL_STREAM_SOURCE_FENCE', 'CLINICAL_STREAM_OWNER_FENCE',
  'CLINICAL_STREAM_BOOTSTRAP_REQUIRED', 'CLINICAL_STREAM_MAINTENANCE_FENCE', 'CLINICAL_STREAM_COMMIT_UNCONFIRMED',
  'LIFECYCLE_WINDOW_BINDING_CHANGED', 'LIFECYCLE_WINDOW_CLOSED', 'LIFECYCLE_WINDOW_DATASTORE_CHANGED',
  'LIFECYCLE_WINDOW_QUEUE_TIMEOUT', 'LIFECYCLE_WINDOW_NOT_READY', 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE',
  'LIFECYCLE_WINDOW_SCOPE_INVALID', 'LIFECYCLE_WINDOW_SESSION_LOST', 'LIFECYCLE_WINDOW_SUSPENDED',
  '40001', '40P01', '55P03', '57014', '53300'
]);

function classify(error) {
  try {
    for (let depth = 0; error && depth < 4; depth++, error = error.cause) {
      if (CODES.has(error.code)) return error.code;
      if (CODES.has(error.message)) return error.message;
    }
  } catch { /* Diagnostics must never change the dispatch result. */ }
  return 'unclassified';
}

const witness = value => createHash('sha256').update(value).digest('hex');

function create(runtimeId, env = process.env, write = line => process.stdout.write(line),
  writable = () => !process.stdout.writableNeedDrain) {
  const raw = env.NS_EVALUATOR_FAILURE_TRACE_LIMIT;
  if (raw === undefined || raw === '0') return null;
  const limit = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(limit)) {
    throw new TypeError('NS_EVALUATOR_FAILURE_TRACE_LIMIT requires a positive safe integer or zero');
  }
  const runtime = witness(runtimeId);
  let observed = 0, written = 0, truncated = false;
  function emit(event, fields) {
    write('EVALUATOR_FAILURE_TRACE ' + JSON.stringify({ event, runtime, at: Date.now(), ...fields }) + '\n');
  }
  function signal(event, fields) {
    try { emit(event, fields); } catch { /* A failed diagnostic sink cannot change evaluator credit. */ }
  }
  signal('enabled', { limit });
  return {
    start(generation, acquisition, operationWindow) {
      // The dispatch keeps one small object only while an attempt is running.
      return {
        generation, effectiveKind: acquisition ? 'acquisition' : 'time-only',
        phase: 'dispatch-admission', stage: null, inner: null, innerGuard: null, cycleGeneration: null, returnedGeneration: null,
        at(stage) { this.stage = stage; },
        refused(error) { this.inner = classify(error); this.innerGuard = failureGuard(operationWindow, error); },
        async run(fn) {
          this.phase = 'cycle';
          const value = await fn();
          this.returnedGeneration = value?.generation ?? null;
          this.phase = 'window-release';
          return value;
        }
      };
    },
    failure(site, attempt, state, { selected, borrowed, closed, current, completed, error, operationWindow }) {
      observed++;
      try {
        if (observed <= limit && writable()) {
          emit('failed-completion', {
            sequence: observed, tenantWitness: witness(runtimeId + '\0' + state.tenant),
            countAfter: state.failedCompletions, site, selected, effectiveKind: attempt.effectiveKind,
            phase: attempt.phase, stage: attempt.stage, inner: attempt.inner,
            innerGuard: attempt.innerGuard,
            exception: site === 'dispatch-exception' ? classify(error) : null,
            exceptionGuard: site === 'dispatch-exception' ? failureGuard(operationWindow, error) : null,
            dispatchGeneration: attempt.generation, cycleGeneration: attempt.cycleGeneration,
            returnedGeneration: attempt.returnedGeneration, completedGeneration: completed?.generation ?? null,
            currentGeneration: state.generation,
            borrowed, closed, current, inactive: state.inactive, withdrawn: state.withdrawn,
            stateCode: state.code === null ? null : CODES.has(state.code) ? state.code : 'unclassified'
          });
          written++;
          return;
        }
      } catch { /* Report the omitted event through the bounded signals. */ }
      if (!truncated) {
        truncated = true;
        signal('truncated', { firstOmitted: observed, limit });
      }
    },
    close() { signal('summary', { observed, written, omitted: observed - written, limit }); }
  };
}

module.exports = { create };
