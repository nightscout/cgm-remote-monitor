'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool } = require('pg');
const connectionAdmission = require('./connection-admission');
const settingsProtocol = require('./postgres-settings-protocol');
const PostgresCleanupError = require('./postgres-cleanup-error');
const tenantScope = require('./tenant-scope');
const operationWindows = require('../tenant-lifecycle/operation-window');
let requiredWindow = null;
const liveConnections = new Set();

const { SQL: DATASTORE_SQL, identity: datastoreIdentity } = require('./postgres-datastore');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCAN_CHUNK = 500;

// Local deadlines must not be overridden by connection-string query fields.
// Match the pinned pg-connection-string query-key normalization without loading
// TLS files, changing ordinary URL options or attesting a direct connection.
function rejectLocalTimeoutOverrides (options) {
  if (options.query_timeout === undefined && options.connectionTimeoutMillis === undefined) return;
  let text = options.connectionString;
  // The driver's leading-slash socket form has no URL query configuration.
  if (text.charAt(0) === '/') return;
  if (/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(text)) text = encodeURI(text).replace(/%25(\d\d)/g, '%$1');
  let url;
  try { url = new URL(text, 'postgres://base'); }
  catch {
    try { url = new URL(text.replace('@/', '@___DUMMY___/'), 'postgres://base'); }
    catch { return; } // Preserve the driver's existing malformed-URL failure.
  }
  if ([...url.searchParams.keys()].some(key => ['query_timeout', 'connectionTimeoutMillis', 'connect_timeout'].includes(key))) {
    throw Object.assign(new Error('PostgreSQL URL cannot override explicit local timeouts'), { code: 'POSTGRES_LOCAL_TIMEOUT_OVERRIDE' });
  }
}

