'use strict';

// Every counted failed completion carries one closed reason (decision
// outcome-evaluator-gate). Reasons come from fixed codes and private
// provenance recorded by the component that refused, never from error text or
// caller-supplied properties. A reason classifies; it never grants a retry.
const windows = require('../../tenant-lifecycle/generation-scope');
const { isAuthorityRefusal } = require('../../tenant-lifecycle/operation-window-readiness');

// Vocabulary identifier declared on the inspection view (lane-2 gate reads it).
const CONTRACT = 'evaluator-failure-reasons-v1';
const REASONS = Object.freeze(['verification-pending', 'startup-warming', 'worker-unavailable', 'worker-generation',
  'platform-unready', 'scope-mismatch', 'authority', 'unknown']);
// A scope that is missing, foreign, inactive, closing or invalidated is never
// the caller's own temporary verification window.
const SCOPE_GUARDS = new Set(['scope-missing', 'scope-tenant-mismatch', 'scope-inactive', 'scope-closing', 'tenant-invalidated']);
const AUTHORITY = new Set(['LIFECYCLE_WINDOW_ROLE_UNSAFE', 'PLATFORM_SERVING_IDENTITY_UNSAFE', 'LIFECYCLE_WINDOW_TENANT_AUTHORITY_REFUSED']);
const PLATFORM = new Set(['PLATFORM_VERIFICATION_REQUIRED', 'PGSTREAM_NOT_READY', 'EVALUATOR_FEED_UNAVAILABLE',
  'LIFECYCLE_WINDOW_NOT_READY', 'LIFECYCLE_WINDOW_SESSION_LOST', 'LIFECYCLE_WINDOW_DATASTORE_CHANGED', 'LIFECYCLE_WINDOW_CLOSED',
  'EVALUATOR_SCHEMA_CHANGED_AFTER_STARTUP']);
const WARMING = new Set(['TENANT_WARMING', 'COLD_START_CANCELLED']);
const FIXED = /^[A-Z][A-Z0-9_]{0,63}$/;
const workerRefusals = new WeakMap();

const empty = () => Object.fromEntries(REASONS.map(reason => [reason, 0]));

// The worker recheck keeps its one public error. Privately record each
// independent predicate; more than one can be false at the same instant.
function workerRefusal (epoch, current) {
  const error = Object.assign(new Error('TRUSTED_WORKER_UNAVAILABLE'), { code: 'TRUSTED_WORKER_UNAVAILABLE' });
  const readerAvailable = Object.hasOwn(current, 'readerAvailable') ? current.readerAvailable === true : current.available === true;
  workerRefusals.set(error, Object.freeze({
    readerAvailable,
    platformReady: Object.hasOwn(current, 'platformReady') ? current.platformReady === true : true,
    generationMatch: current.generation === epoch.generation,
    invalidation: typeof current.invalidation === 'string' ? current.invalidation : null
  }));
  return error;
}
const workerPredicate = error => (error && workerRefusals.get(error)) || null;

function codeOf (error) {
  try {
    for (let depth = 0; error && depth < 4; depth++, error = error.cause) {
      if (typeof error.code === 'string' && FIXED.test(error.code)) return error.code;
      if (typeof error.message === 'string' && FIXED.test(error.message)) return error.message;
    }
  } catch { /* Classification must never change the refusal. */ }
  return null;
}

function classify (error, { window } = {}) {
  if (!error || typeof error !== 'object') return 'unknown';
  const worker = workerRefusals.get(error);
  if (worker) {
    if (!worker.readerAvailable) return 'worker-unavailable';
    if (!worker.platformReady) return 'platform-unready';
    return worker.generationMatch ? 'unknown' : 'worker-generation';
  }
  if (window) {
    const guard = windows.failureGuard(window, error);
    if (SCOPE_GUARDS.has(guard)) return 'scope-mismatch';
    if (guard === 'admission-withdrawn') return 'platform-unready';
    if (guard === 'datastore-probe-failed') return 'platform-unready';
  }
  if (isAuthorityRefusal(error)) return 'authority';
  const code = codeOf(error);
  if (AUTHORITY.has(code)) return 'authority';
  if (WARMING.has(code)) return 'startup-warming';
  if (PLATFORM.has(code)) return 'platform-unready';
  if (code === 'TRUSTED_WORKER_UNAVAILABLE') return 'worker-unavailable';
  return 'unknown';
}

module.exports = { CONTRACT, REASONS, empty, workerRefusal, workerPredicate, classify };
