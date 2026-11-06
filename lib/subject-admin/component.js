'use strict';

const subjectUpdate = require('./update');

const NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function failure (code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function identity (context) {
  if (!context || Object.keys(context).some(key => !['tenant', 'principal', 'consumer'].includes(key)) ||
      typeof context.tenant !== 'string' || !UUID.test(context.tenant) ||
      ['principal', 'consumer'].some(key => typeof context[key] !== 'string' || !NAME.test(context[key]))) {
    throw new TypeError('Subject management requires authenticated tenant, principal and consumer');
  }
  return { tenant: context.tenant, principal: context.principal, consumer: context.consumer };
}

// A trusted management callback is required; data credentials do not supply management authority.
function createSubjectAdmin ({ store, authorizeManagement }) {
  if (!store || typeof store.update !== 'function' || typeof store.remove !== 'function' ||
      typeof authorizeManagement !== 'function') {
    throw new TypeError('Subject management requires persistence and management authorization');
  }
  async function actorFor (context, operation, subjectId) {
    const actor = identity(context);
    if (typeof subjectId !== 'string' || !NAME.test(subjectId)) throw new TypeError('Invalid stable subject ID');
    if (await authorizeManagement(actor, { operation, subjectId }) !== true) {
      throw failure('SUBJECT_ADMIN_FORBIDDEN');
    }
    return actor;
  }
  return Object.freeze({
    async update (context, subjectId, input) {
      const actor = await actorFor(context, 'update', subjectId);
      const value = subjectUpdate(input);
      const result = await store.update(actor, subjectId, value);
      if (!result) throw failure('SUBJECT_ADMIN_NOT_FOUND');
      return result;
    },
    async remove (context, subjectId) {
      const actor = await actorFor(context, 'remove', subjectId);
      if (await store.remove(actor, subjectId) !== true) throw failure('SUBJECT_ADMIN_NOT_FOUND');
    }
  });
}

module.exports = { createSubjectAdmin };
