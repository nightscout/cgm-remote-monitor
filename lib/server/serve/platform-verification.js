'use strict';

// The internal admin plane owns verification. Serving identities can only read
// the result. A record binds code/schema expectations to this database birth
// and this database role; a restore/restart or role replacement needs a new
// admin verification. Read-only rechecks retain an unexpired prior result;
// failure revokes it. Explicit invalidation fences platform mutations.
const crypto = require('node:crypto');
const { Client } = require('pg');
const diagnostics = require('./platform-verification-diagnostic');
const monotonic = () => require('node:perf_hooks').performance.now();
let generation;
function sourceGeneration () {
  if (generation) return generation;
  const paths = ['./platform-verification', './platform-verification-diagnostic', './platform-verification-admin', './postgres-domains', './evaluator-readiness', '../../secrets/postgres', '../../secrets/legacy-postgres', '../../tenant-authorization/postgres', '../../tenant-authorization/access-postgres', '../../subject-admin/postgres', '../../tenant-activity/postgres', '../../trusted-worker/postgres'];
  const hash = crypto.createHash('sha256');
  // Every path above is a source-owned literal; configuration cannot add one.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const path of paths) hash.update(require('node:fs').readFileSync(require.resolve(path)));
  generation = hash.digest('hex'); return generation;
}
function connectionIdentity (value) { const url = new URL(value); return [url.hostname, url.port || '5432', decodeURIComponent(url.pathname.slice(1)), decodeURIComponent(url.username)]; }
const VERSION = 'platform-verification-v1';
const ROLES = Object.freeze(['api', 'evaluator', 'realtime']);
const failure = code => Object.assign(new Error(code), { code });
const validName = name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(name) && !name.startsWith('pg_') && !['public', 'information_schema'].includes(name);
const quote = name => '"' + name.replaceAll('"', '""') + '"';
function selected (value, role) {
  if (value === undefined) return undefined;
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'namespace,role' || !validName(value.namespace) || !ROLES.includes(value.role) || value.role !== role) throw failure('PLATFORM_VERIFICATION_CONFIG');
  return Object.freeze({ namespace: value.namespace, role });
}
function stable (value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function contract (config, role) {
  const catalogues = role === 'api' ? require('./postgres-domains').cataloguesFor(config) : require('./evaluator-readiness').cataloguesFor(config);
  const fields = ['namespaces', 'domains', 'writeClock', 'socketOrderDomains', 'trustedWorker', 'completedOutput', 'consumer', 'localDataAuthentication', 'legacyEnabled', 'contextEnabled'];
  const selection = Object.fromEntries(fields.filter(key => config[key] !== undefined).map(key => [key, config[key]]));
  if (config.registry) selection.registry = config.registry.namespace;
  if (config.tenantSettings) selection.settings = config.tenantSettings.namespaces;
  if (config.activity) selection.activity = config.activity.namespace;
  if (config.accessTokens) selection.access = true;
  if (config.socketForwarding) selection.socketForwarding = true;
  if (config.subjectAdmin) selection.ownerPolicy = config.subjectAdmin.ownerPolicy;
  selection.identities = [config.connectionString, config.readinessConnectionString, config.subjectAdmin?.connectionString, config.activity?.connectionString, config.tenantSettings?.connectionString].filter(value => typeof value === 'string').map(connectionIdentity);
  if (config.selectedIntake) selection.intake = config.selectedIntake.profile;
  return crypto.createHash('sha256').update(JSON.stringify(stable({ version: VERSION, sourceGeneration: sourceGeneration(), role, selection, catalogues }))).digest('hex');
}
const identitySQL = `SELECT d.oid::text AS database_oid, current_database() AS database_name,
  pg_postmaster_start_time()::text AS database_birth, r.oid::text AS role_oid, current_user AS role_name,
  r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication
  FROM pg_database d CROSS JOIN pg_roles r WHERE d.datname=current_database() AND r.rolname=current_user`;
function safeIdentity (row) {
  if (!row || ['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication'].some(key => row[key] !== false)) throw failure('PLATFORM_SERVING_IDENTITY_UNSAFE');
  return row;
}
async function withClient (connectionString, run) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 6000, application_name: 'nightscout-platform-verification' });
  try { await client.connect(); return await run(client); } finally { await client.end().catch(() => {}); }
}
async function admit (config, role) {
  const selection = selected(config.platformVerification, role);
  if (!selection) return;
  const expected = contract(config, role), started = monotonic();
  return withClient(config.connectionString, async client => {
    const identity = safeIdentity((await client.query(identitySQL)).rows[0]);
    const rows = (await client.query('SELECT r.status,r.contract_digest,r.database_oid,r.database_name,r.database_birth,r.role_oid,r.role_name,r.expires_at > clock_timestamp() AND r.epoch=c.epoch AS current,EXTRACT(EPOCH FROM (r.expires_at-clock_timestamp()))*1000 AS validity_ms FROM ' + quote(selection.namespace) + '.verified_role r CROSS JOIN ' + quote(selection.namespace) + '.verification_control c WHERE r.role=$1 AND c.singleton', [role])).rows;
    const row = rows[0];
    if (rows.length !== 1 || row.status !== 'verified' || row.current !== true || row.contract_digest !== expected || ['database_oid', 'database_name', 'database_birth', 'role_oid', 'role_name'].some(key => row[key] !== identity[key])) throw failure('PLATFORM_VERIFICATION_REQUIRED');
    const validityMs = Math.floor(Number(row.validity_ms) - (monotonic() - started));
    if (!Number.isFinite(validityMs) || validityMs <= 0) throw failure('PLATFORM_VERIFICATION_REQUIRED');
    return Object.freeze({ role, generation: expected, validityMs });
  }).catch(error => { if (error.code === 'PLATFORM_SERVING_IDENTITY_UNSAFE') throw error; throw failure('PLATFORM_VERIFICATION_REQUIRED'); });
}
async function guard (config, role, { intervalMs = 5000, now = monotonic, read = admit } = {}) {
  if (!config.platformVerification) return Object.freeze({ ready: () => true, health: () => ({ ready: true }), verify: async () => {}, close: async () => {} });
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000) throw failure('PLATFORM_VERIFICATION_INTERVAL');
  if (typeof now !== 'function' || typeof read !== 'function') throw failure('PLATFORM_VERIFICATION_CLOCK');
  let ready = false, code = 'PLATFORM_VERIFICATION_REQUIRED', pending, closed = false, expiresAt = -Infinity;
  const current = () => ready && !closed && now() < expiresAt;
  function verify () {
    if (closed) return Promise.reject(failure('PLATFORM_VERIFICATION_CLOSED'));
    const started = now();
    if (!pending) pending = read(config, role).then(result => { expiresAt = started + result.validityMs; ready = !closed && now() < expiresAt; code = ready ? null : 'PLATFORM_VERIFICATION_REQUIRED'; if (!ready) throw failure(code); }, error => { ready = false; code = 'PLATFORM_VERIFICATION_REQUIRED'; throw error; }).finally(() => { pending = null; });
    return pending;
  }
  await verify();
  const timer = setInterval(() => { verify().catch(() => {}); }, intervalMs); timer.unref?.();
  return Object.freeze({ ready: current, health: () => ({ ready: current(), code: current() ? null : code || 'PLATFORM_VERIFICATION_REQUIRED' }), verify,
    async close () { closed = true; ready = false; clearInterval(timer); await pending?.catch(() => {}); } });
}
async function install (client, { namespace, writer, readers }) {
  if (!validName(namespace) || typeof writer !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(writer) || !Array.isArray(readers) || !readers.length || readers.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(name)) || readers.includes(writer)) throw failure('PLATFORM_VERIFICATION_INSTALL');
  await client.query('CREATE SCHEMA ' + quote(namespace));
  await client.query('REVOKE ALL ON SCHEMA ' + quote(namespace) + ' FROM PUBLIC');
  await client.query('CREATE TABLE ' + quote(namespace) + `.verified_role (role text PRIMARY KEY CHECK(role IN ('api','evaluator','realtime')), status text NOT NULL CHECK(status IN ('verifying','verified','revoked')), contract_digest text NOT NULL, database_oid text NOT NULL, database_name text NOT NULL, database_birth text NOT NULL, role_oid text NOT NULL, role_name text NOT NULL, verified_at timestamptz, expires_at timestamptz, epoch bigint NOT NULL)`);
  await client.query('REVOKE ALL ON ' + quote(namespace) + '.verified_role FROM PUBLIC');
  await client.query('CREATE TABLE ' + quote(namespace) + ".verification_control (singleton boolean PRIMARY KEY CHECK(singleton), epoch bigint NOT NULL CHECK(epoch>0), operation_status text NOT NULL CHECK(operation_status IN ('IDLE','RUNNING','FAILED')), operation_id text, last_error text, last_diagnostic jsonb, automatic_enabled boolean NOT NULL DEFAULT false)");
  await client.query('INSERT INTO ' + quote(namespace) + ".verification_control VALUES (true,1,'IDLE',NULL,NULL,NULL,false)");
  await client.query('REVOKE ALL ON ' + quote(namespace) + '.verification_control FROM PUBLIC');
  await client.query('GRANT USAGE ON SCHEMA ' + quote(namespace) + ' TO ' + [writer, ...readers].map(quote).join(','));
  await client.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ' + quote(namespace) + '.verified_role TO ' + quote(writer));
  await client.query('GRANT SELECT,UPDATE ON ' + quote(namespace) + '.verification_control TO ' + quote(writer));
  await client.query('GRANT SELECT ON ' + quote(namespace) + '.verified_role,' + quote(namespace) + '.verification_control TO ' + readers.map(quote).join(','));
}
function create ({ namespace, connectionString, targets, maxAgeMs = 300000, refreshMs = 0 }) {
  if (!validName(namespace) || typeof connectionString !== 'string' || !Array.isArray(targets) || !targets.length || targets.length > 3 || new Set(targets.map(row => row.role)).size !== targets.length || targets.some(row => !ROLES.includes(row.role) || typeof row.check !== 'function')) throw failure('PLATFORM_VERIFICATION_CONFIG');
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1000 || maxAgeMs > 3600000) throw failure('PLATFORM_VERIFICATION_VALIDITY');
  if (!Number.isSafeInteger(refreshMs) || refreshMs < 0 || refreshMs !== 0 && (refreshMs < 1000 || refreshMs >= maxAgeMs)) throw failure('PLATFORM_VERIFICATION_REFRESH');
  let closed = false, timer, automaticEpoch = null;
  const running = new Set();
  function pauseAutomatic () { clearTimeout(timer); timer = null; automaticEpoch = null; }
  function track (pending) { running.add(pending); return pending.finally(() => running.delete(pending)); }
  function arm () {
    if (closed || !refreshMs || timer || automaticEpoch === null) return;
    const expectedEpoch = automaticEpoch;
    timer = setTimeout(() => {
      timer = null;
      const pending = track(runVerification({ automatic: true, expectedEpoch }));
      pending.catch(() => {}).finally(() => { if (automaticEpoch === expectedEpoch) arm(); });
    }, refreshMs); timer.unref?.();
  }
  async function inspect () {
    if (closed) throw failure('PLATFORM_VERIFICATION_CLOSED');
    return withClient(connectionString, async client => ({ version: 1, operation: (await client.query('SELECT operation_status AS status,last_error AS code,last_diagnostic AS diagnostic,automatic_enabled AS "automaticEnabled" FROM ' + quote(namespace) + '.verification_control WHERE singleton')).rows[0], roles: (await client.query('SELECT role,status,contract_digest AS generation,verified_at AS "verifiedAt",expires_at AS "expiresAt" FROM ' + quote(namespace) + '.verified_role ORDER BY role')).rows }));
  }
  async function runVerification ({ automatic = false, expectedEpoch } = {}) {
    if (closed) throw failure('PLATFORM_VERIFICATION_CLOSED');
    return withClient(connectionString, async client => {
      const acquired = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [VERSION + ':' + namespace])).rows[0].locked;
      if (!acquired) throw failure('PLATFORM_VERIFICATION_IN_PROGRESS');
      let targetRole = null, checkPhase = 'CONTROL';
      try {
        const database = (await client.query(identitySQL)).rows[0];
        // A timer may use only the epoch armed by this process's successful
        // explicit POST. DELETE disables it durably before platform mutation.
        const operationId = crypto.randomUUID();
        const control = (await client.query('UPDATE ' + quote(namespace) + ".verification_control SET operation_status='RUNNING',operation_id=$1,last_error=NULL,last_diagnostic=NULL WHERE singleton" +
          (automatic ? ' AND automatic_enabled AND epoch=$2' : '') + ' RETURNING epoch', automatic ? [operationId, expectedEpoch] : [operationId])).rows[0];
        if (!control) {
          if (automatic) { if (automaticEpoch === expectedEpoch) pauseAutomatic(); return { version: 1, namespace, status: 'paused' }; }
          throw failure('PLATFORM_VERIFICATION_CONTROL');
        }
        for (const target of targets) if (target.prepare) { targetRole = target.role; checkPhase = 'LOAD_TARGET'; await target.prepare(); }
        const records = [];
        for (const target of targets) {
          if (closed) throw failure('PLATFORM_VERIFICATION_CLOSED');
          targetRole = target.role; checkPhase = 'TARGET_CHECK';
          await target.check();
          checkPhase = 'DATABASE_IDENTITY';
          const identity = await withClient(target.config.connectionString, async own => safeIdentity((await own.query(identitySQL)).rows[0]));
          if (['database_oid', 'database_name', 'database_birth'].some(key => identity[key] !== database[key])) throw failure('PLATFORM_VERIFICATION_DATABASE_MISMATCH');
          records.push({ role: target.role, digest: contract(target.config, target.role), identity });
        }
        targetRole = null; checkPhase = 'PUBLISH_CERTIFICATE';
        await client.query('BEGIN');
        try {
          const current = (await client.query('SELECT epoch,operation_id,automatic_enabled FROM ' + quote(namespace) + '.verification_control WHERE singleton FOR UPDATE')).rows[0];
          if (!current || current.epoch !== control.epoch || current.operation_id !== operationId || automatic && (!current.automatic_enabled || current.epoch !== expectedEpoch)) throw failure('PLATFORM_VERIFICATION_INVALIDATED');
          for (const row of records) {
            const i = row.identity;
            const stored = await client.query('INSERT INTO ' + quote(namespace) + `.verified_role (role,status,contract_digest,database_oid,database_name,database_birth,role_oid,role_name,verified_at,expires_at,epoch) VALUES ($1,'verified',$2,$3,$4,$5,$6,$7,clock_timestamp(),clock_timestamp()+($8::integer * interval '1 millisecond'),$9) ON CONFLICT(role) DO UPDATE SET status=EXCLUDED.status,contract_digest=EXCLUDED.contract_digest,database_oid=EXCLUDED.database_oid,database_name=EXCLUDED.database_name,database_birth=EXCLUDED.database_birth,role_oid=EXCLUDED.role_oid,role_name=EXCLUDED.role_name,verified_at=EXCLUDED.verified_at,expires_at=EXCLUDED.expires_at,epoch=EXCLUDED.epoch RETURNING expires_at`, [row.role, row.digest, i.database_oid, i.database_name, i.database_birth, i.role_oid, i.role_name, maxAgeMs, control.epoch]);
            row.expiresAt = stored.rows[0].expires_at.toISOString();
          }
          await client.query('UPDATE ' + quote(namespace) + ".verification_control SET operation_status='IDLE',last_error=NULL,last_diagnostic=NULL" + (automatic ? '' : ',automatic_enabled=true') + ' WHERE singleton');
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
        if (!automatic) { pauseAutomatic(); automaticEpoch = control.epoch; arm(); }
        return { version: 1, namespace, status: 'verified', validityMs: maxAgeMs, refreshMs, roles: records.map(row => ({ role: row.role, generation: row.digest, expiresAt: row.expiresAt })) };
      } catch (error) {
        if (automatic && error.code === 'PLATFORM_VERIFICATION_INVALIDATED' && automaticEpoch === expectedEpoch) pauseAutomatic();
        const diagnostic = diagnostics.classify(error, targetRole, checkPhase);
        await client.query('UPDATE ' + quote(namespace) + ".verified_role SET status='revoked',verified_at=NULL,expires_at=NULL").catch(() => {});
        await client.query('UPDATE ' + quote(namespace) + ".verification_control SET operation_status='FAILED',last_error='PLATFORM_VERIFICATION_FAILED',last_diagnostic=$1::jsonb WHERE singleton", [JSON.stringify(diagnostic)]).catch(() => {});
        throw Object.assign(failure('PLATFORM_VERIFICATION_FAILED'), { verificationDiagnostic: diagnostic });
      }
      finally { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [VERSION + ':' + namespace]).catch(() => {}); }
    });
  }
  async function invalidate () {
    if (closed) throw failure('PLATFORM_VERIFICATION_CLOSED');
    pauseAutomatic();
    return track(withClient(connectionString, async client => {
      await client.query('BEGIN');
      try {
        await client.query('UPDATE ' + quote(namespace) + ".verification_control SET epoch=epoch+1,automatic_enabled=false,operation_status='IDLE',operation_id=NULL,last_error=NULL,last_diagnostic=NULL WHERE singleton");
        await client.query('UPDATE ' + quote(namespace) + ".verified_role SET status='revoked',verified_at=NULL,expires_at=NULL");
        await client.query('COMMIT'); return { version: 1, namespace, status: 'revoked' };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    }));
  }
  function verify () { return track(runVerification()); }
  return Object.freeze({ verify, inspect, invalidate, async close () { closed = true; pauseAutomatic(); await Promise.allSettled([...running]); } });
}
module.exports = { VERSION, ROLES, selected, contract, admit, guard, install, create, identitySQL };
