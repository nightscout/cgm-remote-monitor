'use strict';

const NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const REFERENCE = ['encrypt', 'decrypt', 'reveal', 'rewrap'];
const OPERATIONS = [...REFERENCE, 'sign', 'verify'];

function failure (code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function identity (context) {
  if (!context || Object.keys(context).some(key => !['tenant', 'principal', 'consumer'].includes(key)) ||
      ['tenant', 'principal', 'consumer'].some(key => typeof context[key] !== 'string' || !NAME.test(context[key]))) {
    throw new TypeError('Policy requires authenticated tenant, principal and consumer');
  }
  return { tenant: context.tenant, principal: context.principal, consumer: context.consumer };
}

function grant (value) {
  if (!value || Object.keys(value).some(key => !['principal', 'consumer', 'operation', 'id'].includes(key)) ||
      ['principal', 'consumer'].some(key => typeof value[key] !== 'string' || !NAME.test(value[key])) ||
      !OPERATIONS.includes(value.operation) ||
      (REFERENCE.includes(value.operation) ? typeof value.id !== 'string' || !NAME.test(value.id) : value.id !== undefined)) {
    throw new TypeError('Invalid exact secrets grant');
  }
  return { principal: value.principal, consumer: value.consumer, operation: value.operation,
    ...(value.id === undefined ? {} : { id: value.id }) };
}

function key (value) { return JSON.stringify([value.principal, value.consumer, value.operation, value.id]); }

// Limits are trusted tenant provisioning, not owner input or a fallback when authority is unavailable.
function createSubjectPolicy ({ store, limitsFor, authorizeManagement }) {
  if (!store || typeof store.read !== 'function' || typeof store.write !== 'function' ||
      typeof limitsFor !== 'function' || typeof authorizeManagement !== 'function') {
    throw new TypeError('Policy requires persistence, code/operator limits and management authorization');
  }
  async function limits (tenant) {
    const result = await limitsFor(tenant);
    if (!result || !Array.isArray(result.code) || !Array.isArray(result.operator)) {
      throw failure('POLICY_LIMITS_UNAVAILABLE');
    }
    return {
      code: new Set(result.code.map(value => key(grant(value)))),
      operator: new Set(result.operator.map(value => key(grant(value))))
    };
  }
  async function management (context, operation) {
    const actor = identity(context);
    if (await authorizeManagement(actor, { operation }) !== true) throw failure('POLICY_FORBIDDEN');
    return actor;
  }
  return Object.freeze({
    async read (context) {
      const actor = await management(context, 'read');
      const state = await store.read(actor.tenant);
      if (!state) throw failure('POLICY_NOT_FOUND');
      return state;
    },
    async replace (context, expectedVersion, grants) {
      const actor = await management(context, 'replace');
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion >= 2147483647 ||
          !Array.isArray(grants) || grants.length > 1000) throw new TypeError('Invalid policy version or grants');
      const values = grants.map(grant);
      if (new Set(values.map(key)).size !== values.length) throw new TypeError('Duplicate policy grant');
      const ceiling = await limits(actor.tenant);
      if (values.some(value => !ceiling.code.has(key(value)) || !ceiling.operator.has(key(value)))) {
        throw failure('POLICY_FLOOR');
      }
      const state = await store.write(actor, expectedVersion, values);
      if (!state) throw failure('POLICY_VERSION_CONFLICT');
      return state;
    },
    async authorize (context, action) {
      const actor = identity(context);
      if (!action || Object.keys(action).some(name => !['operation', 'id', 'targetVersion'].includes(name)) ||
          (action.targetVersion !== undefined && (action.operation !== 'rewrap' ||
            !Number.isSafeInteger(action.targetVersion) || action.targetVersion < 1))) {
        throw new TypeError('Invalid secrets authorization action');
      }
      const wanted = key(grant({ principal: actor.principal, consumer: actor.consumer,
        operation: action.operation, ...(action.id === undefined ? {} : { id: action.id }) }));
      const ceiling = await limits(actor.tenant);
      // Every call reads committed authoritative state; never cache grants or infer them from a JWT.
      const state = await store.read(actor.tenant);
      return !!state && ceiling.code.has(wanted) && ceiling.operator.has(wanted) &&
        state.grants.some(value => key(grant(value)) === wanted);
    }
  });
}

module.exports = { createSubjectPolicy };
