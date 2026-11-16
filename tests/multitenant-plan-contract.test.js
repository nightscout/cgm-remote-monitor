'use strict';

// covers: lib/server/serve/plan-contract/index.js, lib/server/serve/plan-contract/json-schema.js, lib/cli/commands/plan.js, lib/cli/commands/multitenant.js, lib/cli/index.js, lib/server/serve/index.js, lib/server/serve/preview-config.js, lib/server/realtime/config.js, lib/server/serve/evaluator-config.js, lib/server/serve/owner-preview-config.js, lib/server/serve/admin-config.js, lib/server/serve/operation-cohort-config.js, lib/server/serve/registry-config.js
//
// The deployment plan contract (decision deployment-plan-contract) against the
// role configuration loaders, so the two cannot drift. The published schemas
// (lib/server/serve/plan-contract/schema) state each role document's fields;
// the loaders decide what a role process accepts. For every document of the
// test plan (tests/fixtures/multitenant-plan.js) this suite requires:
//
//   required   a field the schema requires is one the loader refuses to do without;
//   closed     a field the schema does not name is one the loader refuses;
//   known      every field a loader reads or asks about is named by the schema,
//              or is a static-mode field the loader refuses in registry mode;
//   live       every field the schema names is one a loader reads;
//   carried    every field the schema names appears in a test plan variant, so
//              its type has met its loader.
//
// A loader that starts accepting, requiring, renaming or dropping a field turns
// one of them red until the schema (and the contract reference) follows.
// Synthetic documents only; nothing is connected to.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const contract = require('../lib/server/serve/plan-contract');
const jsonSchema = require('../lib/server/serve/plan-contract/json-schema');
const plan = require('./fixtures/multitenant-plan');
const observer = require('./fixtures/multitenant-plan-observer');

const layout = plan.layout('nstp');
// `default` is the smallest registry-mode plan; `full` sets every optional field and a fixed roster,
// with Vault credentials from the environment; `full-token-files` is `full` with token files.
const VARIANTS = ['default', 'full', 'full-token-files', 'ensure', 'ensure-token-files', 'selected-metadata'];
const documentSet = (variant = 'default') => {
  const selected = variant === 'selected-metadata' ? 'full' : variant === 'ensure' ? 'full' : variant === 'ensure-token-files' ? 'full-token-files' : variant;
  const documents = plan.documents({ layout, urls: plan.syntheticUrls(layout), variant: selected });
  const set = plan.documentSet(documents);
  if (variant === 'selected-metadata') {
    // Metadata parsing validates the selected profile without selecting a running
    // worker topology. Operational capability admission is tested separately.
    for (const entry of set.processes.filter(row => row.roles.includes('api'))) {
      const file = entry.environment.MULTITENANT_EVALUATOR_CONFIG, doc = clone(entry.files[file]);
      const source = require('../lib/pgstream/intake-profile');
      const profile = source.create({ namespace: doc.postgres.namespaces.checkpoint, membershipNamespace: 'nstp_intake_members', lifecycleNamespace: doc.activity.namespace, role: 'nstp_intake_writer', consumer: doc.consumer, revision: '1', members: 2, tenants: [plan.A,plan.B], codec: source.CODEC, generationDomain: source.GENERATION_DOMAIN });
      doc.selectedIntake = { profile: clone(profile), workers: ['evaluator-1','evaluator-2'], connectionEnv: 'NS_INTAKE_WRITER', controlConnectionEnv: 'NS_INTAKE_CONTROL' };
      doc.consumers.realtime.partitionMetadata = { checkpointNamespace: profile.binding.namespace, membershipNamespace: profile.binding.membershipNamespace, lifecycleNamespace: profile.binding.lifecycleNamespace };
      entry.files[file] = doc;
    }
  }
  if (variant.startsWith('ensure')) {
    // Carry the optional unselected ensure grammar through its ACTUAL loader.
    // These synthetic identities have no native grant/host acceptance claim.
    const entry = set.processes.find(p => p.roles.includes('admin'));
    const file = entry.environment.MULTITENANT_ADMIN_CONFIG;
    const config = entry.files[file];
    for (const key of ['ownership','pools','connectorSources','managementSessions']) delete config[key];
    config.ensure = { ...JSON.parse(JSON.stringify(config.provisioning)), ledgerNamespace: 'nstp_ensure_ledger', connectionEnv: 'NS_ENSURE_PG' };
    const dependency = require('../lib/tenant-registry/ensure-dependencies');
    const aliases = {control:'lifecycle',settings:'tenant_settings',operatorPolicy:'operator_policy'};
    config.ensure.dependencyNamespaces = Object.fromEntries(dependency.kinds.map(kind=>[kind,[{namespace:'nstp_dep_'+kind,catalogue:'canonical'}]]));
    for (const [key,namespace] of Object.entries(config.ensure.namespaces)) config.ensure.dependencyNamespaces[aliases[key] || key] = [{namespace,catalogue:'canonical'}];
    config.ensure.dependencyNamespaces.ensure_ledger = [{namespace:'nstp_ensure_ledger',catalogue:'canonical'}];
    config.ensure.dependencyNamespaces.checkpoint = config.ensure.checkpoints.map(row=>({namespace:row.namespace,catalogue:'canonical'}));
    entry.environment.NS_ENSURE_PG = 'postgres://nstp_ensure:synthetic@127.0.0.1/nightscout_synthetic';
    if (config.ensure.vault.tokenFile) config.ensure.vault.tokenFile = '/run/vault/ensure-token';
    else { config.ensure.vault.tokenEnv = 'NS_ENSURE_VAULT'; entry.environment.NS_ENSURE_VAULT = 'synthetic'; }
  }
  return set;
};
const clone = value => JSON.parse(JSON.stringify(value));
// Static-mode fields: a loader asks about each to refuse it beside `registry`.
// A sample value proves the refusal.
const REFUSED_IN_REGISTRY_MODE = {
  api: { '': { tenants: [] }, '/accessTokens': { keys: [] }, '/socketForwarding': { admissionFileEnv: 'NS_ADMISSION_FILE' } },
  realtime: { '': { tenants: [], admissionFileEnv: 'NS_ADMISSION_FILE', maxSockets: 100, pageSize: 100, recoveryIntervalMs: 1000, settingsRefreshMs: 5000, socketOrderDomains: [], changeFeed: {} } },
  evaluator: { '': { tenants: [] } },
  'tenant-admin': { '': { tenants: [] }, '/management': { keys: [] } },
  admin: { '/ownership': { tenants: [] } },
  vcpool: { '': { tenants: [] } },
  operation: { '': { locks: [] } }
};

