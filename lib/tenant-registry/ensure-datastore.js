'use strict';

// Existing direct-backend witnesses. PID is checked against THIS pg client by
// datastore.read; it is not compared between two different legitimate clients.
const datastore = require('../storage/postgres-datastore');
async function observe (client) {
  const current = await datastore.read(client), cluster = await datastore.cluster(client);
  return Object.freeze({ ...current, cluster });
}
const same = (a,b) => require('node:util').isDeepStrictEqual(a,b);
module.exports = { observe, same };
