'use strict';

// Operator activity policy (maintainer decisions `activity-is-pause-suspend` and
// `owner-may-pause`, 2026-11-10). Two durable flags, three effective states:
// suspended wins over paused. There is no third administrative state.
//
//   active     everything runs.
//   paused     uploads and connector polling continue; the evaluator stops, so
//              alarms are NOT computed or delivered. On unpause the evaluator
//              recomputes from current data before it publishes anything.
//   suspended  nothing runs for the tenant.
//
// This is distinct from the restore maintenance hold (the operation window's
// `tenant_lifecycle_windows.phase`), which a restore sets and clears. Clearing
// that hold never changes these flags.
const STATES = Object.freeze(['active', 'paused', 'suspended']);
const OPERATIONS = Object.freeze({
  evaluator: Object.freeze(['active']),
  notification: Object.freeze(['active']),
  ingest: Object.freeze(['active', 'paused']),
  connector: Object.freeze(['active', 'paused'])
});
const VERBS = Object.freeze({
  owner: Object.freeze(['pause', 'unpause']),
  operator: Object.freeze(['pause', 'unpause', 'suspend', 'unsuspend'])
});

// Owner-facing wording. Keep it plain; it is returned by the owner API and is
// the text any owner UI shows beside the pause control.
const OWNER_NOTICE = Object.freeze({
  pause: 'While your site is paused, alarms are not computed or delivered. ' +
    'Uploads from your devices are still stored. Nightscout will not warn you about high or low glucose, ' +
    'stale data or anything else until you unpause. If you rely on Nightscout alarms, ' +
    'make sure you have another way to be alerted before you pause.',
  unpause: 'When you unpause, Nightscout recalculates from your current data before it shows or sends any alarm.',
  suspended: 'Your site is suspended by the operator. Nothing runs for your site, including uploads and alarms. ' +
    'Contact your operator.'
});

const refuse = code => Object.assign(new Error(code), { code });

function stateOf (row) {
  if (!row || typeof row.paused !== 'boolean' || typeof row.suspended !== 'boolean') throw refuse('ACTIVITY_UNAVAILABLE');
  return row.suspended ? 'suspended' : row.paused ? 'paused' : 'active';
}

function eligible (operation, state) {
  if (!Object.hasOwn(OPERATIONS, operation)) throw new TypeError('Unknown activity operation');
  if (!STATES.includes(state)) return false;
  return OPERATIONS[operation].includes(state);
}

// Pure transition rule. Returns the new flags; refuses a verb the authority
// does not hold. An owner can neither suspend nor act on a suspended site, so
// an owner unpause can never lift an operator suspension.
function apply (authority, verb, row) {
  if (!Object.hasOwn(VERBS, authority)) throw refuse('ACTIVITY_FORBIDDEN');
  if (!VERBS[authority].includes(verb)) throw refuse(authority === 'owner' && VERBS.operator.includes(verb) ? 'ACTIVITY_FORBIDDEN' : 'ACTIVITY_VERB_INVALID');
  const current = { paused: row.paused, suspended: row.suspended };
  stateOf(current);
  if (authority === 'owner' && current.suspended) throw refuse('ACTIVITY_SUSPENDED');
  const next = { ...current };
  if (verb === 'pause') next.paused = true;
  else if (verb === 'unpause') next.paused = false;
  else if (verb === 'suspend') next.suspended = true;
  else next.suspended = false;
  return Object.freeze(next);
}

module.exports = { STATES, OPERATIONS, VERBS, OWNER_NOTICE, stateOf, eligible, apply };
