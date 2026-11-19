'use strict';
// Real preview/legacy/secrets constructors with recording metadata ports only.
// Native serving, RLS and provider round trips remain separate criteria.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const profiles = require('../lib/pgstream/pool-intake-profile');
const scope = require('../lib/storage/tenant-scope');
const A = '11111111-1111-4111-8111-111111111111';
const profile = profiles.create({ namespace: 'synthetic_checkpoint', membershipNamespace: 'synthetic_membership', lifecycleNamespace: 'synthetic_control', role: 'synthetic_intake', operatorRole: 'synthetic_assignment', consumer: 'evaluator-synthetic', codec: profiles.CODEC, generationDomain: profiles.GENERATION_DOMAIN, sliceRule: require('../lib/pool-membership/slice').RULE });
function compiled (filename, imports, mutate = source => source) {
  const module = new Module(filename); module.filename = filename; module.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = module.require.bind(module); module.require = name => Object.hasOwn(imports, name) ? imports[name] : original(name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Exact require.resolve source paths above.
  module._compile(mutate(fs.readFileSync(filename, 'utf8')), filename); return module.exports;
}
async function composition (localVerification, { mutatePreview, unsafeMetadata = false } = {}) {
  const previous = scope.getTenancyMode();
  let window;
  try {
    let legacyOptions, epochRead, legacyFailure, constructed = 0, sharedOpens = 0, screens = 0, epochQueries = 0;
    const noIO = () => { throw new Error('Unexpected physical I/O'); };
    // The real legacy constructor now screens its supplied shared connection.
    // Keep metadata reads tenant-bound; no extra authority pool is opened.
    const metadata = {
      withTenant: async (tenant, fn) => {
        assert([A, '00000000-0000-0000-0000-000000000000'].includes(tenant));
        return scope.withTenant(tenant, fn);
      },
      end: async () => {},
      query: async (sql, values) => {
        assert.equal(typeof sql, 'string');
        if (sql.includes('FROM pg_class')) {
          screens++;
          assert.equal(scope.currentTenant(), '00000000-0000-0000-0000-000000000000');
          assert.deepEqual(values, ['"synthetic_legacy".legacy_credential_config', '"synthetic_legacy".legacy_credential_subjects',
            ...(localVerification ? ['"synthetic_legacy".legacy_data_keys'] : [])]);
          return { rows: Array.from({ length: localVerification ? 3 : 2 }, () => ({ secured: true, owns: false, reads: true, writes: unsafeMetadata })) };
        }
        epochQueries++;
        assert.equal(scope.currentTenant(), A);assert.deepEqual(values, [A]);
        assert(sql.includes('"synthetic_control".tenant_lifecycle_recommission x WHERE x.tenant_id=c.tenant_id AND x.activated'));
        return { rows: [{ root_reference_id: 'root', subject_id: 'subject', token_prefix: 'named', root_version: 9, previous_profile_allowed: false }] };
      }
    };
    const legacy = compiled(require.resolve('../lib/secrets/legacy-postgres'), { '../storage/postgres-connection': noIO });
    window = require('../lib/tenant-lifecycle/operation-window').create({ namespace: profile.binding.lifecycleNamespace, lockRule: 'tenant-id-sha256-v1', intakeProfile: profile, pool: { connect: noIO, options: { max: 2 } }, leaseSessionCount: 1 });
    const preview = compiled(require.resolve('../lib/server/serve/preview-api'), {
      './role-readiness': require('./fixtures/role-readiness')(), './postgres-domains': { readiness: async () => {}, assertServing: async () => ({}) },
      // Admin-certified tenant floors are read per request, not at boot; outside this criterion.
     
      './registry-tenants': { create: async () => ({ bindings: new Map(), providers: new Map(), environments: new Map(), close: async () => {} }) },
      '../../secrets/legacy-postgres': async options => { legacyOptions = options; try { return await legacy(options); } catch (error) { legacyFailure = error; throw error; } },
      '../../secrets/postgres': { createPostgresSecrets: async () => ({ store: { get: noIO, insert: noIO }, audit: async () => {}, close: async () => {} }) },
      '../../storage/postgres-connection': async () => { sharedOpens++; return metadata; },
      '../../tenant-authorization/postgres': async () => ({ close: async () => {} }),
      '../../secrets/component': { createSecrets: options => {
        require('../lib/secrets/component').createSecrets(options); constructed++;
        epochRead = options.legacySessionEpochFor(A);
        throw new Error('Recording constructor boundary complete');
      } }
    }, mutatePreview);
    const boot = preview.boot({ registry: {}, resolution: { mode: 'direct-alias' }, connectionString: 'synthetic', localDataAuthentication: localVerification,
      namespaces: { legacy: 'synthetic_legacy', secrets: 'synthetic_secrets', authorization: 'synthetic_authorization' } }, { operationWindow: window });
    if (unsafeMetadata) {
      // The API entered through serving role readiness. A standalone
      // constructor still runs the metadata screen.
      await assert.rejects(boot);
      assert.equal(legacyFailure, undefined, 'serving API does not re-screen');
      await assert.rejects(legacy({ ...legacyOptions, roleAdmitted: false }), { code: 'SECRETS_LEGACY_AUTHORITY_UNSAFE' });
      assert.equal(screens, 1, 'the standalone constructor ran the privilege screen');
    } else {
      // The public boot boundary sanitizes constructor errors. The recording
      // constructor and exact epoch assertions below prove the reached stage.
      await assert.rejects(boot);
      assert.equal(legacyFailure, undefined);
      assert.equal(constructed, 1, 'actual legacy constructor must succeed in both supported modes');
      assert.deepEqual(await epochRead, { tenant: A, version: 9, enforced: true });
      assert.equal(epochQueries, 1, 'current recommission epoch comes from the tenant-bound authority');
    }
    assert.equal(sharedOpens, 1);assert.equal(legacyOptions.roleAdmitted, true, 'admitted API skips the adapter screen');
    if (!unsafeMetadata) assert.equal(screens, 0, 'NO_PLATFORM_SCREEN_IN_SERVING_BOOT');
    assert.equal(legacyOptions.connection, metadata, 'legacy authority uses the supplied API connection');
    assert.equal(legacyOptions.verificationConnection, localVerification ? metadata : undefined);
    assert.equal(legacyOptions.localVerification, localVerification);assert.equal(legacyOptions.recommissionNamespace, 'synthetic_control');
  } finally {
    try { if (window) await window.close(); } finally { scope.setTenancyMode(previous); }
  }
}

describe('selected recommission authentication preview composition', function () {
  it('constructs selected-v2 legacy and Node authentication with the same current tenant epoch authority', async function () {
    for (const localVerification of [false, true]) await composition(localVerification);
  });
  it('control: unsafe shared metadata is refused by the standalone constructor, then safe metadata restores', async function () {
    for (const localVerification of [false, true]) {
      await composition(localVerification, { unsafeMetadata: true });
      await composition(localVerification);
    }
  });
  it('control: a stale epoch substitution is caught through the actual preview constructor, then restores', async function () {
    const mutatePreview = source => {
      const actual = 'legacySessionEpochFor: async tenant => (await legacy.read(tenant)).sessionEpoch';
      assert.equal(source.split(actual).length, 2, 'the actual epoch accessor exists exactly once');
      return source.replace(actual, 'legacySessionEpochFor: async tenant => ({ tenant, version: 8, enforced: true })');
    };
    for (const localVerification of [false, true]) {
      await assert.rejects(composition(localVerification, { mutatePreview }), error => {
        assert.equal(error.code, 'ERR_ASSERTION');assert.equal(error.actual.version, 8);assert.equal(error.expected.version, 9);return true;
      });
      await composition(localVerification);
    }
  });
});
