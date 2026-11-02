'use strict';

const assert = require('node:assert/strict');
const { createSecrets } = require('../../lib/secrets/component');
const { createPostgresSecretsMaintenance } = require('../../lib/secrets/postgres');
const { createVaultTransit } = require('../../lib/secrets/vault-transit');
const scope = require('../../lib/storage/tenant-scope');

process.once('message', async options => {
  let persistence, result;
  try {
    scope.setTenancyMode('multi');
    persistence = await createPostgresSecretsMaintenance(options);
    const provider = createVaultTransit({
      address: options.address, mount: 'transit', encryptionKey: 'tenant-a-data', signingKey: 'tenant-a-signing',
      signingVersion: 1, getToken: async () => options.token, allowInsecureLoopback: true
    });
    async function checkpoint (name) {
      if (options.pauseAt !== name) return;
      process.send({ checkpoint: name });
      await new Promise(() => {}); // The parent kills this process while its IPC channel remains open.
    }
    const component = createSecrets({
      store: {
        ...persistence.store,
        async compareAndSwapCiphertext (...args) {
          await checkpoint('before-cas');
          assert.equal(await persistence.store.compareAndSwapCiphertext(...args), true);
          await checkpoint('after-commit');
          return true;
        }
      },
      audit: persistence.audit,
      providerFor: async tenant => { assert.equal(tenant, options.tenant); return provider; },
      authorize: async (context, action) => context.tenant === options.tenant &&
        context.principal === 'operator' && context.consumer === 'maintenance' && action.operation === 'rewrap',
      maxTokenLifetimeSeconds: 30
    });
    result = { reference: await component.rewrap({
      tenant: options.tenant, principal: 'operator', consumer: 'maintenance'
    }, { tenant: options.tenant, id: options.id }, options.targetVersion) };
  } catch (error) {
    result = { error: error.code || 'SECRETS_WORKER_FAILED' };
    process.exitCode = 1;
  } finally {
    if (persistence) await persistence.close();
  }
  process.send(result, () => process.disconnect());
});
