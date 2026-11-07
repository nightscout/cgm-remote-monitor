'use strict';

const DEFAULTS = Object.freeze({ DISPLAY_UNITS: 'mg/dl', SHOW_SECONDS: false });

function failure (code, details) {
  const error = new Error(code);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function object (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function valid (name, value) {
  return name === 'DISPLAY_UNITS' ? ['mg/dl', 'mmol'].includes(value)
    : name === 'SHOW_SECONDS' && typeof value === 'boolean';
}

function values (input) {
  if (!object(input)) throw new TypeError('Settings require an object');
  for (const [name, value] of Object.entries(input)) {
    if (!Object.hasOwn(DEFAULTS, name)) throw failure('SETTINGS_UNSUPPORTED', [name]);
    if (!valid(name, value)) throw failure('SETTINGS_VALUE', [name]);
  }
  return { ...input };
}

function version (value) {
  if (!Number.isInteger(value) || value < 0 || value >= 2147483647) {
    throw new TypeError('Settings require an explicit supported expected version');
  }
}

function rules (input) {
  if (!object(input) || Object.keys(input).some(key => !['deployment', 'overrides', 'generation'].includes(key)) ||
      !object(input.deployment) || !object(input.overrides)) throw failure('SETTINGS_POLICY_UNAVAILABLE');
  const result = {};
  for (const source of ['deployment', 'overrides']) {
    const rows = input[source];
    for (const [name, row] of Object.entries(rows)) {
      if (!Object.hasOwn(DEFAULTS, name) || !object(row) ||
          Object.keys(row).some(key => !['mode', 'default', 'allowed', 'pin'].includes(key)) ||
          !['open', 'bounded', 'pinned'].includes(row.mode) ||
          (Object.hasOwn(row, 'default') && !valid(name, row.default)) ||
          (row.mode === 'bounded' ? !Array.isArray(row.allowed) || !row.allowed.length ||
            row.allowed.some(value => !valid(name, value)) || new Set(row.allowed).size !== row.allowed.length
            : row.allowed !== undefined) ||
          (row.mode === 'pinned' ? !valid(name, row.pin) : row.pin !== undefined)) {
        throw failure('SETTINGS_POLICY_INVALID', [name]);
      }
      result[name] = { ...row, ...(row.allowed ? { allowed: [...row.allowed] } : {}), source };
    }
  }
  return result;
}

function refused (rule, value) {
  if (rule.mode === 'pinned') return 'pinned';
  if (rule.mode === 'bounded' && !rule.allowed.includes(value)) return 'outside-constraint';
  return undefined;
}

function effective (state, policy) {
  const result = {};
  for (const [name, fallback] of Object.entries(DEFAULTS)) {
    const rule = policy[name] || { mode: 'open', source: 'catalogue' };
    const present = Object.hasOwn(state.values, name);
    const reason = present && refused(rule, state.values[name]);
    let value = fallback, source = 'code';
    if (Object.hasOwn(rule, 'default')) { value = rule.default; source = 'operator-default'; }
    if (present && !reason) { value = state.values[name]; source = 'owner'; }
    if (rule.mode === 'pinned') { value = rule.pin; source = 'operator-pin'; }
    result[name] = { value, source, policy: { ...rule },
      ...(present ? { storedOwnerValue: state.values[name] } : {}),
      ...(reason ? { ignoredReason: reason } : {}) };
  }
  return { version: state.version, values: { ...state.values }, effective: result };
}

function createTenantSettings ({ store, policyFor, authorize }) {
  if (!store || ['read', 'history', 'write'].some(name => typeof store[name] !== 'function') ||
      typeof policyFor !== 'function' || typeof authorize !== 'function') {
    throw new TypeError('Settings require persistence, current operator policy and authenticated authorization');
  }
  async function actor (context, operation) {
    if (!object(context) || Object.keys(context).some(key => !['tenant', 'principal', 'consumer'].includes(key)) ||
        ['tenant', 'principal', 'consumer'].some(key => typeof context[key] !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(context[key]))) throw new TypeError('Invalid authenticated settings context');
    const copy = { ...context };
    if (await authorize(copy, { operation }) !== true) throw failure('SETTINGS_FORBIDDEN');
    return copy;
  }
  async function save (context, expectedVersion, input, operation, restoredFrom) {
    const who = await actor(context, operation);
    version(expectedVersion);
    let desired = input;
    if (operation === 'rollback') {
      version(restoredFrom);
      if (restoredFrom === 0 || restoredFrom > expectedVersion) throw new TypeError('Invalid rollback target');
      const old = await store.history(who.tenant, restoredFrom);
      if (!old) throw failure('SETTINGS_HISTORY_NOT_FOUND');
      desired = old.values;
    }
    const snapshot = values(desired);
    const policySnapshot = await policyFor(who.tenant);
    if (!object(policySnapshot) || !Number.isSafeInteger(policySnapshot.generation) ||
        policySnapshot.generation < 1 || policySnapshot.generation >= 2147483647) {
      throw failure('SETTINGS_POLICY_UNAVAILABLE');
    }
    const policyGeneration = policySnapshot.generation;
    const policy = rules(policySnapshot);
    const blocked = Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b)).flatMap(([name, value]) => {
      const rule = policy[name] || { mode: 'open', source: 'catalogue' };
      const reason = refused(rule, value);
      return reason ? [{ name, reason, policy: rule.source }] : [];
    });
    if (blocked.length) throw failure('SETTINGS_POLICY_REFUSED', blocked);
    const state = await store.write(who, expectedVersion, snapshot, operation, restoredFrom, policyGeneration);
    if (!state) throw failure('SETTINGS_VERSION_CONFLICT');
    return effective(state, policy);
  }
  return Object.freeze({
    async read (context) {
      const who = await actor(context, 'read');
      const policy = rules(await policyFor(who.tenant));
      const state = await store.read(who.tenant);
      if (!state) throw failure('SETTINGS_NOT_FOUND');
      values(state.values);
      return effective(state, policy);
    },
    replace (context, expectedVersion, input) { return save(context, expectedVersion, input, 'replace'); },
    rollback (context, expectedVersion, restoredFrom) {
      return save(context, expectedVersion, undefined, 'rollback', restoredFrom);
    }
  });
}

// Shared presentation resolver: no management identity is inferred by resolving
// a trusted tenant-bound state/policy snapshot for an internal DATA read.
function resolveEffectiveSettings (state, policySnapshot) {
  if (!state) throw failure('SETTINGS_NOT_FOUND');
  if (!Number.isInteger(state.version) || state.version < 1 || state.version > 2147483647) {
    throw failure('SETTINGS_STORE_UNAVAILABLE');
  }
  if (!object(policySnapshot) || !Number.isSafeInteger(policySnapshot.generation) ||
      policySnapshot.generation < 1 || policySnapshot.generation >= 2147483647) {
    throw failure('SETTINGS_POLICY_UNAVAILABLE');
  }
  const stored = { version: state.version, values: values(state.values) };
  return effective(stored, rules(policySnapshot));
}

module.exports = { createTenantSettings, resolveEffectiveSettings };