// Transaction foundation only: not registered as an available storage backend.
module.exports = async function postgresConnection (options) {
  if (!options || typeof options.connectionString !== 'string' || !options.connectionString.trim()) {
    throw new TypeError('PostgreSQL hosted connections require an explicit connectionString');
  }
  const requestedWindow = options.operationWindow;
  // Preserve credentials and explicit driver options, including non-enumerable
  // password descriptors. URL parsing must not let connectionString override
  // the explicit direct endpoint/SSL/PG-default configuration afterwards.
  const descriptors = Object.getOwnPropertyDescriptors(options);
  delete descriptors.operationWindow; delete descriptors.direct; delete descriptors.displaySettings;
  if (options.direct !== undefined && options.direct !== true) throw new TypeError('Explicit direct connection required');
  if (options.direct === true) {
    delete descriptors.connectionString;
    const normalized = require('../migrations/postgres-check').connectionOptions(options.connectionString);
    for (const [key, value] of Object.entries(normalized)) {
      if (key === 'ssl' && descriptors.ssl) continue;
      descriptors[key] = { value, enumerable: key !== 'password', configurable: true, writable: true };
    }
  }
  rejectLocalTimeoutOverrides(options);
  if (options.displaySettings === true) {
    if (options.direct !== true || options.application_name !== 'nightscout-display-settings' ||
        options.Client !== undefined || options.connection !== undefined || options.stream !== undefined) {
      throw new TypeError('Source-owned direct display settings pool required');
    }
    // Selected admission supplies its own tracked subclass of this fixed
    // driver. Its constructor deliberately refuses any options.Client field.
    if (connectionAdmission.health() === null) descriptors.Client = { value: settingsProtocol.Client, enumerable: true, configurable: true, writable: true };
  }
  const poolOptions = Object.create(Object.getPrototypeOf(options), descriptors);
  if (requiredWindow && requestedWindow !== undefined && requestedWindow !== requiredWindow.window) {
    throw new TypeError('A selected operation window cannot be replaced by a connection');
  }
  const operationWindow = requiredWindow ? requiredWindow.window : requestedWindow;
  if (operationWindow !== undefined && [operationWindow.acquireClient, operationWindow.assertClient].some(fn => typeof fn !== 'function')) {
    throw new TypeError('PostgreSQL operation window requires physical lease and current admission');
  }
  const pool = new (connectionAdmission.wrapPool(Pool, options.displaySettings === true ? settingsProtocol.Client : require('pg').Client, poolOptions.application_name))(
    connectionAdmission.poolOptions(poolOptions.application_name, poolOptions));
  require('../diagnostics/m7').observePool(pool, 'storage');
  let admitted, refused;
  const initialization = new Promise((resolve, reject) => { admitted = resolve; refused = reject; });
  // The constructor's caller observes admission failure; a simultaneous private
  // lifecycle snapshot also observes it. Keep the shared rejection handled when
  // no snapshot exists, without converting it to successful admission.
  initialization.catch(() => {});
  const heldOwners = new Map();
  const record = { window: operationWindow, backends: new Map(), datastore: null, closed: false, initialization, initialized: false };
  liveConnections.add(record);
  pool.on('remove', client => record.backends.delete(client.processID));
  function backendIdentity (client, row) {
    if (!row || !Number.isSafeInteger(row.pid) || row.pid < 1 || row.pid !== client.processID ||
        typeof row.role !== 'string' || !row.role || typeof row.birth !== 'string' || !row.birth) {
      const error = new Error('PostgreSQL direct backend identity required for selected operation window');
      error.code = 'POSTGRES_COHORT_BACKEND_IDENTITY';
      throw error;
    }
    const datastore = datastoreIdentity(row);
    if (record.datastore && JSON.stringify(record.datastore) !== JSON.stringify(datastore)) {
      // Decision datastore-loss-recover-in-place: the operation window is the one
      // place a restarted datastore is re-admitted (operation-window.js recover).
      // This pool follows it and never adopts a datastore on its own; the
      // backends it observed on the previous postmaster no longer exist.
      if (!operationWindow || JSON.stringify(operationWindow.datastore) !== JSON.stringify(datastore)) {
        throw Object.assign(new Error('PostgreSQL cohort datastore changed'), { code: 'POSTGRES_COHORT_DATASTORE_CHANGED' });
      }
      record.backends.clear();
    }
    record.datastore = datastore;
    return Object.freeze({ pid: row.pid, role: row.role, birth: row.birth });
  }
  // Decision admission-epoch-everywhere: a pooled client is one backend for its
  // life, so its identity is read once per client and again whenever the client's
  // backend pid differs (a reconnect is a new client and a new backend).
  const observed = new WeakMap();
  async function observeBackend (client, fresh = false) {
    if (!operationWindow && !fresh) return;
    if (!fresh && observed.get(client) === client.processID && record.backends.has(client.processID)) return;
    const row = (await client.query("SELECT pg_backend_pid() AS pid,current_user AS role,extract(epoch from backend_start)::text AS birth," + DATASTORE_SQL + " FROM pg_stat_activity WHERE pid=pg_backend_pid()")).rows[0];
    const identity = backendIdentity(client, row);
    if (fresh && options.direct === true && (row.role !== poolOptions.user || row.database !== poolOptions.database)) {
      throw Object.assign(new Error('PostgreSQL direct snapshot identity changed'), { code: 'POSTGRES_SNAPSHOT_IDENTITY_CHANGED' });
    }
    const previous = record.backends.get(identity.pid);
    if (fresh && previous && (previous.role !== identity.role || previous.birth !== identity.birth)) {
      throw Object.assign(new Error('PostgreSQL snapshot backend changed'), { code: 'POSTGRES_SNAPSHOT_IDENTITY_CHANGED' });
    }
    record.backends.set(identity.pid, identity);
    observed.set(client, identity.pid);
  }
  async function startupRole () {
    const text = "SELECT rolsuper, rolbypassrls,pg_backend_pid() AS pid,current_user AS role,(SELECT extract(epoch from backend_start)::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS birth," + DATASTORE_SQL + " FROM pg_roles WHERE rolname = current_user";
    if (!operationWindow) return pool.query(text);
    // The first-reference cohort requires one physical PostgreSQL backend per
    // client. Do not adopt a transaction-pooler backend through its SQL label.
    const client = await pool.connect(); let failure;
    try {
      const result = await client.query(text), row = result.rows[0];
      const identity = backendIdentity(client, row);
      if (operationWindow.trustedWorker === true) await operationWindow.verifyClient(client);
      record.backends.set(identity.pid, identity);
      return result;
    } catch (error) { failure = error; throw error; }
    finally { client.release(failure); }
  }
  // One backend of this pool observed afresh (decision datastore-loss-recover-in-place):
  // after the window re-admitted the datastore, every pool of the cohort is
  // brought to it before the process reports itself able to serve again.
  record.reobserve = async function reobserve () {
    if (record.closed || !record.initialized || !operationWindow) return;
    if (transactions.getStore()) throw new Error('PostgreSQL cohort reobservation requires an idle transaction scope');
    const owners = [...heldOwners.values()];
    for (const owner of owners) await owner.reobserve();
    // Every actual backend is already checked out by an owned resource. Its
    // exact held backend was verified above; another checkout would deadlock a
    // max1 owner pool. Unheld/idle backends retain the ordinary checkout path.
    if (owners.length && pool.totalCount === owners.length && pool.idleCount === 0) return;
    const client = await pool.connect(); let failure;
    try { observed.delete(client); await observeBackend(client); if (operationWindow.trustedWorker === true) await operationWindow.verifyClient(client); }
    catch (error) { failure = error; throw error; }
    finally { client.release(failure); }
  };
  const transactions = new AsyncLocalStorage();
  let ending;
  pool.on('error', function idleConnectionError (error) {
    console.error('PostgreSQL idle connection error:', error.code || error.name);
  });

  try {
    const result = await startupRole();
    const role = result.rows[0];
    if (!role || role.rolsuper || role.rolbypassrls) {
      throw new Error('PostgreSQL application connections require NOSUPERUSER NOBYPASSRLS');
    }
    record.initialized = true; admitted();
  } catch (error) {
    refused(error);
    try {
      await pool.end();
      record.closed = true; liveConnections.delete(record);
    } catch (cleanupError) { throw new PostgresCleanupError(error, cleanupError); }
    throw error;
  }

  function tenantId () {
    const tenant = tenantScope.requireTenant('postgres transaction');
    if (typeof tenant !== 'string' || !UUID.test(tenant)) {
      throw new TypeError('PostgreSQL hosted transactions require a UUID tenant binding');
    }
    return tenant;
  }

  function activeTransaction (tenant) {
    const transaction = transactions.getStore();
    if (transaction && (!transaction.active || transaction.tenant !== tenant)) {
      throw new Error('PostgreSQL transaction scope is closed or belongs to another tenant');
    }
    return transaction;
  }

  // Reuse the private scheduler's assertion only: its token identifies the
  // inherited parent, grants no authority and never leaves this component.
  function settingsParent (tenant) {
    if (!operationWindow) { operationWindows.assertNoAmbientScope(); return null; }
    return operationWindows.schedulingParent(operationWindow, tenant);
  }
  function assertSettingsParent (tenant, expected) {
    if (settingsParent(tenant) !== expected) throw Object.assign(new Error('PostgreSQL settings parent changed'), { code: 'POSTGRES_SETTINGS_PARENT_CHANGED' });
  }

  function assertUsable (transaction) {
    if (!transaction.active) throw new Error('PostgreSQL transaction scope is closed');
    if (transaction.connectionError) throw transaction.connectionError;
    if (transaction.snapshotFailure) throw transaction.snapshotFailure;
    if (transaction.strictReadOnly) assertSettingsParent(transaction.tenant, transaction.settingsParent);
  }

  async function queryInTransaction (transaction, text, values) {
    assertUsable(transaction);
    const result = await transaction.client.query(text, values);
    // A socket event can arrive while a caller awaits something other than a
    // query, or alongside a query result. A known dead client cannot succeed.
    assertUsable(transaction);
    return result;
  }

  async function run (tenant, fn, begin = 'BEGIN', settingsContext, heldClient) {
    const strictReadOnly = settingsContext !== undefined;
    const outer = activeTransaction(tenant);
    if (outer) { assertUsable(outer); return fn(); }
    if (strictReadOnly) assertSettingsParent(tenant, settingsContext.parent);
    const client = heldClient || await pool.connect();
    const transaction = { client, tenant, active: true, strictReadOnly, settingsParent: settingsContext?.parent };
    // The pool removes its idle error listener while this client is checked
    // out. pg rejects active queries on transport failure, but also emits a
    // separate client error; bridge that event into this transaction's failure.
    const connectionFailed = error => {
      if (!transaction.connectionError) transaction.connectionError = error;
    };
    client.on('error', connectionFailed);
    let releaseError, windowLease, outcome, primary, windowReleaseError, clientReleaseError;
    try {
      assertUsable(transaction);
      await observeBackend(client, strictReadOnly);
      assertUsable(transaction);
      if (operationWindow) windowLease = await operationWindow.acquireClient(client, tenant);
      assertUsable(transaction);
      try {
        const metadata = operationWindow && typeof operationWindow.isMetadataTenant === 'function' && operationWindow.isMetadataTenant(tenant) === true;
        await queryInTransaction(transaction, metadata && !strictReadOnly ? begin + ' READ ONLY' : begin);
        await queryInTransaction(transaction, "SELECT set_config('app.current_tenant_id', $1, true)", [tenant]);
        if (operationWindow) await operationWindow.assertClient(client, tenant, windowLease);
        assertUsable(transaction);
        outcome = await transactions.run(transaction, fn);
        assertUsable(transaction);
        if (strictReadOnly) { settingsProtocol.assertTransaction(client); connectionAdmission.assertDisplaySettingsTransaction(client); }
        const committed = await queryInTransaction(transaction, 'COMMIT');
        if (committed.command !== 'COMMIT') {
          throw new Error('PostgreSQL transaction was aborted; no changes were committed');
        }
      } catch (error) {
        try {
          if (strictReadOnly) settingsProtocol.assertRollback(client);
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          releaseError = rollbackError;
          const failure = new Error('PostgreSQL operation and rollback failed');
          failure.cause = error;
          failure.rollbackError = rollbackError;
          if (transaction.connectionError) failure.connectionError = transaction.connectionError;
          throw failure;
        }
        throw error;
      }
    } catch (error) {
      primary = strictReadOnly && error.rollbackError ? new PostgresCleanupError(error.cause || error, error.rollbackError) : error;
      if (strictReadOnly) releaseError = releaseError || error;
    }
    finally {
      transaction.active = false;
      // Release reattaches the pool's idle listener synchronously. A failed
      // window unlock evicts the backend, and is reported after cleanup.
      try {
        try { if (windowLease) { if (strictReadOnly) settingsProtocol.assertUnlock(client); await windowLease.close(); } }
        catch (error) { windowReleaseError = error; }
        if (strictReadOnly) {
          try { assertSettingsParent(tenant, transaction.settingsParent); }
          catch (error) { primary = primary || error; releaseError = releaseError || error; }
        }
        try { if (!heldClient) client.release(releaseError || transaction.connectionError || windowReleaseError); }
        catch (error) {
          clientReleaseError = error;
        }
      } finally { client.removeListener('error', connectionFailed); }
    }
    if (clientReleaseError) {
      if (strictReadOnly) throw new PostgresCleanupError(primary || windowReleaseError || clientReleaseError,
        windowReleaseError ? new PostgresCleanupError(windowReleaseError, clientReleaseError) : clientReleaseError);
      throw clientReleaseError;
    }
    if (windowReleaseError) {
      if (strictReadOnly) throw new PostgresCleanupError(primary || windowReleaseError, windowReleaseError);
      const failure = new Error('PostgreSQL operation window release failed', { cause: primary || windowReleaseError });
      failure.windowReleaseError = windowReleaseError;
      throw failure;
    }
    if (primary) throw primary;
    return outcome;
  }

  return {
    withTenant (tenant, fn) {
      return tenantScope.withTenant(tenant, () => run(tenantId(), fn));
    }
    , query (text, values) {
      const tenant = tenantId();
      const transaction = activeTransaction(tenant);
      if (transaction) return queryInTransaction(transaction, text, values);
      return run(tenant, () => queryInTransaction(transactions.getStore(), text, values));
    }
    , withSavepoint (fn) {
      return run(tenantId(), async function () {
        const transaction = transactions.getStore();
        if (transaction.savepointActive) {
          throw new Error('PostgreSQL concurrent or nested savepoint operations are unsupported');
        }
        transaction.savepointActive = true;
        // Names belong to this physical transaction, not an operation UUID.
        // Recycle only a confirmed removed savepoint. An uncertain cleanup
        // keeps its slot reserved until the entire transaction ends.
        const slots = transaction.savepointSlots || (transaction.savepointSlots = { next: 0, free: [] });
        const slot = slots.free.length ? slots.free.pop() : slots.next++;
        const name = 'ns_owned_sp_' + slot;
        let removed = false;
        try {
          await queryInTransaction(transaction, 'SAVEPOINT ' + name);
          try {
            const result = await fn();
            await queryInTransaction(transaction, 'RELEASE SAVEPOINT ' + name);
            removed = true;
            return result;
          } catch (error) {
            try {
              await queryInTransaction(transaction, 'ROLLBACK TO SAVEPOINT ' + name);
              await queryInTransaction(transaction, 'RELEASE SAVEPOINT ' + name);
              removed = true;
            } catch (rollbackError) {
              const failure = new Error('PostgreSQL operation and savepoint rollback failed', { cause: error });
              failure.rollbackError = rollbackError;
              throw failure;
            }
            throw error;
          }
        } finally {
          if (removed) slots.free.push(slot);
          transaction.savepointActive = false;
        }
      });
    }
    , transaction (fn) {
      const tenant = tenantId();
      if (activeTransaction(tenant)) throw new Error('PostgreSQL commit boundary requires a new transaction');
      return run(tenant, fn);
    }
    // Explicit stronger snapshot capability for dormant durable consumers.
    // Never pretend an already-open READ COMMITTED transaction is upgraded.
    // Bookkeeping writes may commit in this snapshot; it is not READ ONLY.
    , snapshotTransaction (fn) {
      const tenant = tenantId();
      if (activeTransaction(tenant)) throw new Error('PostgreSQL snapshot requires a new transaction');
      return run(tenant, fn, 'BEGIN ISOLATION LEVEL REPEATABLE READ');
    }
    // Settings-owned operation: a new physical checkout, never an upgrade of
    // an ambient transaction. READ ONLY is enforced by PostgreSQL, not the SQL
    // grammar below. The facade cannot end/commit/release the borrowed client.
    , readOnlySnapshot (tenant, fn) {
      if (options.displaySettings !== true) throw new Error('Source-owned display settings snapshot required');
      return tenantScope.withTenant(tenant, () => {
        const bound = tenantId();
        if (activeTransaction(bound)) throw new Error('PostgreSQL read-only snapshot requires a new transaction');
        const parent = settingsParent(bound);
        return run(bound, async () => {
          const transaction = transactions.getStore(), pending = new Set();
          const state = (await queryInTransaction(transaction, "SELECT current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation")).rows[0];
          if (state?.read_only !== 'on' || state?.isolation !== 'repeatable read') {
            throw new Error('PostgreSQL read-only repeatable snapshot required');
          }
          settingsProtocol.assertTransaction(transaction.client);
          connectionAdmission.assertDisplaySettingsTransaction(transaction.client);
          let active = true, queryFailure;
          const issued = [];
          const refuse = error => {
            queryFailure = queryFailure || error;
            if (!active && transaction.active) transaction.snapshotFailure = transaction.snapshotFailure || error;
            const refusal = Promise.reject(error);
            refusal.catch(() => {});
            return refusal;
          };
          const query = (text, values) => {
            if (!active) return refuse(new Error('PostgreSQL read-only snapshot scope is closed'));
            if (queryFailure) return refuse(queryFailure);
            try {
              if (typeof text !== 'string' || !/^SELECT\s/.test(text) || /;/.test(text)) throw new TypeError('PostgreSQL snapshot query requires one SELECT');
              settingsProtocol.assertTransaction(transaction.client);
              connectionAdmission.assertDisplaySettingsTransaction(transaction.client);
            } catch (error) { return refuse(error); }
            const work = queryInTransaction(transaction, text, values);
            pending.add(work);
            const issuedQuery = { observed: false }; issued.push(issuedQuery);
            work.then(() => pending.delete(work), error => { pending.delete(work); queryFailure = queryFailure || error; });
            return Object.freeze({ then (resolve, reject) { issuedQuery.observed = true; return work.then(resolve, reject); } });
          };
          let outcome, primary;
          try { outcome = await fn(Object.freeze({ query })); }
          catch (error) { primary = error; }
          active = false;
          const unfinished = [...pending];
          const results = await Promise.allSettled(unfinished);
          if (primary) throw primary;
          assertUsable(transaction);
          if (queryFailure) throw queryFailure;
          if (unfinished.length || issued.some(query => !query.observed)) {
            const error = new Error('PostgreSQL read-only snapshot has unawaited queries');
            error.queryErrors = results.filter(row => row.status === 'rejected').map(row => row.reason);
            throw error;
          }
          return outcome;
        }, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', { parent });
      });
    }
    // One READ ONLY statement with no tenant bound (app.current_tenant_id is
    // unset, so tenant RLS returns nothing). For catalogue reads and narrow
    // SECURITY DEFINER hint functions; no operation-window lease, nothing served.
    , async readOnly (text, values) {
      if (typeof text !== 'string' || !/^SELECT\s/.test(text) || /;/.test(text)) throw new TypeError('PostgreSQL read-only query requires one SELECT');
      if (transactions.getStore()) throw new Error('PostgreSQL read-only query cannot run inside a tenant transaction');
      const client = await pool.connect(); let failure;
      try {
        await observeBackend(client);
        await client.query('BEGIN READ ONLY');
        const result = await client.query(text, values);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        failure = error;
        // This transaction is READ ONLY and the failed client is evicted below.
        // A client deadline does not prove the server finished: never queue a
        // cleanup statement behind its unknown work or wait for that statement.
        throw error;
      } finally { client.release(failure); }
    }
    // Trusted receiver bookkeeping only. Fixed checkpoint SQL; it cannot write
    // clinical rows or publish effects. RLS grants restrict its consumer rows.
    // It deliberately does not acquire tenant serving/restore admission: a
    // paused tenant's durable receipt must not block the entire serial feed.
    , async observeEvaluator ({ table, consumer, tenant, source, version, enabled, contractDigest }) {
      const parts = typeof table === 'string' ? table.split('.') : [];
      if (parts.length !== 2 || parts[1] !== 'tenant_consumer_checkpoint' || !/^[a-z][a-z0-9_]{0,62}$/.test(parts[0]) ||
          ['public','information_schema'].includes(parts[0]) || parts[0].startsWith('pg_') || !UUID.test(tenant) ||
          typeof consumer !== 'string' || !/^evaluator-[A-Za-z0-9_-]{1,112}$/.test(consumer) ||
          !['clock','settings','activity','policy','lifecycle','bootstrap'].includes(source) ||
          typeof version !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(version) || BigInt(version) > 9223372036854775807n ||
          enabled !== undefined && typeof enabled !== 'boolean' || typeof contractDigest !== 'string' || !/^[a-f0-9]{64}$/.test(contractDigest) || transactions.getStore()) throw new TypeError('Explicit evaluator receipt required outside tenant work');
      const relation = '"' + parts[0] + '".tenant_consumer_checkpoint';
      const client = await pool.connect(); let failure;
      try {
        await observeBackend(client);
        await client.query('BEGIN');
        // Transfer only receipt metadata. Completed clinical output/due fields
        // stay in PostgreSQL and are preserved by the row-local JSONB patch.
        const rows = (await client.query(`SELECT CASE WHEN jsonb_typeof(projection->0)='object' THEN
          COALESCE((SELECT jsonb_object_agg(field.key,field.value) FROM jsonb_each(projection->0) AS field(key,value)
            WHERE field.key IN ('kind','observed','completed','observedAt','pendingAt','enabled','eligibility')), '{}'::jsonb)
          ELSE projection->0 END AS state,contract_digest FROM ${relation}
          WHERE tenant_id=$1 AND consumer=$2 FOR UPDATE`, [tenant,consumer])).rows;
        if (rows.length !== 1) throw new Error('EVALUATOR_RECEIPT_NOT_PROVISIONED');
        if(rows[0].contract_digest!==contractDigest)throw new Error('EVALUATOR_RECEIPT_CONTRACT');
        const initial = { kind:'evaluator-work-v1',observed:{},completed:{},pendingAt:null,enabled:true,output:null };
        const state = rows[0].state || { ...initial, observed:{}, completed:{} };
        if (state.kind !== 'evaluator-work-v1' || !state.observed || !state.completed) throw new Error('EVALUATOR_RECEIPT_CONTRACT');
        const previous = state.observed[source];
        if (previous === undefined || BigInt(version) > BigInt(previous)) {
          state.observed[source]=version;state.observedAt=state.observedAt||{};state.observedAt[source]=Date.now();
          if (state.pendingAt === null) state.pendingAt=Date.now();
          if (enabled !== undefined) { const wasEnabled=state.enabled;state.eligibility=state.eligibility||{};state.eligibility[source]=enabled;state.enabled=Object.values(state.eligibility).every(Boolean);if(state.enabled&&!wasEnabled)state.pendingAt=Date.now(); }
          const patch = Object.fromEntries(['observed','observedAt','pendingAt','enabled','eligibility']
            .filter(key => Object.hasOwn(state,key)).map(key => [key,state[key]]));
          const updated = await client.query(`UPDATE ${relation} SET projection=jsonb_build_array(
            (CASE WHEN jsonb_typeof(projection->0)='object' THEN projection->0 ELSE $4::jsonb END) || $3::jsonb)
            WHERE tenant_id=$1 AND consumer=$2`, [tenant,consumer,JSON.stringify(patch),JSON.stringify(initial)]);
          if (updated.rowCount !== 1) throw new Error('EVALUATOR_RECEIPT_NOT_PROVISIONED');
        }
        const committed = await client.query('COMMIT');
        if (committed.command !== 'COMMIT') throw new Error('EVALUATOR_RECEIPT_COMMIT_UNCONFIRMED');
        delete state.output; // Receipt callers receive metadata, never clinical output.
        return state;
      } catch (error) { failure=error;try { await client.query('ROLLBACK'); } catch { /* Evict the failed receipt connection. */ } throw error; }
      finally { client.release(failure); }
    }
    // Startup/rebootstrap receipt only: one bounded transaction per metadata
    // page. Lock and transfer bookkeeping fields, never completed clinical data.
    // The patch preserves completion/output/due and the checkpoint column.
    , async observeEvaluatorMany ({ table, consumer, observations, contractDigest }) {
      const parts = typeof table === 'string' ? table.split('.') : [];
      const sources = ['clock','settings','activity','policy','lifecycle','bootstrap'];
      const version = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
      const object = value => value && typeof value === 'object' && !Array.isArray(value);
      const maxRows = 64, maxBytes = 262144;
      if (parts.length !== 2 || parts[1] !== 'tenant_consumer_checkpoint' || !/^[a-z][a-z0-9_]{0,62}$/.test(parts[0]) ||
          ['public','information_schema'].includes(parts[0]) || parts[0].startsWith('pg_') ||
          typeof consumer !== 'string' || !/^evaluator-[A-Za-z0-9_-]{1,112}$/.test(consumer) ||
          typeof contractDigest !== 'string' || !/^[a-f0-9]{64}$/.test(contractDigest) || transactions.getStore()) throw new TypeError('Explicit evaluator receipt required outside tenant work');
      if (!Array.isArray(observations) || observations.length < 1 || observations.length > maxRows ||
          Buffer.byteLength(JSON.stringify(observations)) > maxBytes) throw new TypeError('EVALUATOR_RECEIPT_BATCH_BOUND');
      if (new Set(observations.map(row => row?.tenant?.toLowerCase?.())).size !== observations.length || observations.some(row =>
        !object(row) || !UUID.test(row.tenant) || Object.keys(row).some(key => !['tenant','observed','eligibility'].includes(key)) ||
        !object(row.observed) || !Object.keys(row.observed).length || Object.entries(row.observed).some(([key,value]) => !sources.includes(key) || !version(value)) ||
        row.eligibility !== undefined && (!object(row.eligibility) || Object.entries(row.eligibility).some(([key,value]) => !Object.hasOwn(row.observed,key) || typeof value !== 'boolean')))) throw new TypeError('Explicit evaluator receipt batch required');
      const relation = '"' + parts[0] + '".tenant_consumer_checkpoint';
      const initial = {kind:'evaluator-work-v1',observed:{},completed:{},pendingAt:null,enabled:true,output:null};
      const client = await pool.connect(); let failure;
      try {
        await observeBackend(client);
        await client.query('BEGIN');
        const result = (await client.query(`WITH locked AS MATERIALIZED (
          SELECT tenant_id,contract_digest,projection FROM ${relation}
          WHERE consumer=$1 AND tenant_id=ANY($2::uuid[]) ORDER BY tenant_id FOR UPDATE
        ), metadata AS (
          SELECT jsonb_build_object('tenant',tenant_id::text,'digest',contract_digest,'state',
            CASE WHEN projection IS NULL THEN NULL ELSE jsonb_build_object(
              'kind',projection->0->'kind','observed',projection->0->'observed','completed',projection->0->'completed',
              'observedAt',projection->0->'observedAt','pendingAt',projection->0->'pendingAt',
              'enabled',projection->0->'enabled','eligibility',projection->0->'eligibility') END) AS value FROM locked
        ) SELECT coalesce(sum(octet_length(value::text)),0)::integer AS bytes,
          CASE WHEN coalesce(sum(octet_length(value::text)),0)<=$3 THEN coalesce(jsonb_agg(value),'[]'::jsonb) ELSE NULL END AS rows
          FROM metadata`, [consumer,observations.map(row => row.tenant),maxBytes])).rows[0];
        if (!result || result.bytes > maxBytes || !Array.isArray(result.rows)) throw new Error('EVALUATOR_RECEIPT_BATCH_BOUND');
        if (result.rows.length !== observations.length) throw new Error('EVALUATOR_RECEIPT_NOT_PROVISIONED');
        const saved = new Map(result.rows.map(row => [row.tenant,row]));
        const patches = [], at = Date.now();
        for (const observation of observations) {
          const row = saved.get(observation.tenant.toLowerCase());
          if (!row) throw new Error('EVALUATOR_RECEIPT_NOT_PROVISIONED');
          if (row.digest !== contractDigest) throw new Error('EVALUATOR_RECEIPT_CONTRACT');
          const state = row.state || structuredClone(initial);
          if (state.kind !== initial.kind || !object(state.observed) || !object(state.completed)) throw new Error('EVALUATOR_RECEIPT_CONTRACT');
          let changed = false;
          for (const [source,value] of Object.entries(observation.observed)) {
            const previous = state.observed[source];
            if (previous !== undefined && !version(previous)) throw new Error('EVALUATOR_RECEIPT_CONTRACT');
            if (previous !== undefined && BigInt(value) <= BigInt(previous)) continue;
            changed = true; state.observed[source] = value;
            state.observedAt = state.observedAt || {}; state.observedAt[source] = at;
            if (state.pendingAt === null) state.pendingAt = at;
            if (observation.eligibility && Object.hasOwn(observation.eligibility,source)) {
              const wasEnabled = state.enabled;
              state.eligibility = state.eligibility || {}; state.eligibility[source] = observation.eligibility[source];
              state.enabled = Object.values(state.eligibility).every(Boolean);
              if (state.enabled && !wasEnabled) state.pendingAt = at;
            }
          }
          if (changed) patches.push({tenant:observation.tenant,patch:{observed:state.observed,observedAt:state.observedAt,
            pendingAt:state.pendingAt,enabled:state.enabled,...(state.eligibility ? {eligibility:state.eligibility} : {})}});
        }
        const encoded = JSON.stringify(patches);
        if (Buffer.byteLength(encoded) > maxBytes) throw new Error('EVALUATOR_RECEIPT_BATCH_BOUND');
        if (patches.length) {
          const updated = await client.query(`WITH patches AS (
            SELECT tenant::uuid AS tenant,patch FROM jsonb_to_recordset($2::jsonb) AS input(tenant text,patch jsonb)
          ) UPDATE ${relation} AS checkpoint SET projection=jsonb_build_array(coalesce(checkpoint.projection->0,$3::jsonb) || patches.patch)
            FROM patches WHERE checkpoint.consumer=$1 AND checkpoint.tenant_id=patches.tenant`, [consumer,encoded,JSON.stringify(initial)]);
          if (updated.rowCount !== patches.length) throw new Error('EVALUATOR_RECEIPT_NOT_PROVISIONED');
        }
        await client.query('COMMIT'); return {observed:observations.length,changed:patches.length};
      } catch (error) { failure = error; try { await client.query('ROLLBACK'); } catch { /* Evict the failed receipt connection. */ } throw error; }
      finally { client.release(failure); }
    }
    // One deployment heartbeat, independent of any tenant lifecycle.
    , async pulsePgstream (namespace, revision) {
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || !Number.isSafeInteger(revision) || revision < 1 || transactions.getStore()) throw new TypeError('Monotone pgstream heartbeat required');
      const client = await pool.connect(); let failure;
      try {
        await observeBackend(client);
        const row=(await client.query('UPDATE '+namespace+'.nightscout_heartbeat SET revision=$1 WHERE id=1 AND revision<$1 RETURNING revision::text',[revision])).rows[0];
        if(!row)throw new Error('PGSTREAM_HEARTBEAT_VERSION_REFUSED');
      } catch(error){failure=error;throw error;}finally{client.release(failure);}
    }
    // Change hints for many tenants in one round trip (D6: a wake is a hint,
    // the stamp read under the tenant's own binding is compared with what was
    // served). One READ ONLY transaction binds each tenant in turn through the
    // same RLS setting withTenant uses, then runs one fixed single-row
    // statement. It takes no operation-window lease, so nothing read here may
    // be served: callers only decide whether to run a windowed operation.
    , async scanTenants (tenants, text) {
      if (!Array.isArray(tenants) || tenants.some(tenant => typeof tenant !== 'string' || !UUID.test(tenant)) ||
          new Set(tenants).size !== tenants.length) throw new TypeError('PostgreSQL tenant scan requires distinct UUID tenants');
      if (typeof text !== 'string' || !/^SELECT\s/.test(text) || /[;\\$]/.test(text)) {
        throw new TypeError('PostgreSQL tenant scan requires one fixed parameterless SELECT');
      }
      if (transactions.getStore()) throw new Error('PostgreSQL tenant scan cannot run inside a tenant transaction');
      const found = new Map();
      for (let start = 0; start < tenants.length; start += SCAN_CHUNK) {
        const chunk = tenants.slice(start, start + SCAN_CHUNK);
        const client = await pool.connect(); let failure;
        try {
          await observeBackend(client);
          // Tenant ids are validated UUID literals; the statement is fixed.
          const statements = ['BEGIN READ ONLY'];
          for (const tenant of chunk) statements.push("SELECT set_config('app.current_tenant_id','" + tenant.toLowerCase() + "',true)", text);
          statements.push('COMMIT');
          const results = await client.query(statements.join(';'));
          if (!Array.isArray(results) || results.length !== statements.length || results.at(-1).command !== 'COMMIT') {
            throw new Error('PostgreSQL tenant scan was not committed');
          }
          chunk.forEach((tenant, index) => found.set(tenant, results[2 + index * 2].rows));
        } catch (error) {
          failure = error;
          try { await client.query('ROLLBACK'); } catch { /* the client is released as failed */ }
          throw error;
        } finally { client.release(failure); }
      }
      return found;
    }
    // A process-lifetime operational resource, observed by the same actual
    // backend census as tenant work. It does not acquire tenant authority or
    // fence an already buffered socket emission. Controlled owner replacement
    // still requires platform-confirmed termination of the old incarnation.
    , async holdAdvisoryLock (key, onLoss = () => {}) {
      if (typeof key !== 'string' || !/^-?[0-9]{1,19}$/.test(key) || BigInt(key) < -9223372036854775808n || BigInt(key) > 9223372036854775807n || typeof onLoss !== 'function') throw new TypeError('Explicit signed advisory key and loss callback required');
      const client = await pool.connect();
      let held = false, lost = false, released = false;
      const loss = () => {
        if (lost || released) return;
        lost = true;
        try { Promise.resolve(onLoss()).catch(() => {}); } catch { /* admission has already failed closed */ }
      };
      client.on('error', loss);
      try {
        await observeBackend(client);
        held = (await client.query('SELECT pg_try_advisory_lock($1::bigint) AS held', [key])).rows[0]?.held === true;
        if (!held || lost) throw Object.assign(new Error('POSTGRES_OPERATIONAL_OWNER_CONFLICT'), { code: 'POSTGRES_OPERATIONAL_OWNER_CONFLICT' });
      } catch (error) { client.removeListener('error', loss); client.release(error); throw error; }
      let ownerTransaction = null;
      const ownerPid = client.processID, ownerIdentity = record.backends.get(ownerPid);
      const ownerDatastore = JSON.stringify(record.datastore);
      const bits = BigInt.asUintN(64, BigInt(key)), high = (bits >> 32n).toString(), low = (bits & 4294967295n).toString();
      const assertOwned = () => {
        if (!held || lost || released || client.processID !== ownerPid) {
          loss(); throw Object.assign(new Error('POSTGRES_OPERATIONAL_OWNER_LOST'), {code:'POSTGRES_OPERATIONAL_OWNER_LOST'});
        }
      };
      const serial = fn => {
        try { assertOwned(); } catch (error) { return Promise.reject(error); }
        const previous = ownerTransaction || Promise.resolve();
        const next = previous.catch(() => {}).then(() => { assertOwned(); return fn(); });
        ownerTransaction = next;
        next.finally(() => { if (ownerTransaction === next) ownerTransaction = null; }).catch(() => {});
        return next;
      };
      const check = async () => {
        assertOwned();
        try {
          const row = (await client.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND classid=$1::oid AND objid=$2::oid AND objsubid=1 AND granted) AS held", [high, low])).rows[0];
          assertOwned();
          if (!row?.held) throw new Error('Owner resource unavailable');
        } catch { loss(); throw Object.assign(new Error('POSTGRES_OPERATIONAL_OWNER_LOST'), {code:'POSTGRES_OPERATIONAL_OWNER_LOST'}); }
      };
      heldOwners.set(client, { reobserve: () => serial(async () => {
        try {
          // This is the resource's original physical client, after its last
          // owner transaction has ended. Never borrow another backend's proof.
          await observeBackend(client, true);
          const identity = record.backends.get(ownerPid);
          if (!ownerIdentity || JSON.stringify(identity) !== JSON.stringify(ownerIdentity) ||
              JSON.stringify(record.datastore) !== ownerDatastore) throw new Error('POSTGRES_OPERATIONAL_OWNER_IDENTITY_CHANGED');
          if (operationWindow.trustedWorker === true) await operationWindow.verifyClient(client);
          await check();
        } catch (error) { loss(); throw error; }
      }) });
      return Object.freeze({
        get available () { return held && !lost && !released && client.processID === ownerPid; },
        // Completion and re-observation serialize on this SAME held backend.
        withTenant (tenant, fn) {
          return serial(() => tenantScope.withTenant(tenant, () => run(tenantId(), fn, 'BEGIN', undefined, client)));
        },
        check () {
          // Preserve an explicit check by a body already on this owner client.
          // External timers/checks serialize with completion and re-observation.
          return transactions.getStore()?.client === client ? check() : serial(check);
        },
        async close () {
          if (released) return; released = true;
          await ownerTransaction?.catch(() => {});
          let error;
          try { if (!lost) await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]); }
          catch (failure) { error = failure; }
          finally { held = false; heldOwners.delete(client); client.removeListener('error', loss); client.release(error || (lost ? new Error('Owner backend lost') : undefined)); }
        }
      });
    }
    , end () {
      if (record.closed) return Promise.resolve();
      if (!ending) ending = pool.end().then(() => {
        record.closed = true;
        liveConnections.delete(record);
      });
      // Failed drain stays in the cohort census and prevents registry release.
      return ending;
    }
  };
};


