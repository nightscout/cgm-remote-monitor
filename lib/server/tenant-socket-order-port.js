'use strict';

// Explicit trusted socket composition. Never applies migrations or selects
// caller/client-controlled SQL ordering.
const { run } = require('../migrations/postgres');
const createPort = require('../storage/postgres-collection-intent');
const catalogues = Object.freeze({
  treatments: require('../../migrations/candidates/postgres-treatments-socket-order-v1.json'),
  devicestatus: require('../../migrations/candidates/postgres-devicestatus-socket-order-v1.json'),
  profile: require('../../migrations/candidates/postgres-profile-socket-order-v1.json')
});

module.exports = async function socketOrderPort ({ readinessConnectionString, namespace,
  connection, logical, env, bus } = {}) {
  if (!Object.hasOwn(catalogues, logical)) throw new TypeError('Socket order prototype requires a reviewed DATA domain');
  // The existing direct readiness identity checks the optional successor ledger
  // before a caller can bind a socket. Never auto-migrate using serving authority.
  await run('check', { direct: true, connectionString: readinessConnectionString,
    namespace, catalogue: catalogues[logical] });
  const factory = logical === 'profile' ? require('./tenant-app/profile') : createPort;
  return factory({ connection, logical, table: namespace + '.' + logical,
    env, bus, source: 'socket', naturalOrder: true });
};
module.exports.catalogues = catalogues;