// Every (process, document) a test plan variant produces: [{ variant, index, process, name, file }].
function documentsOf (variant) {
  const rows = [];
  documentSet(variant).processes.forEach((entry, index) => {
    for (const [name, row] of Object.entries(contract.DOCUMENTS)) {
      const file = entry.environment[row.environment];
      if (file && entry.files[file] && row.roles.some(role => entry.roles.includes(role))) rows.push({ variant, index, process: entry.name, name, file, environment: row.environment });
    }
  });
  return rows;
}
// One process of a fresh set, with one of its documents changed.
function verdict (row, mutate) {
  const set = documentSet(row.variant), entry = set.processes[row.index];
  mutate(entry.files[row.file]);
  const report = contract.check({ contract: 1, processes: [entry] }), codes = report.processes[0].findings.map(finding => finding.code);
  return { shape: codes.includes('PLAN_DOCUMENT_SHAPE'), loader: codes.includes('PLAN_CONFIGURATION_REFUSED'), codes };
}
// Every object the schema describes that the document carries: [{ pointer, steps, schema }]
// (pointer writes an array index as `*`; steps reach the first item).
function objects (schema, value, pointer = '', steps = []) {
  const rows = [];
  // Generated profile values validate canonical binding/digests and regenerate
  // assignment; they are not closed operator configuration objects.
  if (opaqueProfile(pointer)) return rows;
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    rows.push({ pointer, steps, schema });
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) rows.push(...objects(child, value[key], pointer + '/' + key, [...steps, key]));
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && value.length && schema.items) rows.push(...objects(schema.items, value[0], pointer + '/*', [...steps, 0]));
  return rows;
}
const opaqueProfile = pointer => pointer === '/intakeProfile' || pointer === '/selectedIntake/profile';
const withinProfile = pointer => ['/intakeProfile','/selectedIntake/profile'].some(prefix => pointer === prefix || pointer.startsWith(prefix + '/'));
const reach = (document, steps) => steps.reduce((value, step) => value[step], document);