// A selected, privately composed role cohort must not let a helper create a
// bare lower port by forgetting an option. The owning boot coordinator keeps
// this release closure and may call it only after its contexts/pools drain.
// Only the explicitly selected, privately composed role cohort installs it.
module.exports.installOperationWindow = function installOperationWindow (window) {
  if (!operationWindows.isWindow(window)) throw new TypeError('An actual live operation window is required');
  if (requiredWindow) throw new Error('An operation window is already selected');
  if (liveConnections.size) throw new Error('Existing PostgreSQL connections prevent complete cohort selection');
  const binding = { window }; requiredWindow = binding; let released = false;
  return function releaseOwnedWindow () {
    if (released) return;
    if (requiredWindow !== binding) throw new Error('Operation window ownership changed');
    if ([...liveConnections].some(record => record.window === window && !record.closed)) {
      throw new Error('PostgreSQL cohort connections must drain before release');
    }
    requiredWindow = null; released = true;
  };
};

// Private coordinator census: immutable observed backend identities, never credentials.
module.exports.cohortBackends = function cohortBackends (window) {
  if (!requiredWindow || requiredWindow.window !== window || !operationWindows.isWindow(window)) throw new Error('PostgreSQL cohort is not selected');
  const rows = [];
  for (const record of liveConnections) {
    if (record.closed || record.window !== window) throw new Error('Unselected PostgreSQL cohort connection');
    rows.push(...record.backends.values());
  }
  return Object.freeze(rows.slice());
};

