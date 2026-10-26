'use strict';
const ConnectionString = require('mongodb-connection-string-url').default;

// Use the driver's URI grammar without creating a client, resolving SRV hosts
// or reading TLS files. Credential properties retain URL percent encoding.
module.exports = function mongoPasswordMatches(uri, secret) {
  const parsed = new ConnectionString(uri);
  return Boolean(parsed.username && decodeURIComponent(parsed.password) === secret);
};