describe('deployment plan contract', function () {
  this.timeout(60000);
  const rows = VARIANTS.flatMap(documentsOf);

  it('accepts the test plan: every document matches its schema and every process passes its loaders', function () {
    const roster = ['realtime', 'evaluator', 'tenant-admin', 'api-1', 'api-2', 'admin', 'vcpool'];
    const expected = { default: ['api', 'realtime', 'evaluator', 'tenant-admin', 'admin', 'vcpool'], full: roster, 'full-token-files': roster, ensure:roster, 'ensure-token-files':roster, 'selected-metadata':roster };
    for (const variant of VARIANTS) {
      const report = contract.check(documentSet(variant));
      assert.equal(report.ok, true, variant + ': ' + JSON.stringify(report.processes.flatMap(row => row.findings)));
      assert.deepEqual(report.processes.map(row => row.name), expected[variant]);
      assert.deepEqual(report.processes.flatMap(row => row.unchecked), []);
      // Every described document appears in each variant, so the agreement below covers each schema.
      assert.deepEqual([...new Set(documentsOf(variant).map(row => row.name))].sort(), Object.keys(contract.DOCUMENTS).sort());
    }
  });

  it('requires the maintained product paths and refuses retired discovery fields', function () {
    const documents = plan.documents({ layout, urls: plan.syntheticUrls(layout) });
    const good = role => jsonSchema.validate(contract.schema(role), documents.configs[role]);
    for (const role of ['evaluator', 'realtime']) {
      assert.deepEqual(good(role), []);
      const required = role === 'evaluator' ? ['pgstream', 'trustedWorker', 'registry', 'tenantSettings', 'activity']
        : ['completedOutput', 'trustedWorker', 'registry', 'tenantSettings', 'activity'];
      for (const field of required) {
        const broken = clone(documents.configs[role]); delete broken[field];
        assert(jsonSchema.validate(contract.schema(role), broken).length, role + ' missing ' + field);
        assert.deepEqual(good(role), []);
      }
      for (const field of ['changeFeed', 'recoveryIntervalMs', 'settingsRefreshMs', 'tenants', ...(role === 'realtime' ? ['pageSize', 'socketOrderDomains', 'admissionFileEnv'] : [])]) {
        const broken = clone(documents.configs[role]); broken[field] = {};
        assert(jsonSchema.validate(contract.schema(role), broken).length, role + ' retired ' + field);
        assert.deepEqual(good(role), []);
      }
    }
    assert.deepEqual(Object.keys(documents.configs.realtime.postgres.namespaces).sort(), ['checkpoint', 'clock']);
    assert(!plan.documentSet(documents).processes.some(row => row.roles.includes('feed-reader')));
    assert(!Object.hasOwn(contract.DOCUMENTS, 'feed-reader'));
  });

  it('carried: every field a schema names appears in a test plan variant', function () {
    // Pointers of every field a schema names, and of every field the variants' documents carry.
    const namedBy = (schema, pointer = '') => schema.type === 'array' && schema.items ? namedBy(schema.items, pointer + '/*')
      : Object.entries(schema.properties || {}).flatMap(([key, child]) => [pointer + '/' + key, ...namedBy(child, pointer + '/' + key)]);
    const carriedBy = (value, pointer = '') => Array.isArray(value) ? value.flatMap(item => carriedBy(item, pointer + '/*'))
      : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, child]) => [pointer + '/' + key, ...carriedBy(child, pointer + '/' + key)]) : [];
    for (const name of Object.keys(contract.DOCUMENTS)) {
      const carried = new Set(rows.filter(row => row.name === name).flatMap(row => carriedBy(documentSet(row.variant).processes[row.index].files[row.file])));
      assert.deepEqual(namedBy(contract.schema(contract.DOCUMENTS[name].schema)).filter(pointer => !carried.has(pointer)), [], name);
    }
  });

  it('generated profile values validate canonical binding and digests, while assignment is regenerated', function () {
    const set = documentSet('selected-metadata'), entry = set.processes.find(row => row.roles.includes('api'));
    const file = entry.environment.MULTITENANT_EVALUATOR_CONFIG;
    const good = () => contract.check({contract:1,processes:[entry]});
    assert.equal(good().ok,true);
    const profile = entry.files[file].selectedIntake.profile;
    profile.assignment = { forged: 'ignored source metadata' };
    assert.equal(good().ok,true,'assignment is regenerated from validated canonical binding');
    for (const mutate of [p => {p.digest='0'.repeat(64);}, p => {p.binding.lifecycleNamespace='foreign';}, p => {p.binding.controlReads={};}]) {
      const original = clone(entry.files[file].selectedIntake.profile); mutate(entry.files[file].selectedIntake.profile); assert.equal(good().ok,false);
      entry.files[file].selectedIntake.profile = original; assert.equal(good().ok,true);
    }
  });

  it('publishes schemas that use only keywords the check evaluates', function () {
    for (const name of [...Object.keys(contract.DOCUMENTS), 'document-set']) contract.schema(name);
    assert.throws(() => jsonSchema.compile({ type: 'object', oneOf: [] }), { code: 'PLAN_CONTRACT_SCHEMA_INVALID' });
  });

  for (const row of rows) {
    describe(row.variant + ' plan: ' + row.name + ' document of the ' + row.process + ' process', function () {
      const schema = contract.schema(contract.DOCUMENTS[row.name].schema);
      const document = documentSet(row.variant).processes[row.index].files[row.file];
      const described = objects(schema, document);

      it('required: the loader refuses the document without each field the schema requires', function () {
        let probes = 0;
        for (const object of described) {
          for (const field of object.schema.required || []) {
            const result = verdict(row, changed => { delete reach(changed, object.steps)[field]; });
            assert.equal(result.shape, true, object.pointer + '/' + field + ': the schema accepted the document without it');
            assert.equal(result.loader, true, object.pointer + '/' + field + ': the schema requires it, the loader accepted the document without it');
            probes++;
          }
        }
        assert(probes > 0);
      });

      it('closed: the loader refuses a field the schema does not name', function () {
        for (const object of described) {
          assert.equal(object.schema.additionalProperties, false, object.pointer + ': the schema leaves this object open');
          const result = verdict(row, changed => { reach(changed, object.steps).notInTheContract = 1; });
          assert.equal(result.shape, true, object.pointer + ': the schema accepted an unnamed field');
          assert.equal(result.loader, true, object.pointer + ': the loader accepted a field the schema does not name');
        }
      });

      it('known and live: the fields the loader reads are the fields the schema names', function () {
        const watching = observer.install();
        let reads;
        try {
          const set = documentSet(row.variant);
          assert.equal(contract.check({ contract: 1, processes: [set.processes[row.index]] }).ok, true);
          reads = watching.reads(row.environment);
        } finally { watching.restore(); }
        const refused = REFUSED_IN_REGISTRY_MODE[row.name];
        for (const object of described) {
          const named = Object.keys(object.schema.properties || {}), seen = [...(reads.get(object.pointer) || [])];
          const unknown = seen.filter(field => !named.includes(field) && !Object.hasOwn(refused[object.pointer] || {}, field));
          assert.deepEqual(unknown, [], object.pointer + ': the loader reads fields the schema does not name');
          const unread = named.filter(field => !seen.includes(field));
          assert.deepEqual(unread, [], object.pointer + ': the schema names fields the loader never reads');
        }
        // No loader read lands on an object the schema does not describe.
        const pointers = described.map(object => object.pointer);
        assert.deepEqual([...reads.keys()].filter(pointer => !pointers.includes(pointer) && !withinProfile(pointer)), []);
      });

      it('refuses each static-mode field in registry mode', function () {
        for (const [pointer, fields] of Object.entries(REFUSED_IN_REGISTRY_MODE[row.name])) {
          const object = described.find(candidate => candidate.pointer === pointer);
          const dedicated = row.name === 'admin' && row.variant.startsWith('ensure') && pointer === '/ownership';
          assert(object || dedicated, pointer);
          for (const [field, sample] of Object.entries(fields)) {
            const result = verdict(row, changed => {
              if (object) reach(changed, object.steps)[field] = clone(sample);
              else {
                const full = documentSet('full').processes.find(p=>p.roles.includes('admin'));
                changed.ownership = clone(full.files[full.environment.MULTITENANT_ADMIN_CONFIG].ownership);
                changed.ownership[field] = clone(sample);
              }
            });
            assert.equal(result.shape, true, pointer + '/' + field);
            assert.equal(result.loader, true, pointer + '/' + field + ': the loader accepted a static-mode field beside registry');
          }
        }
      });
    });
  }

  describe('process rules', function () {
    const only = (name, mutate) => { const set = documentSet(), entry = set.processes.find(candidate => candidate.name === name); mutate(entry); return contract.check({ contract: 1, processes: [entry] }).processes[0]; };

    it('refuses a participant manifest that does not name the namespaces the role protects', function () {
      const result = only('realtime', entry => { entry.files['/run/ns-config/operation.json'].participants.find(peer => peer.id === 'realtime').namespaces.pop(); });
      assert.deepEqual(result.findings.map(finding => finding.code), ['PLAN_PROCESS_REFUSED']);
      assert.match(result.findings[0].message, /Participant manifest does not match actual role resources/);
    });

    it('refuses the static tenant list flag, a missing document and an unknown role', function () {
      assert(only('api', entry => { entry.environment.MULTITENANT_STATIC_TENANTS = 'lab'; }).findings.some(finding => finding.code === 'PLAN_STATIC_TENANTS'));
      assert(only('api', entry => { delete entry.files['/run/ns-config/operation.json']; }).findings.some(finding => finding.code === 'PLAN_DOCUMENT_MISSING'));
      assert.deepEqual(only('api', entry => { entry.roles = ['api', 'nonesuch']; }).findings.map(finding => finding.code), ['PLAN_ROLES_REFUSED']);
    });

    it('refuses listener settings the role process refuses, and never repeats an environment value', function () {
      const result = only('admin', entry => { entry.environment.ADMIN_HOSTNAME = '0.0.0.0'; });
      assert.deepEqual(result.findings.map(finding => finding.code), ['PLAN_PROCESS_REFUSED']);
      const report = JSON.stringify(contract.check(documentSet()));
      assert.equal(report.includes('synthetic@'), false);
    });

    it('refuses a document set that is not one', function () {
      assert.equal(contract.check({ contract: 2, processes: [] }).ok, false);
      const set = documentSet(); set.processes.push(clone(set.processes[0]));
      assert.deepEqual(contract.check(set).findings.map(finding => finding.message), ['process names repeat']);
    });
  });

  describe('nightscout plan', function () {
    const bin = path.resolve(__dirname, '../bin/nightscout.js');
    const cli = (args, input) => spawnSync(process.execPath, [bin, 'plan', ...args], { encoding: 'utf8', timeout: 30000, input, env: { PATH: process.env.PATH } });

    it('check exits 0 for the test plan, 1 with findings for a changed document, 64 for unreadable input', function () {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-plan-cli-'));
      try {
        const file = path.join(directory, 'set.json');
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        fs.writeFileSync(file, JSON.stringify(documentSet()));
        const accepted = cli(['check', file]);
        assert.equal(accepted.status, 0, accepted.stderr);
        assert.equal(JSON.parse(accepted.stdout).ok, true);
        assert.match(accepted.stderr, /contract 1, 6 processes, 0 findings: accepted/);
        const set = documentSet(); set.processes[0].files['/run/ns-config/config.json'].tenants = [];
        const refused = cli(['check', '-'], JSON.stringify(set));
        assert.equal(refused.status, 1);
        assert.deepEqual(JSON.parse(refused.stdout).processes[0].findings.map(finding => finding.code), ['PLAN_DOCUMENT_SHAPE', 'PLAN_CONFIGURATION_REFUSED']);
        assert.equal(cli(['check', path.join(directory, 'absent.json')]).status, 64);
        assert.equal(cli(['nonesuch']).status, 64);
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });

    it('contract prints the version, every document schema and the provisioning interface', function () {
      const printed = cli(['contract']);
      assert.equal(printed.status, 0, printed.stderr);
      const value = JSON.parse(printed.stdout);
      assert.equal(value.contract, contract.VERSION);
      assert.deepEqual(Object.keys(value.documents).sort(), Object.keys(contract.DOCUMENTS).sort());
      assert.deepEqual(value.provisioning.rest.openapi, require('../lib/tenant-registry/openapi.json'));
      for (const route of ['/v1/tenants', '/v1/tenants/batch', '/v1/tenants/{id}']) assert(Object.hasOwn(value.provisioning.rest.openapi.paths, route), route);
    });
  });
});
