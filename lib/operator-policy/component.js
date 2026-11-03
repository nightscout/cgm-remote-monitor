'use strict';

const NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_BYTES = 65536;

function failure (code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function identity (context) {
  if (!context || Object.keys(context).some(key => !['tenant', 'principal', 'consumer'].includes(key)) ||
      ['tenant', 'principal', 'consumer'].some(key => typeof context[key] !== 'string' || !NAME.test(context[key]))) {
    throw new TypeError('Operator policy requires authenticated tenant, principal and consumer');
  }
  return { tenant: context.tenant, principal: context.principal, consumer: context.consumer };
}

function assertJson (value, seen, depth, count) {
  count.value++;
  if (count.value > 8192 || depth > 32) throw new TypeError('Operator policy exceeds its supported shape');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || seen.has(value)) throw new TypeError('Operator policy must be JSON data');
  if (Array.isArray(value)) {
    seen.add(value);
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
      throw new TypeError('Operator policy arrays must not have extra properties');
    }
    value.forEach(item => assertJson(item, seen, depth + 1, count));
    seen.delete(value);
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Operator policy must be JSON data');
  seen.add(value);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Operator policy must be JSON data');
    assertJson(descriptor.value, seen, depth + 1, count);
  }
  seen.delete(value);
}

function document (input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError('Operator policy requires a plain object');
  }
  assertJson(input, new Set(), 0, { value: 0 });
  let encoded;
  try { encoded = JSON.stringify(input); } catch { throw new TypeError('Operator policy must be JSON data'); }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > MAX_BYTES) {
    throw new TypeError('Operator policy exceeds its supported size');
  }
  const copy = JSON.parse(encoded);
  if (!copy || Array.isArray(copy) || Object.getPrototypeOf(copy) !== Object.prototype) {
    throw new TypeError('Operator policy requires a plain object');
  }
  return copy;
}

function generation (value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2147483647) {
    throw new TypeError('Operator policy requires a supported expected generation');
  }
}

function createOperatorPolicy ({ store, authorizeManagement }) {
  if (!store || typeof store.read !== 'function' || typeof store.write !== 'function' ||
      typeof authorizeManagement !== 'function') {
    throw new TypeError('Operator policy requires persistence and authenticated management authorization');
  }
  async function management (context, operation) {
    const actor = identity(context);
    if (await authorizeManagement(actor, { operation }) !== true) throw failure('OPERATOR_POLICY_FORBIDDEN');
    return actor;
  }
  return Object.freeze({
    async read (context) {
      const actor = await management(context, 'read');
      const state = await store.read(actor.tenant);
      if (!state) throw failure('OPERATOR_POLICY_NOT_FOUND');
      return state;
    },
    async replace (context, expectedGeneration, input) {
      const actor = await management(context, 'replace');
      generation(expectedGeneration);
      const policy = document(input);
      const state = await store.write(actor, expectedGeneration, policy);
      if (!state) throw failure('OPERATOR_POLICY_GENERATION_CONFLICT');
      return state;
    }
  });
}

module.exports = { createOperatorPolicy };
