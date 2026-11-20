'use strict';

const { createStore, grants } = require('./postgres');
const { createDerivedKeySource } = require('./keys');
const { createManagementSessions } = require('./component');
async function createRuntime (config) {
  const store = await createStore(config);
  try {
    const keySource = createDerivedKeySource({ signing: config.signing });
    const service = createManagementSessions({ store, keySource, issuer: config.issuer, audience: config.audience });
    return Object.freeze({ issue: service.issue, close: store.close });
  } catch (error) { await store.close(); throw error; }
}
module.exports = { createRuntime, createStore, createManagementSessions, createDerivedKeySource, grants };
