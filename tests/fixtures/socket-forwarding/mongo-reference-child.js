'use strict';

// Canonical handler/pattern reference, not a full single app or Android binary.
// Its process-wide mode is independent of the multitenant PostgreSQL parent.
const http = require('node:http');
const { MongoClient } = require('mongodb');
const scope = require('../../../lib/storage/tenant-scope');
const { context } = require('./recording-context');
scope.setTenancyMode('single');
const configuration = JSON.parse(process.env.NS_SOCKET_MONGO_REFERENCE);
delete process.env.NS_SOCKET_MONGO_REFERENCE;
let mongo, server, fixture;
async function close () {
  if (fixture) fixture.ctx.bus.emit('teardown');
  if (server?.listening) await new Promise((resolve, reject) => server.close(error =>
    error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
  if (mongo) await mongo.close();
}
async function start () {
  mongo = new MongoClient(configuration.connectionString); await mongo.connect();
  fixture = context();
  fixture.ctx.store = { collection: name => mongo.db(configuration.database).collection(name) };
  server = http.createServer();
  require('../../../lib/server/websocket')(fixture.env, fixture.ctx, server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.on('message', async message => {
    try {
      if (message?.type === 'reset') {
        await mongo.db(configuration.database).dropDatabase();
        process.send({ type: 'reset-done', id: message.id });
      } else if (message?.type === 'close') {
        await close();
        process.send({ type: 'closed', id: message.id }, () => process.exit(0));
      }
    } catch (error) { console.error(error); process.exitCode = 1; }
  });
  process.on('disconnect', () => { close().finally(() => process.exit(1)); });
  process.send({ type: 'ready', pid: process.pid, mode: scope.getTenancyMode(), port: server.address().port });
}
start().catch(async error => { console.error(error); await close(); process.exit(1); });
