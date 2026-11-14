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
// It opens no connection and invokes no credential-file/provider read: connection addresses in the
// environment are parsed, never dialled, so a plan can be checked with
// placeholders. The report never repeats an environment value.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jsonSchema = require('./json-schema');
const bounds = require('./bounds');

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
  vcpool: Object.freeze({ environment: 'MULTITENANT_VCPOOL_CONFIG', roles: ['vcpool'], schema: 'vcpool' }),
  operation: Object.freeze({ environment: 'MULTITENANT_OPERATION_CONFIG', roles: ['api', 'realtime', 'evaluator', 'tenant-admin'], schema: 'operation' })
});
// Roles `nightscout multitenant` serves whose documents this contract version does not describe.
const NOT_COVERED = Object.freeze([]);
const STATIC_ENV = require('../static-tenants').ENV;

const SCHEMA_FILES = {
  'document-set': () => require('./schema/document-set.schema.json'),
  vcpool: () => require('./schema/vcpool.schema.json'),
  api: () => require('./schema/api.schema.json'),
  realtime: () => require('./schema/realtime.schema.json'),
  evaluator: () => require('./schema/evaluator.schema.json'),
  'tenant-admin': () => require('./schema/tenant-admin.schema.json'),
  admin: () => require('./schema/admin.schema.json'),
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
    placement: { environments: ['MULTITENANT_REALTIME_PLACEMENT','MULTITENANT_REALTIME_ROUTES'], versions: [1,2], validator: 'lib/realtime-placement/index.js parse with actual internal listener resolution', selection: 'NS_REALTIME_OWNERSHIP_CONTRACT' },
    limits: { bytes: bounds.MAX_BYTES, nodes: bounds.MAX_NODES, depth: bounds.MAX_DEPTH, reportBytes: bounds.MAX_REPORT_BYTES },
    provisioning: { rest: { served: 'GET /v1/openapi.json on the admin role listener', openapi },
      validation: 'checkProvisioning: actual parseSpec/checkBatch and admin parseArgs/endpoint/provisionRows; no dispatch',
      cli: ['nightscout admin provision (--id <uuid> --host <host>... | --seed <file>)', 'nightscout admin remove --id <uuid>'] } };
}

function safePath (description, pointer) {
  let node = description, result = '';
  for (const encoded of pointer.split('/').slice(1)) {
    const key = encoded.replace(/~1/g,'/').replace(/~0/g,'~');
    if (node?.properties && Object.hasOwn(node.properties,key)) node = node.properties[key];
    else if (node?.items && /^[0-9]+$/.test(key)) node = node.items;
    else return result + '/<unknown>';
    result += '/' + encoded;
  }
  return result || '/';
}

