'use strict';

const deviceActivity = require('../../storage/postgres-device-activity');

// Trusted constructor options; no router admission or schema writes.
module.exports = function devicestatus ({ connection, catalogue, table = 'devicestatus', bus, env, source = 'v3' } = {}) {
  return deviceActivity({ logical: 'devicestatus', source, connection, catalogue, table, bus, env });
};
