'use strict';
// EARLY uncertainty only: real canonical handler/executor and real PG port,
// synthetic already-authorized actor. No claim about transport/current tokens.
const assert = require('node:assert/strict');
module.exports = async function profilePort ({ env, config }) {
  const scope = require('../../../lib/storage/tenant-scope'); scope.setTenancyMode('multi');
  assert(env.NS_RT_PROFILE_WRITER_URI, 'explicit narrow profile writer identity required');
  const writer = new URL(env.NS_RT_PROFILE_WRITER_URI), admin = new URL(env.NS_TEST_POSTGRES_ADMIN_URI);
  assert(writer.hostname === admin.hostname && writer.port === admin.port && writer.pathname === admin.pathname &&
    decodeURIComponent(writer.username) !== decodeURIComponent(admin.username), 'same datastore distinct restricted writer required');
  const connection = await require('../../../lib/storage/postgres-connection')({ connectionString: env.NS_RT_PROFILE_WRITER_URI,
    max: 2, connectionTimeoutMillis: config.timeoutMs, statement_timeout: config.timeoutMs });
  try {
    if (config.profileOrderCatalogue === undefined) await require('../../../lib/migrations/postgres').run('check', { direct: true, connectionString: env.NS_RT_PROFILE_WRITER_URI,
      namespace: config.profileNamespace, catalogue: require('../../../migrations/candidates/postgres-profile-v1.json') });
    const fixture = require('../socket-forwarding/recording-context').context();
    const events = [], bus = fixture.ctx.bus;
    for (const name of ['data-update', 'data-received']) bus.on(name, event => events.push({ name, event }));
    if (config.profileOrderCatalogue !== undefined) assert.equal(config.profileOrderCatalogue, 'socket-order-v1');
    const port = config.profileOrderCatalogue === 'socket-order-v1'
      ? await require('../../../lib/server/tenant-socket-order-port')({ readinessConnectionString: env.NS_RT_PROFILE_WRITER_URI,
        namespace: config.profileNamespace, connection, logical: 'profile', env: fixture.env, bus })
      : require('../../../lib/server/serve/postgres-domains').get('profile').factory({ connection,
      table: config.profileNamespace + '.profile', bus, env: fixture.env, source: 'socket' });
    const ctx = { ...fixture.ctx, store: { collection: () => { throw new Error('EARLY_PROFILE_MONGO_FALLBACK_FORBIDDEN'); } },
      storagePorts: { resolve ({ logical, source }) { assert.equal(logical, 'profile'); assert.equal(source, 'socket'); return port; } } };
    const execute = require('../../../lib/server/tenant-socket-write-executor').createExecutor({ contextForOperation: () => ({
      env: fixture.env, ctx, clientId: 'synthetic-preauthorized-profile', authorizationFor: () => ({ read: true, write: true, write_treatment: true }) }) });
    let replyMetadata;
    return { events, replyMetadata: () => replyMetadata, close: () => connection.end(),
      async send (payload) {
        let timer; replyMetadata = undefined;
        try { const raw = await Promise.race([execute({ tenant: config.tenant, namespace: '/', source: 'socket', event: 'dbAdd', args: [payload],
          actor: { tenant: config.tenant, permissions: { read: true, write: true, write_treatment: true } } }),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('PROFILE_CANONICAL_CALLBACK_MISSING')), config.timeoutMs); })]);
          const codec = require('./wire-response'); replyMetadata = { raw: codec.replyIds(raw) };
          const wire = codec.encode(raw); replyMetadata.wire = codec.replyIds(wire);
          return wire;
        }
        finally { clearTimeout(timer); }
      }
    };
  } catch (error) { await connection.end(); throw error; }
};
