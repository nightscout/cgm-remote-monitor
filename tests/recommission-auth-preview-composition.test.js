'use strict';
// Real preview/legacy/secrets constructors with recording metadata ports only.
// Native serving, RLS and provider round trips remain separate criteria.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const profiles = require('../lib/pgstream/pool-intake-profile');
const scope = require('../lib/storage/tenant-scope');
const A = '11111111-1111-4111-8111-111111111111';
const profile = profiles.create({ namespace: 'synthetic_checkpoint', membershipNamespace: 'synthetic_membership', lifecycleNamespace: 'synthetic_control', role: 'synthetic_intake', operatorRole: 'synthetic_assignment', consumer: 'evaluator-synthetic', codec: profiles.CODEC, generationDomain: profiles.GENERATION_DOMAIN, sliceRule: require('../lib/pool-membership/slice').RULE });
function compiled (filename, imports) {
  const module = new Module(filename); module.filename = filename; module.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = module.require.bind(module); module.require = name => Object.hasOwn(imports, name) ? imports[name] : original(name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Exact require.resolve source paths above.
  module._compile(fs.readFileSync(filename, 'utf8'), filename); return module.exports;
}
describe('selected recommission authentication preview composition', function () {
  it('constructs selected-v2 legacy and Node authentication with the same current tenant epoch authority', async function () {
    const previous = scope.getTenancyMode();
    try {
      for (const localVerification of [false, true]) {
        let legacyOptions, epochRead, constructed = 0;
        const metadata = { withTenant: async (tenant, fn) => { assert([A, '00000000-0000-0000-0000-000000000000'].includes(tenant)); return fn(); }, end: async () => {},
          query: async sql => {
            if (sql.includes('FROM pg_class')) return { rows: Array.from({ length: localVerification ? 3 : 2 }, () => ({ secured: true, owns: false, reads: true, writes: false })) };
            assert(sql.includes('"synthetic_control".tenant_lifecycle_recommission x WHERE x.tenant_id=c.tenant_id AND x.activated'));
            return { rows: [{ root_reference_id: 'root', subject_id: 'subject', token_prefix: 'named', root_version: 9, previous_profile_allowed: false }] };
          } };
        const legacy = compiled(require.resolve('../lib/secrets/legacy-postgres'), { '../storage/postgres-connection': async () => metadata });
        const noIO = () => { throw new Error('Unexpected physical I/O'); };
        const window = require('../lib/tenant-lifecycle/operation-window').create({ namespace: profile.binding.lifecycleNamespace, lockRule: 'tenant-id-sha256-v1', intakeProfile: profile, pool: { connect: noIO, options: { max: 2 } }, leaseSessionCount: 1 });
        const preview = compiled(require.resolve('../lib/server/serve/preview-api'), {
          './postgres-domains': { readiness: async () => {}, assertServing: async () => ({}) },
          './registry-tenants': { create: async () => ({ bindings: new Map(), providers: new Map(), environments: new Map(), close: async () => {} }) },
          '../../secrets/legacy-postgres': async options => { legacyOptions = options; return legacy(options); },
          '../../secrets/postgres': { createPostgresSecrets: async () => ({ store: { get: noIO, insert: noIO }, audit: async () => {}, close: async () => {} }) },
          '../../storage/postgres-connection': async () => ({ end: async () => {} }),
          '../../tenant-authorization/postgres': async () => ({ close: async () => {} }),
          '../../secrets/component': { createSecrets: options => {
            require('../lib/secrets/component').createSecrets(options); constructed++;
            epochRead = options.legacySessionEpochFor(A);
            throw new Error('Recording constructor boundary complete');
          } }
        });
        try {
          await assert.rejects(preview.boot({ registry: {}, resolution: { mode: 'direct-alias' }, connectionString: 'synthetic', localDataAuthentication: localVerification,
            namespaces: { legacy: 'synthetic_legacy', secrets: 'synthetic_secrets', authorization: 'synthetic_authorization' } }, { operationWindow: window }));
          assert.equal(constructed, 1, 'actual legacy constructor must succeed in both supported modes');
          assert.equal(legacyOptions.localVerification, localVerification); assert.equal(legacyOptions.recommissionNamespace, 'synthetic_control');
          assert.deepEqual(await epochRead, { tenant: A, version: 9, enforced: true });
        } finally { await window.close(); }
      }
    } finally { scope.setTenancyMode(previous); }
  });
});
