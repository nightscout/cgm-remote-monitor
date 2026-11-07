'use strict';

const NAME = /^[a-zA-Z0-9_-]{1,128}$/;

// Pure validation and snapshot shared by the service and its bounded HTTP DTO.
module.exports = function subjectUpdate (input) {
  if (!input || Object.keys(input).some(key => !['name', 'roles', 'notes', 'created_at'].includes(key)) ||
      typeof input.name !== 'string' || !input.name.trim() || input.name.length > 1024 ||
      (input.notes !== undefined && typeof input.notes !== 'string') ||
      (input.created_at !== undefined && input.created_at !== '' &&
        (typeof input.created_at !== 'string' || !Number.isFinite(Date.parse(input.created_at)))) ||
      (input.roles !== undefined && (!Array.isArray(input.roles) || input.roles.length > 256 ||
        input.roles.some(role => typeof role !== 'string' || !NAME.test(role)) ||
        new Set(input.roles).size !== input.roles.length))) {
    throw new TypeError('Invalid subject update');
  }
  // Snapshot caller values before awaiting persistence. Omitted roles intentionally revoke all.
  const value = { name: input.name, roles: (input.roles || []).slice(),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.created_at ? { created_at: input.created_at } : {}) };
  return value;
};
