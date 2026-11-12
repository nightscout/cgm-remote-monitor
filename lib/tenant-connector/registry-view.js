'use strict';

// Registry is the tenant roster; definitions are tenant-bound D15 settings.
// Normal ticks read one aggregate revision. Only a changed revision rebuilds
// the paged, bounded configured-source snapshot. A failed refresh stops new
// connector work until a complete snapshot is available again.
const connect = require('../storage/postgres-connection');
const registryModule = require('../tenant-registry/postgres');
const definitions = require('./postgres-sources');
const { createVaultTransit } = require('../secrets/vault-transit');
const rules = require('../tenant-registry/rules');
const fail = () => Object.assign(new Error('CONNECTOR_CONFIGURATION_UNAVAILABLE'), { code: 'CONNECTOR_CONFIGURATION_UNAVAILABLE' });
async function open ({ config, now = Date.now, schedule = setInterval, cancel = clearInterval }) {
  let connection, store, timer, pending, closed = false, usable = false, polledAt = -Infinity, revision = null;
  const tenants = new Map(), authority = new Map();
  const maxSources = config.maxSources;
  try {
    connection = await connect({ connectionString: config.definitions.connectionString, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000,
      application_name: 'nightscout-vcpool-registry' });
    store = await definitions.create({ connectionString: config.definitions.connectionString, namespaces: config.definitions.namespaces });
    const registry = registryModule.create({ connection, namespace: config.registry.namespace });
    async function refresh () {
      if (closed) return;
      if (pending) return pending;
      pending = (async () => {
        try {
          const current = await registry.revision();
          if (usable && current === revision) { polledAt = now(); return; }
          usable = false;
          const all = await registry.enumerate({ pageSize: 1000 });
          if (all.tenants.length > config.maxTenants) throw fail();
          const next = new Map(), nextAuthority = new Map();
          for (const id of all.tenants) {
            let after = '', rows = [];
            for (;;) {
              const page = await store.list(id, { after, limit: 100, activeOnly: true });
              rows.push(...page);
              if (rows.length > maxSources || next.size + rows.length > maxSources) throw fail();
              if (page.length < 100) break;
              after = page.at(-1).sourceId;
            }
            if (!rows.length) continue;
            const host = await registry.alias(id), entry = await registry.entry(id);
            if (!host || !entry || entry.state !== 'active') throw fail();
            const provider = createVaultTransit({ ...config.registryVault, encryptionKey: rules.vaultKey(id, 'data'), signingKey: rules.vaultKey(id, 'signing'), signingVersion: entry.signingVersion });
            const refs = new Set();
            for (const row of rows) {
              for (const field of ['sourceEndpoint', 'sourceCredential', 'writeCredential']) refs.add(row.connector[field]);
              const key = id + '/' + row.sourceId, old = tenants.get(key);
              next.set(key, old && old.definitionGeneration === row.generation && old.host === host && old.signingVersion === entry.signingVersion ? old : Object.freeze({
                id, sourceId: row.sourceId, definitionGeneration: row.generation, signingVersion: entry.signingVersion, host, connector: row.connector, provider,
                binding: Object.freeze({ tenant: id, principal: 'vcpool', consumer: 'tenant-connector' }) }));
            }
            nextAuthority.set(id, { provider, refs });
          }
          // One revision across enumeration and all tenant-bound reads. A mixed
          // snapshot is never published; retry on the next bounded interval.
          if (await registry.revision() !== all.revision) throw fail();
          tenants.clear(); for (const [key, row] of next) tenants.set(key, row);
          authority.clear(); for (const [key, row] of nextAuthority) authority.set(key, row);
          revision = all.revision; polledAt = now(); usable = true;
        } catch (error) { usable = false; throw error; }
        finally { pending = null; }
      })();
      return pending;
    }
    const current = () => { if (!usable || closed || now() - polledAt > config.registry.refreshMs * 3) throw fail(); return tenants; };
    await refresh();
    timer = schedule(() => refresh().catch(() => {}), config.registry.refreshMs); timer?.unref?.();
    return Object.freeze({ tenants, refresh, current,
      authority (tenant) { current(); return authority.get(tenant); },
      stats: () => Object.freeze({ revision, usable, tenants: authority.size, sources: tenants.size }),
      async close () { closed = true; if (timer) cancel(timer); if (pending) await pending.catch(() => {}); await Promise.allSettled([connection.end(), store.close()]); }
    });
  } catch (error) { if (timer) cancel(timer); await Promise.allSettled([connection?.end(), store?.close()]); throw error; }
}
module.exports = { open };
