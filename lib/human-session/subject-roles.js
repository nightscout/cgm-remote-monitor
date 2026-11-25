'use strict';

const { idFilter } = require('../server/object-id-forms');
const DEFAULTS = require('../authorization/default-roles');
const OBJECT_ID = /^[0-9a-f]{24}$/;
const PRIMARY = { readPreference: 'primary' };

// Current permissions of a local authorization subject, read from the subjects
// and roles collections at each human operation, so a role edit in the admin
// UI governs the next request in every process. Stored roles override the
// shipped defaults of the same name, as authorization storage does at reload.
function createSubjectRoles ({ subjects, roles, fallbackRoles = [] }) {
  if (!subjects || typeof subjects.findOne !== 'function' || !roles || typeof roles.find !== 'function' ||
      !Array.isArray(fallbackRoles) || fallbackRoles.some(name => typeof name !== 'string' || !name)) {
    throw new TypeError('Current subject roles require the authorization subjects and roles collections');
  }
  async function groups (names) {
    const wanted = [...new Set(names.filter(name => typeof name === 'string' && name))];
    if (!wanted.length) return [];
    const stored = await roles.find({ name: { $in: wanted } }, PRIMARY).toArray();
    return wanted.map(name => {
      const role = stored.find(value => value && value.name === name) || DEFAULTS.find(value => value.name === name);
      return role && Array.isArray(role.permissions) ? role.permissions.filter(permission => typeof permission === 'string') : null;
    }).filter(Array.isArray);
  }
  return Object.freeze({
    async forSubject (id) {
      if (typeof id !== 'string' || !OBJECT_ID.test(id)) return null;
      const subject = await subjects.findOne({ _id: idFilter(id) }, PRIMARY);
      if (!subject || !Array.isArray(subject.roles)) return null;
      return groups(subject.roles);
    },
    fallback: fallbackRoles.length ? () => groups(fallbackRoles) : null
  });
}

module.exports = { createSubjectRoles };
