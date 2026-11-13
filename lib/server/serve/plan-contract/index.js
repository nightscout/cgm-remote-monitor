'use strict';

// The deployment plan contract (decision deployment-plan-contract): what a
// deployment plan must produce for the multitenant role processes, published so
// that a plan kept outside this repository (nightscout-deploy's, or a hosting
// provider's own) can be checked against one core commit. docs/multitenant-plan-contract.md
// is the reference.
//
// A plan hands over a document set: one entry per role process, with the roles
// it serves, its environment, and the JSON files that environment names.
//
//   { "contract": 1, "processes": [
//       { "name": "api", "roles": ["api"],
//         "environment": { "MULTITENANT_PREVIEW_CONFIG": "/run/ns-config/config.json", ... },
//         "files": { "/run/ns-config/config.json": { ... }, ... } } ] }
//
// check(set) answers whether every process in it would pass the configuration
// phase of `nightscout multitenant <roles>`, in registry mode:
//
//   1. shape   each role configuration document against its published JSON
//              Schema (./schema), which names the field a refusal is about;
//   2. load    the role's own loaders, through the command's configuration
//              phase (lib/cli/commands/multitenant.js `configure`), on the
//              files written to a private temporary directory. The loaders are the authority: value rules
//              a schema cannot state (distinct database identities, bounds
//              that depend on each other) are theirs;
//   3. set     the rules `start` applies before it opens anything
//              (lib/server/serve/index.js `preflight`): listener settings, the roles one process may combine, and the
//              participant manifest against the namespaces the roles protect.
//
// It opens no connection and reads no credential: connection addresses in the
// environment are parsed, never dialled, so a plan can be checked with
// placeholders. The report never repeats an environment value.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jsonSchema = require('./json-schema');

const VERSION = 1;
// Each role configuration document: the environment variable that names its
// file, the roles whose process reads it, and its schema.
const DOCUMENTS = Object.freeze({
  api: Object.freeze({ environment: 'MULTITENANT_PREVIEW_CONFIG', roles: ['api'], schema: 'api' }),
  realtime: Object.freeze({ environment: 'MULTITENANT_REALTIME_CONFIG', roles: ['realtime'], schema: 'realtime' }),
  // The api reads the evaluator's document as metadata (socketForwarding.consumerState).
  evaluator: Object.freeze({ environment: 'MULTITENANT_EVALUATOR_CONFIG', roles: ['evaluator', 'api'], schema: 'evaluator' }),
  'tenant-admin': Object.freeze({ environment: 'MULTITENANT_OWNER_PREVIEW_CONFIG', roles: ['tenant-admin'], schema: 'tenant-admin' }),
  admin: Object.freeze({ environment: 'MULTITENANT_ADMIN_CONFIG', roles: ['admin'], schema: 'admin' }),
  'feed-reader': Object.freeze({ environment: 'MULTITENANT_FEED_CONFIG', roles: ['feed-reader'], schema: 'feed-reader' }),
  operation: Object.freeze({ environment: 'MULTITENANT_OPERATION_CONFIG', roles: ['api', 'realtime', 'evaluator', 'tenant-admin'], schema: 'operation' })
});
// Roles `nightscout multitenant` serves whose documents this contract version does not describe.
const NOT_COVERED = Object.freeze(['vcpool']);
const STATIC_ENV = require('../static-tenants').ENV;

const SCHEMA_FILES = {
  'document-set': () => require('./schema/document-set.schema.json'),
  api: () => require('./schema/api.schema.json'),
  realtime: () => require('./schema/realtime.schema.json'),
  evaluator: () => require('./schema/evaluator.schema.json'),
  'tenant-admin': () => require('./schema/tenant-admin.schema.json'),
  admin: () => require('./schema/admin.schema.json'),
  'feed-reader': () => require('./schema/feed-reader.schema.json'),
  operation: () => require('./schema/operation.schema.json')
};
const schemas = new Map();
function schema (name) {
  if (!Object.hasOwn(SCHEMA_FILES, name)) throw new TypeError('Unknown plan contract schema');
  if (!schemas.has(name)) schemas.set(name, jsonSchema.compile(SCHEMA_FILES[name](), name));
  return schemas.get(name);
}

