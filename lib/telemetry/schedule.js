'use strict';

const MS = {
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000
};

function addJitter (now, minMs, maxMs, random) {
  random = typeof random === 'function' ? random : Math.random;
  var span = Math.max(0, maxMs - minMs);
  return new Date(now.getTime() + minMs + Math.floor(random() * span));
}

function initialDueAt (now, random) {
  return addJitter(now, 5 * MS.minute, 7 * MS.day, random);
}

function nextSuccessDueAt (now, random) {
  return addJitter(now, 7 * MS.day, 8 * MS.day, random);
}

function nextFailureDueAt (now, random) {
  return addJitter(now, 6 * MS.hour, 24 * MS.hour, random);
}

function isDue (state, now, enabled) {
  if (!enabled) {
    return false;
  }
  if (!state || !state.next_due_at) {
    return false;
  }
  return new Date(state.next_due_at).getTime() <= now.getTime();
}

function initializeState (state, now, random) {
  state = Object.assign({}, state || {});
  if (!state.next_due_at) {
    state.next_due_at = initialDueAt(now, random).toISOString();
  }
  return state;
}

function afterAttempt (state, now, result, random) {
  state = Object.assign({}, state || {});
  state.last_attempt_at = now.toISOString();
  if (result && result.sent) {
    state.last_success_at = now.toISOString();
    state.last_status = result.statusCode || null;
    state.next_due_at = nextSuccessDueAt(now, random).toISOString();
  } else {
    state.last_status = result && result.statusCode || null;
    state.next_due_at = nextFailureDueAt(now, random).toISOString();
  }
  return state;
}

module.exports = {
  MS,
  initialDueAt,
  nextSuccessDueAt,
  nextFailureDueAt,
  isDue,
  initializeState,
  afterAttempt
};
