'use strict';
// Cooperative operation/cleanup separation, bounded by the external supervisor.
module.exports = function nativeBudget ({ stage, id, persistence, now = Date.now }) {
  const at = now();
  if (!stage || stage.id !== id || stage.persistence !== persistence || stage.signing !== 'configured-transit' ||
      stage.activeMs !== 90000 || stage.cleanupMs !== 15000 || !Number.isSafeInteger(stage.activeEndsAt) ||
      stage.activeEndsAt <= at || stage.activeEndsAt > at + stage.activeMs ||
      !Number.isSafeInteger(stage.cleanupEndsAt) || stage.cleanupEndsAt < stage.activeEndsAt ||
      stage.cleanupEndsAt > stage.activeEndsAt + stage.cleanupMs) throw new Error('NATIVE_PROBE_EXPLICIT_STAGE_REQUIRED');
  return Object.freeze({
    active () { if (now() >= stage.activeEndsAt) throw new Error('NATIVE_PROBE_ACTIVE_DEADLINE'); },
    cleanup () { if (now() >= stage.cleanupEndsAt) throw new Error('NATIVE_PROBE_CLEANUP_DEADLINE'); }
  });
};
