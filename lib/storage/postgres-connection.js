'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool } = require('pg');
const settingsProtocol = require('./postgres-settings-protocol');
const PostgresCleanupError = require('./postgres-cleanup-error');
const tenantScope = require('./tenant-scope');
const operationWindows = require('../tenant-lifecycle/operation-window');
let requiredWindow = null;
const liveConnections = new Set();

const { SQL: DATASTORE_SQL, identity: datastoreIdentity } = require('./postgres-datastore');
const CURRENT_BACKEND_ACTIVITY = 'pg_catalog.pg_stat_get_activity(pg_catalog.pg_backend_pid())';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCAN_CHUNK = 500;
const READ_ONLY_SNAPSHOT = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
// A request's reads at current committed state, each statement its own
// snapshot. PostgreSQL refuses any write in it, so it needs no commit fence.
const READ_ONLY_COMMITTED = 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY';

// The pinned driver's local deadlines carry no code: query_timeout rejects the
// caller with 'Query read timeout' while the statement may still run on the
// server, and the pool rejects a checkout it could not serve in time.
function missedQueryDeadline (error) {
  return error instanceof Error && error.code === undefined && error.message === 'Query read timeout';
}
function missedCheckoutDeadline (error) {
  return error instanceof Error && error.code === undefined && error.message === 'timeout exceeded when trying to connect';
}
// A refusal the caller can retry: nothing was committed. Retry-After is in
// seconds (lib/server/tenant-app SERVICE_STATUS answers these with 503).
// `phase` says where it was produced (nightscout_storage_refusals_total):
// checkout (no pooled client), open (the transaction's opening statements),
// clock (a statement that takes or holds the tenant write clock row lock, so
// a timeout there is a wait on another writer of the same tenant), statement
// (any other statement).
function storageRefusal (code, message, cause, phase) {
  return Object.assign(new Error(message, { cause }), { code, retryAfter: 1, phase });
}
const CLOCK_ROW = /\.tenant_write_clock\b/;
const ROW_LOCK = /^\s*UPDATE\b|\bFOR\s+UPDATE\b/i;
// Read only on the refusal path, never per statement.
function statementPhase (transaction, text) {
  if (!transaction.body) return 'open';
  const sql = typeof text === 'string' ? text : text && typeof text.text === 'string' ? text.text : '';
  return CLOCK_ROW.test(sql) && ROW_LOCK.test(sql) ? 'clock' : 'statement';
}

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
  // Decision catalogue-verification-admin-owned: catalogue checks run once in
  // the admin pre-start step, never per backend on the serving path.
  if (options.admitBackend !== undefined) throw new TypeError('Per-backend admission was retired; the platform proof covers the catalogue');
  // Preserve credentials and explicit driver options, including non-enumerable
  // password descriptors. URL parsing must not let connectionString override
  // the explicit direct endpoint/SSL/PG-default configuration afterwards.
  const descriptors = Object.getOwnPropertyDescriptors(options);
  delete descriptors.operationWindow; delete descriptors.direct; delete descriptors.displaySettings; delete descriptors.readStatementPool;
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
    descriptors.Client = { value: settingsProtocol.Client, enumerable: true, configurable: true, writable: true };
  }
  const poolOptions = Object.create(Object.getPrototypeOf(options), descriptors);
  if (requiredWindow && requestedWindow !== undefined && requestedWindow !== requiredWindow.window) {
    throw new TypeError('A selected operation window cannot be replaced by a connection');
  }
  const operationWindow = requiredWindow ? requiredWindow.window : requestedWindow;
  if (operationWindow !== undefined && [operationWindow.acquireClient, operationWindow.assertClient].some(fn => typeof fn !== 'function')) {
    throw new TypeError('PostgreSQL operation window requires physical lease and current admission');
  }
  const pool = new Pool(poolOptions);
  // readStatement's pool (decision 2026-11-20): read-only backends, sized by
  // options.readStatementPool (NS_POOL_READ_MAX through pool-config, default
  // 2), created on the first read so a connection that never reads holds none.
  const readSettings = options.readStatementPool === undefined ? { max: 2 } : options.readStatementPool;
  if (!readSettings || !Number.isSafeInteger(readSettings.max) || readSettings.max < 1 || readSettings.max > 1000 ||
      Object.keys(readSettings).some(key => !['max', 'connectionTimeoutMillis'].includes(key))) throw new TypeError('Bounded read statement pool required');
  let readStatementPool = null;
  const readOnlyBackends = new WeakSet();
  function readPool () {
    if (readStatementPool) return readStatementPool;
    if (record.closed || ending) throw new Error('PostgreSQL connection is closed');
    const selected = { ...descriptors };
    delete selected.readStatementPool;
    const value = v => ({ value: v, enumerable: true, configurable: true, writable: true });
    selected.max = value(readSettings.max);
    if (readSettings.connectionTimeoutMillis !== undefined) selected.connectionTimeoutMillis = value(readSettings.connectionTimeoutMillis);
    const inherited = typeof poolOptions.options === 'string' && poolOptions.options.trim() ? poolOptions.options.trim() + ' ' : '';
    selected.options = value(inherited + '-c default_transaction_read_only=on');
    if (typeof poolOptions.application_name === 'string') selected.application_name = value((poolOptions.application_name + '-read').slice(0, 63));
    readStatementPool = new Pool(Object.create(Object.getPrototypeOf(options), selected));
    require('../diagnostics/m7').observePool(readStatementPool, 'storage');
    require('../metrics').observePool(readStatementPool, selected.application_name?.value);
    readStatementPool.on('remove', client => { record.backends.delete(client.processID); observed.delete(client); });
    readStatementPool.on('error', error => console.error('PostgreSQL idle read connection error:', error.code || error.name));
    return readStatementPool;
  }
  require('../diagnostics/m7').observePool(pool, 'storage');
  require('../metrics').observePool(pool, poolOptions.application_name);
  const heldOwners = new Map();
  const record = { window: operationWindow, backends: new Map(), datastore: null, closed: false };
  liveConnections.add(record);
  pool.on('remove', client => { record.backends.delete(client.processID); observed.delete(client); strictlyObserved.delete(client); });
  function backendIdentity (client, row) {
    if (!row || !Number.isSafeInteger(row.pid) || row.pid < 1 || row.pid !== client.processID ||
        typeof row.role !== 'string' || !row.role || typeof row.birth !== 'string' || !row.birth) {
      const error = new Error('PostgreSQL direct backend identity required for selected operation window');
      error.code = 'POSTGRES_COHORT_BACKEND_IDENTITY';
      throw error;
    }
    const datastore = datastoreIdentity(row);
    if (record.datastore && JSON.stringify(record.datastore) !== JSON.stringify(datastore)) {
      // Only a datastore re-admitted by the process recovery supervisor can
      // replace the previous incarnation. Drop observations from its old clients.
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
  const observed = new WeakMap(), watched = new WeakSet(), strictlyObserved = new WeakSet();
  function screenBackend (client) {
    if (!watched.has(client)) {
      const invalidate = () => { observed.delete(client); strictlyObserved.delete(client); };
      client.on('error', invalidate); client.on('end', invalidate); watched.add(client);
    }
    if (require('../tenant-lifecycle/generation-scope').isScope(operationWindow)) {
      if (!require('node:util').isDeepStrictEqual(operationWindow.datastore, record.datastore))
        throw Object.assign(new Error('Tenant generation datastore mismatch'), {code:'POSTGRES_GENERATION_DATASTORE_MISMATCH'});
    }
  }
  // `strict` is the display settings pool. Its identity is proved once per
  // client, not per read (decision trusted-worker-performance-boundary). The
  // session role cannot change afterwards: the login holds no role membership
  // (the settings screen at open and the api's role readiness check it), and
  // the snapshot facade refuses set_config.
  async function observeBackend (client, strict = false) {
    if (!operationWindow && !strict) return;
    // The startup observation does not compare the session and current roles:
    // a strict client is observed strictly once, whatever observed it before.
    if (observed.get(client) === client.processID && record.backends.has(client.processID) && (!strict || strictlyObserved.has(client))) return;
    const row = (await client.query("SELECT pg_backend_pid() AS pid,current_user AS role,extract(epoch from backend_start)::text AS birth," + DATASTORE_SQL +
      (strict ? ",session_user AS login" : '') +
      " FROM " + CURRENT_BACKEND_ACTIVITY)).rows[0];
    const identity = backendIdentity(client, row);
    if (strict && (row.login !== row.role ||
        options.direct === true && (row.role !== poolOptions.user || row.database !== poolOptions.database))) {
      throw Object.assign(new Error('PostgreSQL direct snapshot identity changed'), { code: 'POSTGRES_SNAPSHOT_IDENTITY_CHANGED' });
    }
    const previous = record.backends.get(identity.pid);
    if (strict && previous && (previous.role !== identity.role || previous.birth !== identity.birth)) {
      throw Object.assign(new Error('PostgreSQL snapshot backend changed'), { code: 'POSTGRES_SNAPSHOT_IDENTITY_CHANGED' });
    }
    screenBackend(client);
    record.backends.set(identity.pid, identity);
    observed.set(client, identity.pid);
    if (strict) strictlyObserved.add(client);
  }
  async function startupRole () {
    const text = "SELECT rolsuper, rolbypassrls,pg_backend_pid() AS pid,current_user AS role,(SELECT extract(epoch from backend_start)::text FROM " + CURRENT_BACKEND_ACTIVITY + ") AS birth," + DATASTORE_SQL + " FROM pg_roles WHERE rolname = current_user";
    if (!operationWindow) return pool.query(text);
    // The first-reference cohort requires one physical PostgreSQL backend per
    // client. Do not adopt a transaction-pooler backend through its SQL label.
    const client = await pool.connect(); let failure;
    try {
      const result = await client.query(text), row = result.rows[0];
      const identity = backendIdentity(client, row);
      screenBackend(client);
      record.backends.set(identity.pid, identity); observed.set(client, identity.pid);
      return result;
    } catch (error) { failure = error; throw error; }
    finally { client.release(failure); }
  }
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
  } catch (error) {
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
    if (transaction.unknownWork) throw transaction.unknownWork.error;
    if (transaction.snapshotFailure) throw transaction.snapshotFailure;
    if (transaction.strictReadOnly) assertSettingsParent(transaction.tenant, transaction.settingsParent);
  }

  async function queryInTransaction (transaction, text, values) {
    assertUsable(transaction);
    let result;
    try { result = await transaction.client.query(text, values); }
    catch (error) {
      // A missed local deadline does not prove the server finished: the client
      // is not idle. Anything sent after it would queue behind that unknown
      // work and run out its own deadline (a savepoint or transaction ROLLBACK
      // included), so this transaction sends nothing more.
      if (!transaction.strictReadOnly && !transaction.unknownWork && missedQueryDeadline(error)) {
        transaction.unknownWork = { error, text, phase: statementPhase(transaction, text) };
      }
      throw error;
    }
    // A socket event can arrive while a caller awaits something other than a
    // query, or alongside a query result. A known dead client cannot succeed.
    assertUsable(transaction);
    return result;
  }

  async function run (tenant, fn, begin = 'BEGIN', settingsContext, heldClient, importedSnapshot) {
    const strictReadOnly = settingsContext !== undefined;
    const outer = activeTransaction(tenant);
    if (outer) {
      if (heldClient && outer.client !== heldClient) throw Object.assign(new Error('PostgreSQL held owner cannot join another backend transaction'), { code: 'POSTGRES_OWNER_TRANSACTION_MISMATCH' });
      assertUsable(outer); return fn();
    }
    if (strictReadOnly) assertSettingsParent(tenant, settingsContext.parent);
    let client = heldClient;
    if (!client) {
      try { client = await pool.connect(); }
      catch (error) {
        if (!strictReadOnly && missedCheckoutDeadline(error)) {
          throw storageRefusal('STORAGE_BUSY', 'PostgreSQL connection pool had no free client in time; nothing was written', error, 'checkout');
        }
        throw error;
      }
    }
    const transaction = { client, tenant, active: true, body: false, strictReadOnly, settingsParent: settingsContext?.parent };
    // The pool removes its idle error listener while this client is checked
    // out. pg rejects active queries on transport failure, but also emits a
    // separate client error; bridge that event into this transaction's failure.
    const connectionFailed = error => {
      if (!transaction.connectionError) transaction.connectionError = error;
    };
    client.on('error', connectionFailed);
    const importAborted = () => {
      connectionFailed(importedSnapshot.signal.reason || new Error('POSTGRES_IMPORTED_SNAPSHOT_ABORTED'));
      // Abort the physical backend, including a blocked query. A late callback
      // cannot commit through this transaction after its recovery deadline.
      Promise.resolve(client.end()).catch(() => {});
    };
    if (importedSnapshot?.signal) {
      importedSnapshot.signal.addEventListener('abort', importAborted, { once: true });
      if (importedSnapshot.signal.aborted) importAborted();
    }
    let releaseError, windowLease, outcome, primary, windowReleaseError, clientReleaseError;
    let awaitingCommit = false;
    try {
      assertUsable(transaction);
      await observeBackend(client, strictReadOnly);
      assertUsable(transaction);
      if (operationWindow) windowLease = await operationWindow.acquireClient(client, tenant);
      assertUsable(transaction);
      try {
        const metadata = operationWindow && typeof operationWindow.isMetadataTenant === 'function' && operationWindow.isMetadataTenant(tenant) === true;
        const isolation = operationWindows.isWindow(operationWindow) && begin === 'BEGIN' && !metadata
          ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : begin;
        const readOnly = begin === READ_ONLY_SNAPSHOT || begin === READ_ONLY_COMMITTED;
        // A read-only snapshot, the settings snapshot included, binds the
        // tenant, takes the shared lock and reads the window in the statement
        // that takes its snapshot, so it checks out no second control client.
        const bindReadOnlySnapshot = begin === READ_ONLY_SNAPSHOT && !metadata && operationWindows.isWindow(operationWindow);
        // BEGIN, the tenant binding, the shared lock and the window read leave
        // as one round trip (generation-scope openClient).
        const opened = operationWindow && !importedSnapshot && !metadata && typeof operationWindow.openClient === 'function'
          ? await operationWindow.openClient(client, tenant, windowLease, { begin: isolation, snapshot: begin.includes('REPEATABLE READ'), readOnly,
            bindReadOnlySnapshot, query: text => queryInTransaction(transaction, text) })
          : null;
        if (opened === null) await queryInTransaction(transaction, metadata && !readOnly ? isolation + ' READ ONLY' : isolation);
        // PostgreSQL requires snapshot import before the first query, including
        // the tenant-local RLS setting. The validated name contains no SQL.
        if (opened === null && importedSnapshot) {
          await queryInTransaction(transaction, "SET TRANSACTION SNAPSHOT '" + importedSnapshot.name + "'");
          if (importedSnapshot.timeoutMs !== undefined) await queryInTransaction(transaction, "SELECT set_config('statement_timeout', $1, true)", [String(importedSnapshot.timeoutMs)]);
        }
        if (opened === null && !bindReadOnlySnapshot) await queryInTransaction(transaction, "SELECT set_config('app.current_tenant_id', $1, true)", [tenant]);
        if (opened === null && operationWindow) await operationWindow.assertClient(client, tenant, windowLease, { snapshot: begin.includes('REPEATABLE READ'), bindReadOnlySnapshot, readOnly });
        assertUsable(transaction);
        transaction.body = true;
        outcome = await transactions.run(transaction, fn);
        assertUsable(transaction);
        if (strictReadOnly) settingsProtocol.assertTransaction(client);
        if (operationWindow?.assertCommit) await operationWindow.assertCommit(client, tenant, windowLease);
        assertUsable(transaction);
        awaitingCommit = operationWindows.isWindow(operationWindow);
        const committed = await queryInTransaction(transaction, 'COMMIT');
        awaitingCommit = false;
        if (committed.command !== 'COMMIT') {
          throw new Error('PostgreSQL transaction was aborted; no changes were committed');
        }
      } catch (error) {
        if (awaitingCommit) {
          // A lost COMMIT reply gives no proof of rollback. Retire this
          // physical backend and leave any client retry to the caller.
          releaseError = error;
          heldOwners.get(client)?.lose();
        }
        if (transaction.unknownWork) {
          // No ROLLBACK behind the unknown statement: the client is evicted
          // below (release with an error) and the server ends the transaction,
          // which never sent COMMIT unless COMMIT itself missed the deadline.
          releaseError = releaseError || transaction.unknownWork.error;
          if (transaction.unknownWork.text === 'COMMIT') throw error;
          throw storageRefusal('STORAGE_TIMEOUT', 'PostgreSQL statement missed its local deadline; the transaction was not committed', error, transaction.unknownWork.phase);
        }
        try {
          if (strictReadOnly) {
            // A SQL error is rejected before its ReadyForQuery arrives; the
            // rollback proof waits for that packet within the query bound.
            await settingsProtocol.settled(client, options.query_timeout);
            settingsProtocol.assertRollback(client);
          }
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
      if (importedSnapshot?.signal) importedSnapshot.signal.removeEventListener('abort', importAborted);
      transaction.active = false;
      // Validate the idle driver state and finish local child bookkeeping.
      try {
        try { if (windowLease) { if (strictReadOnly) settingsProtocol.assertUnlock(client); await windowLease.close(primary || releaseError); } }
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

  const connection = {
    ...(operationWindow?.nativeLifecycle ? {nativeLifecycle: operationWindow.nativeLifecycle} : {}),
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
    // One tenant transaction of reads at current committed state. PostgreSQL
    // enforces READ ONLY, so no write can commit from it and the commit fence
    // has nothing to order; the shared lock still excludes replacement. Inside
    // an existing transaction it joins that transaction, as withTenant does.
    , readTenant (tenant, fn) {
      if (typeof fn !== 'function') throw new TypeError('PostgreSQL read callback required');
      return tenantScope.withTenant(tenant, () => run(tenantId(), fn, READ_ONLY_COMMITTED));
    }
    , transaction (fn) {
      const tenant = tenantId();
      if (activeTransaction(tenant)) throw new Error('PostgreSQL commit boundary requires a new transaction');
      return run(tenant, fn);
    }
    // Public readers start a database-enforced read-only snapshot. Reads inside
    // an existing write use that transaction, including its final write fence.
    , readOnlyTransaction (fn) {
      if (typeof fn !== 'function') throw new TypeError('PostgreSQL read callback required');
      return run(tenantId(), fn, READ_ONLY_SNAPSHOT);
    }
    // Explicit stronger snapshot capability for dormant durable consumers.
    // Never pretend an already-open READ COMMITTED transaction is upgraded.
    // Bookkeeping writes may commit in this snapshot; it is not READ ONLY.
    , snapshotTransaction (fn) {
      const tenant = tenantId();
      if (activeTransaction(tenant)) throw new Error('PostgreSQL snapshot requires a new transaction');
      return run(tenant, fn, 'BEGIN ISOLATION LEVEL REPEATABLE READ');
    }
    // Exact logical-slot snapshot import is a separate cold/recovery port.
    // It never joins an ambient transaction or weakens settings snapshots.
    , importedSnapshotTransaction (name, fn, { signal, timeoutMs } = {}) {
      if (typeof name !== 'string' || !/^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+$/.test(name) ||
          typeof fn !== 'function' || signal !== undefined && !(signal instanceof AbortSignal) ||
          timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)) {
        throw new TypeError('Explicit exported PostgreSQL snapshot required');
      }
      const tenant = tenantId();
      if (activeTransaction(tenant)) throw new Error('PostgreSQL snapshot import requires a new transaction');
      return run(tenant, fn, 'BEGIN ISOLATION LEVEL REPEATABLE READ', undefined, undefined, { name, signal, timeoutMs });
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
              // set_config is the one SELECT that changes session state (the role included).
              if (typeof text !== 'string' || !/^SELECT\s/.test(text) || /;/.test(text) || /set_config/i.test(text)) throw new TypeError('PostgreSQL snapshot query requires one SELECT');
              settingsProtocol.assertTransaction(transaction.client);
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
        }, READ_ONLY_SNAPSHOT, { parent });
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
    // One module-constant SELECT of trusted evaluator metadata (scheduling and
    // work state), as its own implicit transaction: the same READ COMMITTED
    // snapshot as readOnly's BEGIN READ ONLY/SELECT/COMMIT in one statement.
    // It runs on its own small pool whose backends start with
    // default_transaction_read_only=on, so PostgreSQL itself refuses any write
    // (SQLSTATE 25006) in these implicit transactions. Each read backend is
    // checked once before its first use, because a connection URL may carry
    // its own options. The SELECT-only text check is a convenience; callers
    // pass fixed text with parameters, never caller SQL.
    // No tenant is bound; no operation-window lease; nothing served from it.
    , async readStatement (text, values) {
      if (typeof text !== 'string' || !/^SELECT\s/.test(text) || /;/.test(text)) throw new TypeError('PostgreSQL read statement requires one SELECT');
      if (transactions.getStore()) throw new Error('PostgreSQL read statement cannot run inside a tenant transaction');
      const client = await readPool().connect(); let failure;
      try {
        await observeBackend(client);
        if (!readOnlyBackends.has(client)) {
          const mode = (await client.query("SELECT current_setting('default_transaction_read_only') AS mode")).rows[0]?.mode;
          if (mode !== 'on') throw Object.assign(new Error('PostgreSQL read statement backend is not read-only'), { code: 'POSTGRES_READ_STATEMENT_WRITABLE' });
          readOnlyBackends.add(client);
        }
        return await client.query(text, values);
      } catch (error) {
        // A client deadline does not prove the server finished: the failed
        // client is evicted below rather than reused behind unknown work.
        failure = error; throw error;
      } finally { client.release(failure); }
    }
    // Trusted receiver bookkeeping only. Fixed checkpoint SQL; it cannot write
    // clinical rows or publish effects. RLS grants restrict its consumer rows.
    // It deliberately does not acquire tenant serving/restore admission: a
    // paused tenant's durable receipt must not block the entire serial feed.
    , async updateRealtimeReceipts (options) {
      if (transactions.getStore()) throw new TypeError('Realtime receipt requires independent transaction');
      return require('../pgstream/realtime-receipt-sql').update({pool,observeBackend,...options});
    }
    , async admitEvaluatorTyped (options) {
      if (transactions.getStore()) throw new TypeError('Typed admission requires independent transaction');
      return require('../pgstream/work-state').admit({pool,observeBackend,...options});
    }
    , async observeEvaluatorTyped (options) {
      if (transactions.getStore()) throw new TypeError('Typed evaluator receipt requires independent transaction');
      if (operationWindow?.nativeLifecycle && options.observations.some(row => row.observed?.lifecycle !== undefined)) {
        throw new Error('PGSTREAM_NATIVE_LIFECYCLE_COHORT_REQUIRED');
      }
      return require('../pgstream/work-state').observe({pool,observeBackend,...options});
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
    , async holdAdvisoryLock (key, onLoss = () => {}, { sharedKey } = {}) {
      const keys = Array.isArray(key) ? [...key] : [key];
      if (!keys.length || keys.length > 10000 || new Set(keys).size !== keys.length || keys.some(value => typeof value !== 'string' || !/^-?[0-9]{1,19}$/.test(value) || BigInt(value) < -9223372036854775808n || BigInt(value) > 9223372036854775807n) || typeof onLoss !== 'function') throw new TypeError('Explicit bounded signed advisory keys and loss callback required');
      if (sharedKey !== undefined && (typeof sharedKey !== 'string' || !/^-?[0-9]{1,19}$/.test(sharedKey) || BigInt(sharedKey) < -9223372036854775808n || BigInt(sharedKey) > 9223372036854775807n || keys.includes(sharedKey))) throw new TypeError('Explicit distinct shared owner key required');
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
        if (sharedKey !== undefined && (await client.query('SELECT pg_try_advisory_lock_shared($1::bigint) AS held', [sharedKey])).rows[0]?.held !== true) throw Object.assign(new Error('POSTGRES_OPERATIONAL_OWNER_CONFLICT'), { code: 'POSTGRES_OPERATIONAL_OWNER_CONFLICT' });
        const locks = keys.length === 1
          ? (await client.query('SELECT pg_try_advisory_lock($1::bigint) AS held', keys)).rows
          : (await client.query('SELECT pg_try_advisory_lock(k) AS held FROM unnest($1::bigint[]) AS k', [keys])).rows;
        held = locks.length === keys.length && locks.every(row => row.held === true);
        if (!held || lost) throw Object.assign(new Error('POSTGRES_OPERATIONAL_OWNER_CONFLICT'), { code: 'POSTGRES_OPERATIONAL_OWNER_CONFLICT' });
      } catch (error) { client.removeListener('error', loss); client.release(error); throw error; }
      let ownerTransaction = null;
      const ownerPid = client.processID;
      const keySet = new Set(keys);
      const lockBits = value => { const bits = BigInt.asUintN(64, BigInt(value)); return [(bits >> 32n).toString(), (bits & 4294967295n).toString()]; };
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
      const check = async ownedKey => {
        assertOwned();
        if (ownedKey !== undefined && !keySet.has(ownedKey)) throw new Error('POSTGRES_OPERATIONAL_OWNER_KEY_REFUSED');
        const checked = [...(ownedKey === undefined ? keys : [ownedKey]), ...(sharedKey === undefined ? [] : [sharedKey])].map(lockBits);
        const highs = checked.map(bits => bits[0]), lows = checked.map(bits => bits[1]);
        try {
          const row = (await client.query("SELECT bool_and(EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND classid=k.high AND objid=k.low AND objsubid=1 AND granted)) AS held FROM unnest($1::oid[],$2::oid[]) AS k(high,low)", [highs, lows])).rows[0];
          assertOwned();
          if (!row?.held) throw new Error('Owner resource unavailable');
        } catch { loss(); throw Object.assign(new Error('POSTGRES_OPERATIONAL_OWNER_LOST'), {code:'POSTGRES_OPERATIONAL_OWNER_LOST'}); }
      };
      heldOwners.set(client, { lose: loss });
      return Object.freeze({
        get available () { return held && !lost && !released && client.processID === ownerPid; },
        get backendPid () { assertOwned(); return ownerPid; },
        // A selected effect owns a new COMMIT boundary. Reject before the
        // serial queue so same-owner nesting cannot wait on its own body.
        withTenantTransaction (tenant, fn) {
          return tenantScope.withTenant(tenant, () => {
            const selectedTenant = tenantId();
            if (activeTransaction(selectedTenant)) return Promise.reject(Object.assign(
              new Error('PostgreSQL owner commit boundary requires no ambient transaction'),
              { code: 'POSTGRES_OWNER_TRANSACTION_NESTED' }));
            return serial(() => tenantScope.withTenant(selectedTenant, () => run(selectedTenant, fn, 'BEGIN', undefined, client)));
          });
        },
        // Completion and re-observation serialize on this SAME held backend.
        withTenant (tenant, fn) {
          return serial(() => tenantScope.withTenant(tenant, () => run(tenantId(), fn, 'BEGIN', undefined, client)));
        },
        check (ownedKey) {
          // Preserve an explicit check by a body already on this owner client.
          // External timers/checks serialize with completion and re-observation.
          return transactions.getStore()?.client === client ? check(ownedKey) : serial(() => check(ownedKey));
        },
        async close () {
          if (released) return; released = true;
          await ownerTransaction?.catch(() => {});
          let error;
          try { if (!lost) { await client.query('SELECT pg_advisory_unlock(k) FROM unnest($1::bigint[]) AS k', [keys]); if (sharedKey !== undefined) await client.query('SELECT pg_advisory_unlock_shared($1::bigint)', [sharedKey]); } }
          catch (failure) { error = failure; }
          finally { held = false; heldOwners.delete(client); client.removeListener('error', loss); client.release(error || (lost ? new Error('Owner backend lost') : undefined)); }
        }
      });
    }
    , end () {
      if (record.closed) return Promise.resolve();
      if (!ending) ending = Promise.all([pool.end(), readStatementPool?.end()]).then(() => {
        record.closed = true;
        liveConnections.delete(record);
      });
      // A failed drain keeps the process binding until its resources close.
      return ending;
    }
  };
  return connection;
};

// All lower pools in the process must use the selected generation scope.
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
