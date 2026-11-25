'use strict';

// Shared shipping defaults: operator preparation and MongoDB use the same source.
module.exports = Object.freeze([
  { name: 'admin', permissions: ['*'] },
  { name: 'denied', permissions: [] },
  { name: 'status-only', permissions: ['api:status:read'] },
  { name: 'readable', permissions: ['*:*:read'] },
  { name: 'careportal', permissions: ['api:treatments:create'] },
  { name: 'devicestatus-upload', permissions: ['api:devicestatus:create'] },
  { name: 'activity', permissions: ['api:activity:create'] }
].map(role => Object.freeze({ name: role.name, permissions: Object.freeze(role.permissions) })));
