'use strict';

const { createSecrets } = require('../../secrets/component');
const { createPostgresSecrets } = require('../../secrets/postgres');
const createLegacyAuthority = require('../../secrets/legacy-postgres');

// The only exported cryptographic capability is subject credential issuance.
// Subject administration supplies its locked authority transaction to the method;
// data access and settings never receive a decrypt, root reveal or signing method.
module.exports = async function ownerCredentialRuntime (config) {
  if (!config || !(config.providers instanceof Map) || typeof config.consumer !== 'string') {
    throw new TypeError('Owner credentials require explicit tenant secrets configuration');
  }
  const resources = [];
  async function close () {
    const settled = await Promise.allSettled(resources.splice(0).reverse().map(resource => resource.close()));
    if (settled.some(result => result.status === 'rejected')) throw new Error('Owner credential shutdown failed');
  }
  try {
    const persistence = await createPostgresSecrets({ connectionString: config.connectionString, namespace: config.namespace });
    resources.push(persistence);
    const legacy = await createLegacyAuthority({ connectionString: config.legacyConnectionString, namespace: config.legacyNamespace });
    resources.push(legacy);
    const secrets = createSecrets({ ...persistence, maxTokenLifetimeSeconds: 28800,
      providerFor: async tenant => {
        const provider = config.providers.get(tenant);
        if (!provider) throw new Error('Owner credential tenant refused');
        return provider;
      },
      legacyAuthorityFor: tenant => legacy.read(tenant),
      authorize: async (actor, action) => {
        if (actor.consumer !== config.consumer || !config.providers.has(actor.tenant) || action.operation !== 'issue-legacy') return false;
        const current = await legacy.read(actor.tenant);
        return current?.reference?.tenant === actor.tenant && current.reference.id === action.id;
      }
    });
    return Object.freeze({ issueCredential: secrets.issueLegacyCredential, close });
  } catch (error) { await close(); throw error; }
};