// Decision datastore-loss-recover-in-place: bring every live pool of the
// selected cohort to the datastore its window has re-admitted. A pool that
// cannot reach it, or reaches another one, rejects; the caller stays unavailable.
module.exports.readopt = async function readopt (window) {
  module.exports.cohortBackends(window);
  const records = [...liveConnections].filter(record => record.window === window && !record.closed);
  await Promise.all(records.map(record => record.reobserve()));
  return records.length;
};

module.exports.datastoreSQL = DATASTORE_SQL;
module.exports.datastoreIdentity = datastoreIdentity;
module.exports.cohortDatastore = function cohortDatastore (window) {
  module.exports.cohortBackends(window);
  const identities = [...liveConnections].filter(record => record.window === window && !record.closed).map(record => record.datastore);
  if (!identities.length || identities.some(value => !value || JSON.stringify(value) !== JSON.stringify(identities[0]))) throw new Error('PostgreSQL cohort datastore unavailable');
  return identities[0];
};

// Construction registers the actual resource before opening its backend. A
// lifecycle status takes one record-set cut, waits for ALL of that cut's role
// admissions, then captures its actual datastore/backend tuple synchronously.
// Later constructors do not extend this cut or starve healthy traffic; the
// independent SQL actor census still observes their physical backends.
module.exports.cohortSnapshot = async function cohortSnapshot (window, { timeoutMs = 1000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new TypeError('Bounded cohort snapshot deadline required');
  module.exports.cohortBackends(window); // Selection and closed-resource guards.
  const records = [...liveConnections].filter(record => record.window === window && !record.closed);
  let timer;
  try {
    // Node's timer budget is monotonic; wall-clock steps cannot extend it.
    await Promise.race([Promise.all(records.map(record => record.initialization)), new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('PostgreSQL cohort initialization timed out'), { code: 'POSTGRES_COHORT_INITIALIZATION_TIMEOUT' })), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
  module.exports.cohortBackends(window);
  const identities = records.map(record => record.datastore);
  if (!identities.length || identities.some(value => !value || JSON.stringify(value) !== JSON.stringify(identities[0]))) throw new Error('PostgreSQL cohort datastore unavailable');
  // A cut may include a pool that has since drained completely. It still must
  // have passed admission; its now-empty backend map claims no living actor.
  return Object.freeze({ datastore: identities[0], backends: Object.freeze(records.flatMap(record => [...record.backends.values()])) });
};