// The contract as one JSON value, for a plan author without this source tree.
function describe () {
  const openapi = require('../../../tenant-registry/openapi.json');
  return { contract: VERSION,
    documentSet: schema('document-set'),
    documents: Object.fromEntries(Object.entries(DOCUMENTS).map(([name, row]) => [name, { environment: row.environment, roles: row.roles, schema: schema(row.schema) }])),
    notCovered: [...NOT_COVERED],
    provisioning: { rest: { served: 'GET /v1/openapi.json on the admin role listener', openapi },
      cli: ['nightscout admin provision (--id <uuid> --host <host>... | --seed <file>)', 'nightscout admin remove --id <uuid>'] } };
}

function checkProcess (entry, directory) {
  const findings = [], documents = [];
  const finding = (code, message, extra = {}) => { findings.push({ code, ...extra, message }); };
  const env = { ...entry.environment };
  let names;
  try { names = require('../index').parseRoles([entry.roles.join(',')]); } catch (error) {
    finding('PLAN_ROLES_REFUSED', error.message);
    return { name: entry.name, roles: entry.roles, ok: false, documents, unchecked: Object.keys(entry.files), findings };
  }
  for (const role of names) if (NOT_COVERED.includes(role)) finding('PLAN_ROLE_NOT_COVERED', 'contract ' + VERSION + ' does not describe the ' + role + ' role');
  if (Object.hasOwn(env, STATIC_ENV)) finding('PLAN_STATIC_TENANTS', STATIC_ENV + ' is a lab and test input; a deployment plan runs in registry mode and does not set it');
  // 1. shape
  const described = new Set();
  for (const [name, row] of Object.entries(DOCUMENTS)) {
    if (!Object.hasOwn(env, row.environment) || !row.roles.some(role => names.includes(role))) continue;
    const file = env[row.environment];
    if (!Object.hasOwn(entry.files, file)) { finding('PLAN_DOCUMENT_MISSING', row.environment + ' names a file the process entry does not carry', { document: name }); continue; }
    described.add(file);
    const problems = jsonSchema.validate(schema(row.schema), entry.files[file]);
    documents.push({ document: name, environment: row.environment, ok: !problems.length });
    for (const problem of problems) finding('PLAN_DOCUMENT_SHAPE', problem.message, { document: name, path: problem.path });
  }
  // 2. load: the files where the environment says they are, under a private directory.
  const written = new Map();
  Object.keys(entry.files).forEach((file, index) => {
    const target = path.join(directory, String(index) + '-' + path.basename(file).replace(/[^A-Za-z0-9._-]/g, '_'));
    // Under this call's own mkdtemp directory; the name is the index and a reduced basename.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fs.writeFileSync(target, JSON.stringify(entry.files[file]), { mode: 0o600 });
    written.set(file, target);
  });
  for (const [key, value] of Object.entries(env)) if (written.has(value)) env[key] = written.get(value);
  // The command's own configuration phase, then `start`'s rules for the loaded set.
  const command = require('../../../cli/commands/multitenant');
  let loaded;
  try {
    loaded = command.configure(names, env);
    // 3. set
    require('../index').preflight(names, env, loaded, { host: env.HOSTNAME || '127.0.0.1', port: env.PORT || 1337 });
  } catch (error) {
    // Loader messages name a rule, never a value; a temporary path is put back to the plan's.
    let message = String(error && error.message || 'refused');
    for (const [file, target] of written) message = message.split(target).join(file);
    finding(loaded ? 'PLAN_PROCESS_REFUSED' : 'PLAN_CONFIGURATION_REFUSED', message, typeof error?.code === 'string' ? { refusal: error.code } : {});
  } finally { command.closePlacements(loaded); }
  return { name: entry.name, roles: entry.roles, ok: !findings.length, documents, unchecked: Object.keys(entry.files).filter(file => !described.has(file)), findings };
}

function check (set) {
  const shape = jsonSchema.validate(schema('document-set'), set);
  if (shape.length) return { contract: VERSION, ok: false, findings: shape.map(problem => ({ code: 'PLAN_DOCUMENT_SET_SHAPE', path: problem.path, message: problem.message })), processes: [] };
  const names = set.processes.map(entry => entry.name);
  if (new Set(names).size !== names.length) return { contract: VERSION, ok: false, findings: [{ code: 'PLAN_DOCUMENT_SET_SHAPE', path: '/processes', message: 'process names repeat' }], processes: [] };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-plan-check-'));
  try {
    const processes = set.processes.map((entry, index) => {
      const own = path.join(directory, String(index));
      // Under this call's own mkdtemp directory.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.mkdirSync(own, { mode: 0o700 });
      return checkProcess(entry, own);
    });
    return { contract: VERSION, ok: processes.every(row => row.ok), findings: [], processes };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

module.exports = { VERSION, DOCUMENTS, NOT_COVERED, check, describe, schema };
