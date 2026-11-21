'use strict';

const c = require('./contract');
function alarmCycle ({ reader, current, isCurrent } = {}) {
  if (typeof reader?.read !== 'function' || typeof current !== 'function' || typeof isCurrent !== 'function') throw new TypeError('Alarm cycle requires durable reader and trusted eligible current result');
  let closed = false;
  function eligible (tenant) {
    if (closed) c.fail('ALARM_CYCLE_CLOSED');
    const value = current(tenant);
    if (!value || value.eligible !== true || value.result?.tenant !== tenant ||
        typeof value.identity !== 'string' || !value.identity.length || typeof value.runtimeId !== 'string' || !value.runtimeId.length ||
        !Number.isSafeInteger(value.outputRevision) || value.outputRevision < 1 ||
        !Number.isSafeInteger(value.inputCheckpoint) || value.inputCheckpoint < 0 ||
        !Array.isArray(value.result.emitted) || !Array.isArray(value.result.requested)) c.fail('ALARM_CYCLE_NOT_ELIGIBLE');
    c.instant(value.result.now);
    return Object.freeze({ ...value });
  }
  return Object.freeze({
    async select (rawTenant) {
      const tenant = c.tenant(rawTenant), before = eligible(tenant), result = before.result;
      const rows = await reader.read({ tenant, at: result.now });
      if (await isCurrent(tenant, before.identity) !== true) c.fail('ALARM_CYCLE_CHANGED');
      const after = eligible(tenant);
      if (after.result !== result || after.identity !== before.identity || after.runtimeId !== before.runtimeId || after.outputRevision !== before.outputRevision) c.fail('ALARM_CYCLE_CHANGED');
      const emitted = filterEmitted(result.emitted, rows, { tenant, at: result.now });
      return Object.freeze({ ...before, result: Object.freeze({ ...result, emitted: Object.freeze(emitted) }) });
    },
    close () { closed = true; }
  });
}

// The outbox dispatch path supplies a fresh attempt instant and freshly read
// suppression rows; it must separately recheck the request's current identity.
function filterEmitted (emitted, rows, { tenant: rawTenant, at } = {}) {
  const tenant = c.tenant(rawTenant); c.instant(at);
  if (!Array.isArray(emitted) || !Array.isArray(rows)) c.fail('ALARM_CYCLE_OUTPUT_INVALID');
  const suppressions = new Map();
  for (const row of rows) {
    if (row?.tenant !== tenant) c.fail('ALARM_STORED_STATE_INVALID');
    c.group(row.group); c.level(row.level); c.instant(row.ackedAt); c.instant(row.expiresAt);
    if (row.expiresAt <= row.ackedAt) c.fail('ALARM_STORED_STATE_INVALID');
    suppressions.set(JSON.stringify([row.group, row.level]), row.expiresAt);
  }
  return emitted.filter(notify => {
    if (!notify || typeof notify !== 'object') c.fail('ALARM_CYCLE_OUTPUT_INVALID');
    if (notify.clear || notify.isAnnouncement || ![1, 2].includes(notify.level)) return true;
    const expiry = suppressions.get(JSON.stringify([notify.group || 'default', notify.level]));
    return expiry === undefined || at > expiry;
  });
}
module.exports = alarmCycle;
module.exports.filterEmitted = filterEmitted;
