'use strict';

const deviceActivity = require('../../storage/postgres-device-activity');

module.exports = function activity ({ connection, table = 'activity', bus, env, source = 'v1/internal' } = {}) {
  return deviceActivity({ logical: 'activity', source, connection, table, bus, env });
};