function checkProcess (entry, directory) {
  const findings = [], documents = [];
  const finding = (code, message, extra = {}) => { if (findings.length < 64) findings.push({ code, ...extra, message }); };
  const env = { ...entry.environment };
  let names;
  try { names = require('../index').parseRoles([entry.roles.join(',')]); } catch {
    finding('PLAN_ROLES_REFUSED', 'selected roles refused');
    return { name: entry.name, roles: [], ok: false, documents, unchecked: [], findings };
  }
  for (const role of names) if (NOT_COVERED.includes(role)) finding('PLAN_ROLE_NOT_COVERED', 'contract ' + VERSION + ' does not describe the ' + role + ' role');
  if (Object.hasOwn(env, STATIC_ENV)) finding('PLAN_STATIC_TENANTS', STATIC_ENV + ' is a lab and test input; a deployment plan runs in registry mode and does not set it');
  for (const role of names) {
    const row = DOCUMENTS[role];
    if (row && !Object.hasOwn(env, row.environment)) finding('PLAN_DOCUMENT_MISSING', 'selected role requires its configuration document', { document: role });
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith('NS_CONNECTION_BUDGET_')) finding('PLAN_SELECTION_NOT_COVERED', 'physical admission selection requires its authoritative controller validator');
    if (key.startsWith('MULTITENANT_') && key.endsWith('_CONFIG') && !Object.values(DOCUMENTS).some(row => row.environment === key)) finding('PLAN_SELECTION_NOT_COVERED', 'selected configuration is not described by this contract');
  }
  if (Object.hasOwn(env, 'NS_REALTIME_OWNERSHIP_CONTRACT')) {
    try {
      const selected = require('../../../realtime-placement').ownershipVersion(env);
      if (selected === 2 && !env.MULTITENANT_REALTIME_PLACEMENT && !env.MULTITENANT_REALTIME_ROUTES) finding('PLAN_DOCUMENT_MISSING', 'assignment ownership requires its carried placement document', { document: 'placement' });
    } catch { finding('PLAN_CONFIGURATION_REFUSED', 'selected ownership contract refused'); }
  }
  // 1. shape
  const described = new Set();
  for (const [name, row] of Object.entries(DOCUMENTS)) {
    if (!Object.hasOwn(env, row.environment) || !row.roles.some(role => names.includes(role))) continue;
    const file = env[row.environment];
    if (!Object.hasOwn(entry.files, file)) { finding('PLAN_DOCUMENT_MISSING', row.environment + ' names a file the process entry does not carry', { document: name }); continue; }
    described.add(file);
    const problems = jsonSchema.validate(schema(row.schema), entry.files[file]);
    documents.push({ document: name, environment: row.environment, ok: !problems.length });
    for (const problem of problems) finding('PLAN_DOCUMENT_SHAPE', problem.message, { document: name, path: safePath(schema(row.schema),problem.path) });
  }
  for (const key of ['MULTITENANT_REALTIME_PLACEMENT', 'MULTITENANT_REALTIME_ROUTES']) {
    if (!Object.hasOwn(env, key)) continue;
    const file = env[key];
    if (!names.some(role => ['api','realtime','evaluator','tenant-admin'].includes(role))) finding('PLAN_SELECTION_NOT_COVERED', 'placement is not consumed by these roles');
    else if (!Object.hasOwn(entry.files, file)) finding('PLAN_DOCUMENT_MISSING', 'selected placement file is not carried', { document: 'placement' });
    else { described.add(file); documents.push({ document: key === 'MULTITENANT_REALTIME_ROUTES' ? 'routes' : 'placement', environment: key, ok: true }); }
  }
  const unchecked = Object.keys(entry.files).filter(file => !described.has(file));
  if (unchecked.length) finding('PLAN_DOCUMENT_NOT_COVERED', 'carried document is not consumed by a selected authoritative validator');
  if (findings.some(row => ['PLAN_DOCUMENT_MISSING','PLAN_DOCUMENT_NOT_COVERED','PLAN_SELECTION_NOT_COVERED'].includes(row.code))) return { name: entry.name, roles: entry.roles, ok: false, documents, unchecked: unchecked.length ? ['<unrecognized>'] : [], findings };
  // 2. load: the files where the environment says they are, under a private directory.
  const written = new Map();
  Object.keys(entry.files).forEach((file, index) => {
    const target = path.join(directory, String(index) + '.json');
    // Fixed ordinal name: no caller path or value enters the temporary filename.
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
    const placement = require('../../../realtime-placement');
    for (const key of ['MULTITENANT_REALTIME_PLACEMENT','MULTITENANT_REALTIME_ROUTES']) {
      if (env[key] === undefined) continue;
      const original = entry.environment[key];
      placement.parse(entry.files[original], { internal: loaded.internal,
        ownershipVersion: placement.ownershipVersion(env),
        ...(key === 'MULTITENANT_REALTIME_PLACEMENT' && names.includes('realtime') ? { self: { worker: env.REALTIME_WORKER_ID, incarnation: env.REALTIME_WORKER_INCARNATION } } : {}) });
    }
    require('../index').preflight(names, env, loaded, { host: env.HOSTNAME || '127.0.0.1', port: env.PORT || 1337 });
  } catch (error) {
    // Loader messages name a rule, never a value; a temporary path is put back to the plan's.
    const known = ['Participant manifest does not match actual role resources'];
    const message = known.includes(error?.message) ? error.message : 'selected runtime validator refused configuration';
    finding(loaded ? 'PLAN_PROCESS_REFUSED' : 'PLAN_CONFIGURATION_REFUSED', message, typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,100}$/.test(error.code) ? { refusal: error.code } : {});
  } finally {
    try { command.closePlacements(loaded); } catch { finding('PLAN_READER_CLEANUP_REFUSED', 'temporary reader cleanup is unconfirmed'); }
  }
  return { name: entry.name, roles: entry.roles, ok: !findings.length, documents, unchecked: Object.keys(entry.files).filter(file => !described.has(file)), findings };
}

function failed (code, message) {
  return { contract: VERSION, ok: false, findings: [{ code, message }], processes: [] };
}
function check (set) {
  let directory, report;
  try {
    try { bounds.inspect(set); } catch { return failed('PLAN_INPUT_BOUND', 'input exceeds checker JSON bounds'); }
    const shape = jsonSchema.validate(schema('document-set'), set);
    if (shape.length) return { contract: VERSION, ok: false, findings: shape.map(problem => ({ code: 'PLAN_DOCUMENT_SET_SHAPE', path: safePath(schema('document-set'),problem.path), message: problem.message })), processes: [] };
    const names = set.processes.map(entry => entry.name);
    if (new Set(names).size !== names.length) return failed('PLAN_DOCUMENT_SET_SHAPE', 'process names repeat');
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-plan-check-'));
    const processes = set.processes.map((entry, index) => {
      const own = path.join(directory, String(index));
      // Under this call's own private directory.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.mkdirSync(own, { mode: 0o700 });
      return checkProcess(entry, own);
    });
    const provisioning = set.provisioning?.map(value => require('./provisioning').check(value));
    report = { contract: VERSION, ok: processes.every(row => row.ok) && (!provisioning || provisioning.every(row => row.ok)), findings: [], processes, ...(provisioning ? { provisioning } : {}) };
    try { bounds.inspect(report, { maxBytes: bounds.MAX_REPORT_BYTES }); }
    catch { report = failed('PLAN_REPORT_BOUND', 'report exceeds checker output bounds'); }
  } catch {
    report = failed('PLAN_CHECK_IO_REFUSED', 'checker could not complete safely');
  } finally {
    if (directory) {
      try { fs.rmSync(directory, { recursive: true, force: true }); }
      catch {
        report = report || failed('PLAN_CHECK_CLEANUP_REFUSED', 'temporary filesystem cleanup is unconfirmed');
        report.ok = false;
        if (!report.findings.some(row => row.code === 'PLAN_CHECK_CLEANUP_REFUSED')) report.findings.push({ code: 'PLAN_CHECK_CLEANUP_REFUSED', message: 'temporary filesystem cleanup is unconfirmed' });
      }
    }
  }
  return report;
}

module.exports = { VERSION, DOCUMENTS, NOT_COVERED, check, describe, schema, checkProvisioning: require('./provisioning').check };
