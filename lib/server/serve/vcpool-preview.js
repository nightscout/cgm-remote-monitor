'use strict';

// `nightscout multitenant vcpool`: the tenant-side Nightscout connector
// (MT-CONNECTOR-REVERSE, decision first-preview-no-push-provider). No listener
// of its own; its operational inspection read is the connector-inspection
// contract on the process's serve.internal.
//
// Boot order: pool membership first (kind vcpool; flag off means this member
// owns every configured tenant), then the activity reader and the tenant
// secrets reader, then the cycle. Membership that does not agree at boot
// refuses the start, as the evaluator does; later disagreement stops each
// cycle until it agrees again.
const scope = require('../../storage/tenant-scope');
const { createSecrets } = require('../../secrets/component');
const { createPostgresSecrets } = require('../../secrets/postgres');
const { PreviewConfigError } = require('./preview-config');

async function boot (config) {
  let member, activityStore, persistence, runtime, closing;
  async function close () {
    if (closing) return closing;
    closing = (async () => {
      try { if (runtime) await runtime.close(); } finally {
        if (persistence) await persistence.close().catch(() => {});
        if (activityStore) await activityStore.close().catch(() => {});
        if (member) await member.close().catch(() => {});
      }
    })();
    return closing;
  }
  let refusal = 'vcpool readiness or initialization refused';
  try {
    member = await require('../../pool-membership').member(config.partition || { kind: 'vcpool', partitioned: false });
    await member.register();
    const slice = await member.slice();
    if (!slice.eligible) {
      refusal = 'vcpool pool membership refused: ' + slice.reason;
      throw new Error(refusal);
    }
    scope.setTenancyMode('multi');
    // Read-only activity identity; boot refuses one that could write activity state.
    await require('../../migrations/postgres').run('check', { direct: true, connectionString: config.activity.connectionString,
      namespace: config.activity.namespace, catalogue: require('../../tenant-lifecycle/postgres-candidate.json'), statementTimeoutMs: 5000 });
    activityStore = await require('../../tenant-activity/postgres').create({ connectionString: config.activity.connectionString,
      namespace: config.activity.namespace, capability: 'reader', applicationName: 'nightscout-vcpool-activity' });
    const activity = require('../../tenant-activity/eligibility').create({ read: activityStore.read });
    persistence = await createPostgresSecrets({ connectionString: config.secretsConnectionString, namespace: config.namespaces.secrets });
    // Decrypt only, and only this tenant's three connector references. The
    // Vault token's own policy is the second bound (decrypt on the data key).
    const secrets = createSecrets({
      ...persistence, maxTokenLifetimeSeconds: 1,
      providerFor: async tenant => {
        const selected = config.tenants.get(tenant);
        if (!selected) throw new Error('unconfigured connector tenant');
        return selected.provider;
      },
      authorize: async (identity, action) => {
        const selected = config.tenants.get(identity.tenant);
        if (!selected || identity.principal !== selected.binding.principal || identity.consumer !== selected.binding.consumer) return false;
        const { connector } = selected;
        return action.operation === 'decrypt' &&
          [connector.sourceEndpoint, connector.sourceCredential, connector.writeCredential].includes(action.id);
      }
    });
    runtime = require('../../tenant-connector/runtime').create({ config, member, activity,
      decrypt: (tenant, id) => secrets.decrypt(tenant.binding, { tenant: tenant.id, id }) });
    runtime.start();
    console.log('vcpool preview started; configured tenants:', config.tenants.size, 'egress proxy:', config.egress.proxy ? 'set' : 'none',
      'pool:', member.configured.mode);
    const internal = Object.freeze({ 'connector-inspection': Object.freeze({
      create: () => ({ inspectConnectors: async () => runtime.inspect() }) }) });
    return Object.freeze({ close, internal, inspect: runtime.inspect, cycle: runtime.cycle });
  } catch {
    await close();
    throw new PreviewConfigError(refusal);
  }
}

module.exports = { boot };
