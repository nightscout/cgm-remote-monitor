'use strict';

const { AsyncResource } = require('node:async_hooks');
const owned = new WeakMap();
const KINDS = new Set(['clinical', 'delivery']);
const refused = () => Object.assign(new Error('EVALUATOR_JOB_CONTEXT_REFUSED'), { code: 'EVALUATOR_JOB_CONTEXT_REFUSED' });

// Called by the trusted evaluator boot entry BEFORE registry/readiness helpers
// or tenant callbacks. That entry has not admitted any request or tenant. One
// resource belongs to one component, never to a tenant or a particular job.
// It carries scheduling identity only; each drain still calls window.run with
// its explicit tenant and obtains fresh database/phase admission there.
function create (kind) {
  if (!KINDS.has(kind) || require('../../storage/tenant-scope').currentTenant() !== undefined) throw refused();
  require('../../tenant-lifecycle/operation-window').assertNoAmbientScope();
  const resource = new AsyncResource('nightscout-evaluator-' + kind, { requireManualDestroy: true });
  const state = { kind, claimed: false, closed: false };
  const value = Object.freeze({
    run (fn) {
      if (state.closed || typeof fn !== 'function') return Promise.reject(refused());
      try { return resource.runInAsyncScope(fn); } catch (error) { return Promise.reject(error); }
    },
    bind (fn) {
      if (typeof fn !== 'function') throw refused();
      return (...args) => state.closed ? undefined : resource.runInAsyncScope(fn, undefined, ...args);
    },
    // The component drains its owned jobs before closing. Boot also keeps the
    // idempotent handle so a failure before component assignment cannot leak it.
    close () { if (!state.closed) { state.closed = true; resource.emitDestroy(); } }
  });
  owned.set(value, state); return value;
}
function claim (value, kind) {
  const state = owned.get(value);
  if (!state || state.kind !== kind || state.closed || state.claimed) throw refused();
  state.claimed = true; return value;
}
module.exports = { create, claim };
