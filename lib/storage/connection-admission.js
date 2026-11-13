'use strict';

// Opt-in process-local enforcement for a controller-admitted finite slot plan.
// This does not discover PostgreSQL capacity or grant a worker incarnation.
// Pool.end and local stream destruction are only logical/local signals.
// Selected plain PG retirement requires successful authentication, idle protocol
// Terminate, peer EOF and clean close, plus every connect/end outcome settled.
// Failed or aborted authentication remains held even after an empty census.
// Durable controller callbacks are private; no connection URI enters snapshots.

const { createHash } = require('node:crypto');
const { isIP } = require('node:net');
let installed;
const records = new WeakMap();
const databaseConnect = Symbol('databaseConnect');
const fail = code => Object.assign(new Error(code), { code });
const integer = value => Number.isSafeInteger(value) && value > 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exactObject = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
// Controller-private root extensions (including control) stay opaque. Only the
// authority fields consumed by this physical gate have a core-owned grammar.
function plan2Authority (plan) {
  return [['processInstanceId', /^[a-z][a-z0-9-]{0,62}$/], ['incarnation', /^[a-f0-9]{32}$/],
    ['nonce', /^[a-f0-9]{32}$/], ['planSha256', /^[a-f0-9]{64}$/], ['pgResourceId', /^[A-Za-z0-9_.:-]{1,128}$/]]
    .every(([key, pattern]) => typeof plan[key] === 'string' && pattern.test(plan[key])) &&
    exactObject(plan.source, ['coreCommit', 'deployCommit']) && ['coreCommit', 'deployCommit'].every(key => typeof plan.source[key] === 'string' && /^[a-f0-9]{40}$/.test(plan.source[key])) &&
    databaseIdentity(plan.workerDatabase);
}

// Plan 2 refuses public queries until this fixed read verifies the admitted
// backend. Query-before-connect is deliberately unsupported only in plan 2.
const DATABASE_IDENTITY_TYPES = Object.freeze({ getTypeParser: () => value => typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : null });
const DATABASE_IDENTITY_SQL = 'SELECT pg_catalog.current_database() AS database, oid::pg_catalog.text AS "databaseOid" FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()';
function databaseIdentity (value) {
  return exactObject(value, ['database', 'databaseOid']) && typeof value.database === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(value.database) &&
    typeof value.databaseOid === 'string' && /^[1-9][0-9]{0,9}$/.test(value.databaseOid) && Number(value.databaseOid) <= 4294967295;
}
function queryRefusal (client, args) {
  const error = fail('CONNECTION_ADMISSION_DATABASE_NOT_VERIFIED'), query = args[0];
  if (query && typeof query.submit === 'function' && typeof query.handleError === 'function') {
    queueMicrotask(() => query.handleError(error, client.connection)); return query;
  }
  const callback = typeof args[2] === 'function' ? args[2] : typeof args[1] === 'function' ? args[1] : query?.callback;
  if (typeof callback === 'function') { queueMicrotask(() => callback(error)); return; }
  return Promise.reject(error);
}


function applicationTag (plan, capabilityName) {
  if (!object(plan) || plan.version === 2 && typeof plan.incarnation !== 'string' || !/^[a-f0-9]{32}$/.test(plan.incarnation) || typeof capabilityName !== 'string' || !capabilityName || Buffer.byteLength(capabilityName) > 128) throw fail('CONNECTION_ADMISSION_PLAN_INVALID');
  return 'nscb:' + plan.incarnation + ':' + createHash('sha256').update(capabilityName).digest('hex').slice(0, 16);
}

function snapshot (state) {
  return {
    version: 1, processInstanceId: state.plan.processInstanceId, incarnation: state.plan.incarnation,
    nonce: state.plan.nonce, source: { ...state.plan.source }, planSha256: state.plan.planSha256, pgResourceId: state.plan.pgResourceId,
    frozen: state.frozen, uncertain: !!state.failure, acknowledged: state.acknowledged,
    constructorsFrozen: state.frozen, pendingConnects: [...state.clients].reduce((total, row) => total + row.connectPending, 0),
    liveConnections: [...state.clients].filter(row => row.connectStarted && !row.actualEnded).length,
    unconfirmedCleanup: !!state.failure || [...state.pools, ...state.clients].some(row => row.uncertain),
    cleanShutdown: state.cleanShutdown, cold: state.coldGate.health(), tags: [...state.tags.values()],
    capabilityReservations: Object.fromEntries(state.capabilityCounts), directReservations: Object.fromEntries(state.groupCounts),
    pools: [...state.pools].map(row => ({ capability: row.capability, maximum: row.maximum, ended: row.endSettled, retired: row.retired, uncertain: row.uncertain })),
    clients: [...state.clients].map(row => ({ capability: row.capability, pooled: !!row.pool, connectStarted: row.connectStarted,
      connectPending: row.connectPending, authenticated: row.authenticated, protocolEnd: row.protocolEnd, peerEnded: row.peerEnded, closeConfirmed: row.closeConfirmed, actualEnded: row.actualEnded, endSettled: row.endSettled, retired: row.retired, uncertain: row.uncertain })),
    configurations: Object.fromEntries([...state.configurations].map(([name, value]) => [name, { ...value }])),
    applicationNames: Object.fromEntries([...state.names].map(([tag, value]) => [tag, { ...value }]))
  };
}
function physicalClosed (row) { return row.connectPending === 0 && (row.authenticated && row.protocolEnd && row.peerEnded && row.closeConfirmed && row.actualEnded || !row.connectStarted && row.endSettled); }
function retire (state) {
  if (state.failure) return;
  for (const row of state.clients) {
    if (row.pool && !row.uncertain && physicalClosed(row) && (!row.endRequested || row.endSettled)) {
      row.retired = true; row.pool.clients.delete(row); state.clients.delete(row); continue;
    }
    if (!row.pool && !row.retired && !row.uncertain && (row.endSettled || row.actualEnded && !row.endRequested) && physicalClosed(row)) {
      row.retired = true; state.clients.delete(row); state.capabilityCounts.set(row.capability, state.capabilityCounts.get(row.capability) - 1);
      state.groupCounts.set(row.group, state.groupCounts.get(row.group) - 1);
    }
  }
  for (const row of state.pools) {
    if (!row.retired && !row.uncertain && row.endSettled && [...row.clients].every(client => !client.uncertain && physicalClosed(client) && (!client.endRequested || client.endSettled))) {
      row.retired = true; state.pools.delete(row);
      for (const client of row.clients) state.clients.delete(client);
      state.capabilityCounts.set(row.capability, state.capabilityCounts.get(row.capability) - 1);
    }
  }
}
function changed (state) {
  retire(state);
  try {
    const result = state.onState(snapshot(state));
    if (result && typeof result.then === 'function') { result.catch?.(() => {}); throw fail('CONNECTION_ADMISSION_STATE_CALLBACK_ASYNC'); }
  }
  catch (cause) { state.failure = state.failure || Object.assign(fail('CONNECTION_ADMISSION_STATE_UNCONFIRMED'), { cause }); }
  for (const wake of [...state.waiters]) wake();
  return state.failure;
}
function uncertain (state, row, cause) {
  row.uncertain = true; row.cleanupError = cause;
  if (row.pool) { row.pool.uncertain = true; row.pool.cleanupError = cause; }
  if (row.retired) state.failure = state.failure || Object.assign(fail('CONNECTION_ADMISSION_CLEANUP_UNCONFIRMED'), { cause });
  changed(state);
}
function waitFor (state, row, predicate) {
  return new Promise((resolve, reject) => {
    function check () {
      if (state.failure || row?.uncertain || !row && [...state.pools, ...state.clients].some(item => item.uncertain)) { state.waiters.delete(check); reject(state.failure || fail('CONNECTION_ADMISSION_CLEANUP_UNCONFIRMED')); }
      else if (predicate()) { state.waiters.delete(check); resolve(); }
    }
    state.waiters.add(check); check();
  });
}
function capability (state, name, kind) {
  if (state.frozen || state.failure) throw state.failure || fail('CONNECTION_ADMISSION_FROZEN');
  const entry = state.plan.capabilities[name];
  if (!entry || entry.kind !== kind) throw fail('CONNECTION_ADMISSION_CAPABILITY_UNKNOWN');
  return entry;
}
function reserve (state, name, kind) {
  const entry = capability(state, name, kind), count = state.capabilityCounts.get(name) || 0;
  if (count >= entry.maxInstances) throw fail('CONNECTION_ADMISSION_CAPABILITY_EXHAUSTED');
  if (kind === 'direct' && state.groupCounts.get(entry.directGroup) >= state.plan.directGroups[entry.directGroup]) throw fail('CONNECTION_ADMISSION_DIRECT_EXHAUSTED');
  state.capabilityCounts.set(name, count + 1);
  if (kind === 'direct') state.groupCounts.set(entry.directGroup, state.groupCounts.get(entry.directGroup) + 1);
  return entry;
}
// pg-pool hides credentials as non-enumerable properties. Preserve untouched
// constructor descriptors/prototype without evaluating getters or credentials;
// only the selected max, tag and fixed Client constructor are replaced.
function constructorOptions (options, replacements) {
  const descriptors = Object.getOwnPropertyDescriptors(options);
  for (const [key, value] of Object.entries(replacements)) {
    descriptors[key] = { value, enumerable: true, writable: true, configurable: true };
  }
  return Object.create(Object.getPrototypeOf(options), descriptors);
}
function resourceAlias (options) {
  if (!object(options) || options.connection || options.stream) throw fail('CONNECTION_ADMISSION_OPTIONS_UNKNOWN');
  const startup = options.options === undefined ? process.env.PGOPTIONS : options.options;
  if (startup !== undefined && (typeof startup !== 'string' || startup.length > 4096 || !/^(?:\s*-c\s+(?!application_name=)[a-z_]+=[^\s]+\s*)*$/.test(startup))) throw fail('CONNECTION_ADMISSION_STARTUP_OPTIONS_UNKNOWN');
  let host, port, sslMode;
  if (options.connectionString !== undefined) {
    try {
      const uri = new URL(options.connectionString);
      if (!['postgres:', 'postgresql:'].includes(uri.protocol) || uri.hash || uri.searchParams.getAll('sslmode').length > 1 || [...uri.searchParams.keys()].some(key => key !== 'sslmode')) throw Error();
      host = uri.hostname; port = uri.port || '5432'; sslMode = uri.searchParams.get('sslmode');
      if (options.host !== undefined && options.host !== host || options.port !== undefined && String(options.port) !== port) throw Error();
    } catch { throw fail('CONNECTION_ADMISSION_RESOURCE_UNKNOWN'); }
  } else { host = options.host; port = options.port === undefined ? '5432' : String(options.port); }
  if (sslMode && sslMode !== 'disable' || options.ssl !== undefined && options.ssl !== false || !sslMode && options.ssl === undefined && (require('pg').defaults.ssl || process.env.PGSSLMODE && process.env.PGSSLMODE !== 'disable')) throw fail('CONNECTION_ADMISSION_TLS_UNSUPPORTED');
  if (typeof host !== 'string' || !host || !/^[0-9]+$/.test(port) || +port < 1 || +port > 65535) throw fail('CONNECTION_ADMISSION_RESOURCE_UNKNOWN');
  host = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (host.includes(':')) { if (isIP(host) !== 6) throw fail('CONNECTION_ADMISSION_RESOURCE_UNKNOWN'); host = '[' + host + ']'; }
  else if (!/^[a-z0-9._-]+$/.test(host)) throw fail('CONNECTION_ADMISSION_RESOURCE_UNKNOWN');
  return host + ':' + Number(port);
}
function assertResource (state, options) {
  if (!state.plan.resourceAliases.includes(resourceAlias(options))) throw fail('CONNECTION_ADMISSION_RESOURCE_MISMATCH');
}
function tagged (state, capabilityName, options) {
  assertResource(state, options);
  // Match pg ConnectionParameters.val/application startup precedence before
  // replacing it with the bounded incarnation tag. Empty options fall through.
  const defaults = require('pg').defaults;
  const original = options.application_name || process.env.PGAPPNAME || defaults.application_name ||
    options.fallback_application_name || defaults.fallback_application_name || null;
  const tag = state.tags.get(capabilityName);
  if (original !== null && (typeof original !== 'string' || Buffer.byteLength(original) > 4096)) throw fail('CONNECTION_ADMISSION_APPLICATION_NAME_UNKNOWN');
  const previous = state.names.get(tag);
  if (previous && previous.originalApplicationName !== original) throw fail('CONNECTION_ADMISSION_APPLICATION_NAME_CHANGED');
  state.names.set(tag, { capability: capabilityName, originalApplicationName: original });
  return constructorOptions(options, { application_name: tag });
}
function invokeEnd (state, row, invoke) {
  if (row.endPromise) return row.endPromise;
  row.endRequested = true;
  let returned = false, callbackSettled = false, promisePending = false, failure;
  const update = () => {
    if (failure) { uncertain(state, row, failure); return; }
    if (returned && callbackSettled && !promisePending && !row.endSettled) { row.endSettled = true; changed(state); }
  };
  const settled = error => { callbackSettled = true; failure = failure || error; update(); };
  try {
    const result = invoke(settled);
    if (result && typeof result.then === 'function') {
      promisePending = true;
      result.then(() => { promisePending = false; settled(); }, error => { promisePending = false; settled(error); });
    }
  } catch (error) { callbackSettled = true; failure = error; }
  returned = true; update();
  row.endPromise = waitFor(state, row, () => row.poolResource ? row.retired : row.pool ? physicalClosed(row) && row.endSettled : row.retired);
  return row.endPromise;
}
function withCallback (promise, callback) {
  if (typeof callback === 'function') { promise.then(() => callback(), error => callback(error)); return; }
  return promise;
}

function idleClient (client) {
  return client._queryable === true && client._connectionError !== true && typeof client._getActiveQuery === 'function' && !client._getActiveQuery() &&
    Array.isArray(client._queryQueue) && !client._queryQueue.length && Array.isArray(client._sentQueryQueue) && !client._sentQueryQueue.length;
}
function protocolReady (client, row) {
  return row.protocolReady === true && ['I', 'T', 'E'].includes(row.readyStatus) && client.readyForQuery === true;
}
function observeTransport (client, state, row) {
  const connection = client.connection, stream = connection?.stream;
  if (!connection || typeof connection.once !== 'function' || typeof connection.end !== 'function' ||
      !stream || ['once','on','destroy','end'].some(key => typeof stream[key] !== 'function')) throw fail('CONNECTION_ADMISSION_END_OBSERVER_REQUIRED');
  if (client.connectionParameters?.ssl !== false) throw fail('CONNECTION_ADMISSION_TLS_UNSUPPORTED');
  row.stream = stream;
  const poison = code => uncertain(state,row,fail(code));
  const protocolEnd = connection.end;
  connection.end = function (...args) {
    if (!row.endRequested || !row.authenticated || !idleClient(client) || state.plan.version === 2 && row.connectStarted && !protocolReady(client, row) || connection.stream !== stream || stream.writable !== true || stream.destroyed || row.transportFailed) poison('CONNECTION_ADMISSION_TERMINATION_UNCONFIRMED');
    else row.protocolEnd = true;
    try { return protocolEnd.apply(this,args); } catch (error) { uncertain(state,row,error);throw error; }
  };
  const destroy = stream.destroy;
  stream.destroy = function (...args) {
    row.destroyObserved = true;
    if (row.connectStarted && (!row.peerEnded || !row.protocolEnd || args[0])) poison('CONNECTION_ADMISSION_TRANSPORT_UNCONFIRMED');
    return destroy.apply(this,args);
  };
  const end = stream.end;
  stream.end = function (...args) {
    if (row.connectStarted && !row.protocolEnd) poison('CONNECTION_ADMISSION_TERMINATION_UNCONFIRMED');
    return end.apply(this,args);
  };
  stream.once('end',()=>{row.peerEnded=true;changed(state);});
  stream.on('error',error=>{row.transportFailed=true;if(row.connectStarted)uncertain(state,row,error);});
  connection.on('error',error=>{row.transportFailed=true;if(row.connectStarted)uncertain(state,row,error);});
  connection.once('sslconnect',()=>poison('CONNECTION_ADMISSION_TLS_UNSUPPORTED'));
  stream.once('close',hadError=>{
    row.closeConfirmed = hadError === false && row.authenticated && row.protocolEnd && row.peerEnded && !row.transportFailed && connection.stream === stream;
    if(row.connectStarted && !row.closeConfirmed)poison('CONNECTION_ADMISSION_TRANSPORT_UNCONFIRMED');else changed(state);
  });
  connection.once('end',()=>{row.actualEnded=true;if(row.connectStarted && !row.authenticated)poison('CONNECTION_ADMISSION_AUTHENTICATION_UNCONFIRMED');else changed(state);});
}

function trackedClient (Client, state, name, pool) {
  return class AdmittedClient extends Client {
    constructor (options) {
      assertResource(state, options);
      let entry;
      if (pool) {
        if (state.frozen || state.failure || pool.endRequested || pool.uncertain) throw state.failure || fail('CONNECTION_ADMISSION_FROZEN');
        entry = state.plan.capabilities[name];
        if (pool.clients.size >= pool.maximum) throw fail('CONNECTION_ADMISSION_POOL_CLIENT_EXHAUSTED');
      } else entry = reserve(state, name, 'direct');
      const row = { capability: name, group: entry.directGroup, pool, connectStarted: false, connectPending: 0, authenticated: false, protocolEnd: false, peerEnded: false, closeConfirmed: false,
        actualEnded: false, endRequested: false, endSettled: false, retired: false, uncertain: false };
      // Track reservation before any user-visible connect call can happen.
      state.clients.add(row); if (pool) pool.clients.add(row);
      let selected;
      try { selected = pool ? constructorOptions(options, { application_name: pool.tag }) : tagged(state, name, options); }
      catch (error) { uncertain(state, row, error); throw error; }
      const journalError = changed(state); if (journalError) { uncertain(state, row, journalError); throw journalError; }
      try { super(selected); }
      catch (error) { uncertain(state, row, error); throw error; }
      row.state = state;
      records.set(this, row);
      try { observeTransport(this,state,row); } catch(error) { uncertain(state,row,error);throw error; }
      if (!this.connectionParameters || this.connectionParameters.application_name !== selected.application_name) {
        uncertain(state, row, fail('CONNECTION_ADMISSION_TAG_OVERRIDDEN')); throw fail('CONNECTION_ADMISSION_TAG_OVERRIDDEN');
      }
    }
    _handleReadyForQuery (message) {
      const row = records.get(this);
      if (row) { row.readyStatus = ['I', 'T', 'E'].includes(message?.status) ? message.status : null; row.protocolReady = row.readyStatus !== null; }
      return super._handleReadyForQuery(message);
    }
    _handleErrorMessage (message) {
      const row = records.get(this); if (row) row.protocolReady = false;
      return super._handleErrorMessage(message);
    }
    emit (event, ...args) {
      const row = records.get(this);
      if (state.plan.version === 2 && event === 'connect' && row) {
        row.rawConnectSeen = true;
        if (!row.identityVerified || row.publicConnectEmitted || row.endRequested || state.frozen || state.failure || row.uncertain) return false;
        row.publicConnectEmitted = true;
      }
      return super.emit(event, ...args);
    }
    query (...args) {
      if (state.plan.version === 2 && !records.get(this)?.identityVerified) return queryRefusal(this, args);
      const row = records.get(this); if (row) row.protocolReady = false;
      return super.query(...args);
    }
    connect (callback) {
      if (state.plan.version === 2) return this[databaseConnect](callback);
      const row = records.get(this);
      if (!row || state.frozen || state.failure || row.connectStarted || row.endSettled || row.destroyObserved || row.peerEnded) {
        const error = state.failure || fail('CONNECTION_ADMISSION_HANDSHAKE_REFUSED');
        if (typeof callback === 'function') { queueMicrotask(() => callback(error)); return; }
        return Promise.reject(error);
      }
      row.connectStarted = true; row.connectPending++;
      const journalError = changed(state);
      if (journalError) { row.connectPending--; uncertain(state, row, journalError); if (typeof callback === 'function') { queueMicrotask(() => callback(journalError)); return; } return Promise.reject(journalError); }
      let settled = false;
      const complete = error => {
        if (settled) return error; settled = true; row.connectPending--;
        if (error) uncertain(state,row,Object.assign(fail('CONNECTION_ADMISSION_AUTHENTICATION_UNCONFIRMED'),{cause:error}));
        else { row.authenticated = true; if(row.actualEnded || row.endRequested)uncertain(state,row,fail('CONNECTION_ADMISSION_AUTHENTICATION_UNCONFIRMED')); }
        return changed(state) || error;
      };
      if (typeof callback === 'function') {
        try { return super.connect(error => callback(complete(error))); }
        catch (error) { const failure = complete(error); queueMicrotask(() => callback(failure)); return; }
      }
      try {
        const result = super.connect();
        if (!result || typeof result.then !== 'function') { uncertain(state, row, fail('CONNECTION_ADMISSION_CONNECT_OUTCOME_UNKNOWN')); return Promise.reject(fail('CONNECTION_ADMISSION_CONNECT_OUTCOME_UNKNOWN')); }
        return result.then(value => { const error = complete(); if (error) throw error; return value; }, error => { throw complete(error); });
      } catch (error) { return Promise.reject(complete(error)); }
    }
    [databaseConnect] (callback) {
      const row = records.get(this);
      if (!row || state.frozen || state.failure || row.connectStarted || row.endSettled || row.destroyObserved || row.peerEnded) {
        const error = state.failure || fail('CONNECTION_ADMISSION_HANDSHAKE_REFUSED');
        if (typeof callback === 'function') { queueMicrotask(() => callback(error)); return; }
        return Promise.reject(error);
      }
      row.connectStarted = true; row.connectPending++;
      const journalError = changed(state);
      if (journalError) { row.connectPending--; uncertain(state, row, journalError); if (typeof callback === 'function') { queueMicrotask(() => callback(journalError)); return; } return Promise.reject(journalError); }
      let settled = false;
      const complete = error => {
        if (settled) return error; settled = true; row.connectPending--;
        if (error) uncertain(state,row,error);
        return changed(state) || error;
      };
      const connecting = new Promise((resolve, reject) => {
        const finish = error => {
          if (settled) return;
          if (!error && (row.actualEnded || row.endRequested || row.destroyObserved || row.peerEnded || row.uncertain || state.frozen || state.failure)) error = fail('CONNECTION_ADMISSION_HANDSHAKE_REFUSED');
          const failure = complete(error);
          if (failure) { reject(failure); return; }
          resolve();
        };
        const authenticated = error => {
          if (row.authenticationCompleted) { if (error) uncertain(state,row,fail('CONNECTION_ADMISSION_AUTHENTICATION_UNCONFIRMED')); return; } row.authenticationCompleted = true;
          if (error) { finish(fail('CONNECTION_ADMISSION_AUTHENTICATION_UNCONFIRMED')); return; }
          row.authenticated = true;
          if (state.plan.version !== 2) { finish(); return; }
          if (row.endRequested || row.actualEnded || state.frozen || state.failure) { finish(fail('CONNECTION_ADMISSION_HANDSHAKE_REFUSED')); return; }
          let checked = false;
          const checkedIdentity = (error, result) => {
            if (checked) return; checked = true; clearTimeout(timer);
            if (error) { finish(fail('CONNECTION_ADMISSION_DATABASE_UNCONFIRMED')); return; }
            const identity = result?.rows?.[0], expected = state.plan.workerDatabase;
            if (result?.rows?.length !== 1 || !databaseIdentity(identity) || identity.database !== expected.database || identity.databaseOid !== expected.databaseOid) {
              finish(fail('CONNECTION_ADMISSION_DATABASE_MISMATCH')); return;
            }
            finish();
          };
          // Client read deadline only: timeout does NOT prove server statement
          // retirement. Every failed/unknown check stays charged and uncertain.
          const timer = setTimeout(() => checkedIdentity(fail('CONNECTION_ADMISSION_DATABASE_TIMEOUT')), 1000);
          try { super.query({ text: DATABASE_IDENTITY_SQL, query_timeout: 1000, types: DATABASE_IDENTITY_TYPES }, checkedIdentity); }
          catch { checkedIdentity(fail('CONNECTION_ADMISSION_DATABASE_UNCONFIRMED')); }
        };
        try { super.connect(authenticated); }
        catch { const error = fail('CONNECTION_ADMISSION_AUTHENTICATION_UNCONFIRMED'); uncertain(state,row,error); finish(error); }
      });
      const deliver = () => {
        if (row.endRequested || row.actualEnded || row.destroyObserved || row.peerEnded || row.uncertain || state.frozen || state.failure) {
          const error = fail('CONNECTION_ADMISSION_HANDSHAKE_REFUSED'); uncertain(state,row,error); throw error;
        }
        row.identityVerified = true;
      };
      // pg's raw callback precedes its connect event. For plan 2 that event is
      // held until the fixed query completes; callbacks still precede it.
      if (typeof callback === 'function') {
        connecting.then(() => { try { deliver(); } catch (error) { callback(error); return; } callback(); if (row.rawConnectSeen) this.emit('connect'); }, error => callback(error)); return;
      }
      return connecting.then(() => { deliver(); if (row.rawConnectSeen) this.emit('connect'); });
    }

    end (callback) {
      const row = records.get(this);
      if (!row) return typeof callback === 'function' ? super.end(callback) : super.end();
      if (row.connectStarted && (!row.authenticated || !idleClient(this) || this.connection.stream !== row.stream)) uncertain(state,row,fail('CONNECTION_ADMISSION_TERMINATION_UNCONFIRMED'));
      return withCallback(invokeEnd(state, row, done => super.end(done)), callback);
    }
  };
}

function poolOptions (name, original) {
  if (!installed) return original;
  const state = installed, entry = capability(state, name, 'pool');
  assertResource(state, original);
  if (!object(original) || original.max !== entry.metadata.requestedMaximum) throw fail('CONNECTION_ADMISSION_SOURCE_OPTIONS_CHANGED');
  const configuration = { requestedMaximum: original.max, selectedMaximum: entry.poolMax,
    configurationSource: entry.metadata.configurationSource || null, source: entry.metadata.source || null };
  const prior = state.configurations.get(name);
  if (prior && JSON.stringify(prior) !== JSON.stringify(configuration)) throw fail('CONNECTION_ADMISSION_SOURCE_OPTIONS_CHANGED');
  state.configurations.set(name, configuration);
  const error = changed(state); if (error) throw error;
  return constructorOptions(original, { max: entry.poolMax });
}

function wrapClient (Client, name) {
  if (!installed) return Client;
  if (typeof Client !== 'function') throw fail('CONNECTION_ADMISSION_CLIENT_REQUIRED');
  return trackedClient(Client, installed, name, null);
}
function wrapPool (Pool, Client, name) {
  if (!installed) return Pool;
  if (typeof Pool !== 'function' || typeof Client !== 'function') throw fail('CONNECTION_ADMISSION_POOL_REQUIRED');
  const state = installed;
  return class AdmittedPool extends Pool {
    constructor (options) {
      const entry = capability(state, name, 'pool');
      if (!object(options) || options.max !== entry.poolMax || options.Client) throw fail('CONNECTION_ADMISSION_POOL_MAX_MISMATCH');
      if (!state.configurations.has(name)) poolOptions(name, options);
      reserve(state, name, 'pool');
      const row = { capability: name, poolResource: true, maximum: entry.poolMax, clients: new Set(),
        endRequested: false, endSettled: false, retired: false, uncertain: false };
      state.pools.add(row);
      const journalError = changed(state); if (journalError) { uncertain(state, row, journalError); throw journalError; }
      let selected;
      try { selected = tagged(state, name, options); row.tag = selected.application_name; }
      catch (error) { uncertain(state, row, error); throw error; }
      try { super(constructorOptions(selected, { Client: trackedClient(Client, state, name, row) })); }
      catch (error) { uncertain(state, row, error); throw error; }
      records.set(this, row);
    }
    newClient (pending) {
      const row = records.get(this);
      if (state.frozen || state.failure || row?.endRequested || row?.uncertain || row?.clients.size >= row?.maximum) {
        const error = state.failure || fail(row?.uncertain ? 'CONNECTION_ADMISSION_CLEANUP_UNCONFIRMED' : row?.clients.size >= row?.maximum ? 'CONNECTION_ADMISSION_POOL_CLIENT_EXHAUSTED' : 'CONNECTION_ADMISSION_HANDSHAKE_REFUSED');
        if (!pending || typeof pending.callback !== 'function') throw error;
        queueMicrotask(() => pending.callback(error, undefined, () => {})); return;
      }
      try { return super.newClient(pending); }
      catch (error) { queueMicrotask(() => pending.callback(error, undefined, () => {})); return; }
    }
    end (callback) {
      const row = records.get(this); row.endRequested = true;
      return withCallback(invokeEnd(state, row, done => super.end(done)), callback);
    }
  };
}

function install (plan, { onState, onQuiescent } = {}) {
  if (installed) throw fail('CONNECTION_ADMISSION_ALREADY_INSTALLED');
  if (!object(plan) || ![1, 2].includes(plan.version) ||
      plan.version === 2 && !plan2Authority(plan) || !/^[a-z][a-z0-9-]{0,62}$/.test(plan.processInstanceId) ||
      !/^[a-f0-9]{32}$/.test(plan.incarnation) || !/^[a-f0-9]{32}$/.test(plan.nonce) || !/^[a-f0-9]{64}$/.test(plan.planSha256) ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(plan.pgResourceId) || !object(plan.source) ||
      !['coreCommit', 'deployCommit'].every(key => /^[a-f0-9]{40}$/.test(plan.source[key])) ||
      !Array.isArray(plan.resourceAliases) || !plan.resourceAliases.length || plan.resourceAliases.length > 128 || plan.resourceAliases.some(alias => typeof alias !== 'string' || alias !== alias.toLowerCase() || !/^.+:[0-9]+$/.test(alias)) ||
      !object(plan.cold) || !object(plan.capabilities) || !Object.keys(plan.capabilities).length || Object.keys(plan.capabilities).length > 1024 || !object(plan.directGroups) ||
      typeof onState !== 'function' || typeof onQuiescent !== 'function') throw fail('CONNECTION_ADMISSION_PLAN_INVALID');
  let copied;
  try { copied = structuredClone(plan); } catch { throw fail('CONNECTION_ADMISSION_PLAN_INVALID'); }
  if (copied.version === 2 && !plan2Authority(copied)) throw fail('CONNECTION_ADMISSION_PLAN_INVALID');
  const tags = new Map();
  for (const [name, entry] of Object.entries(copied.capabilities)) {
    if (entry?.kind === 'client') entry.kind = 'direct';
    if (entry?.kind === 'direct' && entry.maxInstances === undefined && typeof entry.directGroup === 'string') entry.maxInstances = copied.directGroups[entry.directGroup];
    if (!name || Buffer.byteLength(name) > 128 || !object(entry) || !['pool', 'direct'].includes(entry.kind) || !integer(entry.maxInstances) ||
        entry.kind === 'pool' && (!integer(entry.poolMax) || !object(entry.metadata) || !integer(entry.metadata.requestedMaximum)) ||
        entry.kind === 'direct' && (typeof entry.directGroup !== 'string' || !integer(copied.directGroups[entry.directGroup])) ||
        entry.metadata !== undefined && (!object(entry.metadata) || Buffer.byteLength(JSON.stringify(entry.metadata)) > 65536)) throw fail('CONNECTION_ADMISSION_PLAN_INVALID');
    const tag = applicationTag(copied, name);
    if (Buffer.byteLength(tag) > 63 || [...tags.values()].includes(tag)) throw fail('CONNECTION_ADMISSION_TAG_COLLISION');
    tags.set(name, tag);
  }
  if (Object.values(copied.directGroups).some(value => !integer(value))) throw fail('CONNECTION_ADMISSION_PLAN_INVALID');
  let coldGate;
  try { coldGate = require('../server/serve/cold-start-admission').create(copied.cold); } catch { throw fail('CONNECTION_ADMISSION_PLAN_INVALID'); }
  installed = { coldGate, plan: copied, tags, names: new Map(), configurations: new Map(), pools: new Set(), clients: new Set(), capabilityCounts: new Map(),
    groupCounts: new Map(Object.keys(copied.directGroups).map(name => [name, 0])), waiters: new Set(),
    frozen: false, cleanShutdown: false, failure: null, acknowledged: false, onState, onQuiescent, finalizing: null };
  const error = changed(installed); if (error) throw error;
  return Object.freeze({ beginQuiesce, finalizeQuiescence, health });
}
function beginQuiesce () {
  if (!installed) return;
  installed.frozen = true;
  installed.coldClosing = installed.coldGate.close();
  const error = changed(installed); if (error) throw error;
}
function finalizeQuiescence (cleanShutdown) {
  if (!installed) return Promise.resolve(null);
  const state = installed;
  if (cleanShutdown !== true) { state.cleanShutdown = false; state.failure = state.failure || fail('CONNECTION_ADMISSION_SHUTDOWN_UNCONFIRMED'); changed(state); return Promise.reject(state.failure); }
  state.cleanShutdown = true;
  if (!state.frozen) return Promise.reject(fail('CONNECTION_ADMISSION_NOT_FROZEN'));
  if (state.finalizing) return state.finalizing;
  state.finalizing = (async () => {
    await state.coldClosing;
    await waitFor(state, null, () => [...state.pools].every(row => row.retired) && [...state.clients].every(row => physicalClosed(row) && !row.uncertain));
    if (state.failure) throw state.failure;
    const proof = snapshot(state);
    try { await state.onQuiescent(proof); }
    catch (cause) { state.failure = Object.assign(fail('CONNECTION_ADMISSION_ACK_UNCONFIRMED'), { cause }); changed(state); throw state.failure; }
    if (state.failure) throw state.failure;
    state.acknowledged = true; return proof;
  })();
  return state.finalizing;
}
function coldAdmission () { return installed?.coldGate; }
function closeColdAdmission () { return installed ? installed.coldClosing || (installed.coldClosing = installed.coldGate.close()) : Promise.resolve(); }
function health () { return installed ? snapshot(installed) : null; }
// Assertion only: it neither starts a transaction nor grants query authority.
// Read protocol status from the private actual-driver record, never a caller
// marker or the public health/ACK wire. Fixed publication code checks server
// READ ONLY/epoch/role on this same backend separately.
function assertRecoveryTransaction (client) {
  const state = installed, row = records.get(client), control = state?.plan.control;
  if (!state || !row || row.state !== state || !(client instanceof require('pg').Client) ||
      state.plan.version !== 2 || state.plan.processInstanceId !== 'realtime-recovery' || control?.version !== 2 || control.class !== 'realtime-recovery' ||
      Object.keys(state.plan.capabilities).length !== 1 || Object.keys(state.plan.directGroups).length !== 0 || state.clients.size !== 1 ||
      row.capability !== 'realtime-recovery' || !row.pool || row.pool.maximum !== 1 ||
      row.pool.endRequested || row.pool.uncertain || state.frozen || state.failure ||
      !row.authenticated || !row.identityVerified || row.connectPending !== 0 ||
      row.endRequested || row.endSettled || row.actualEnded || row.retired || row.uncertain ||
      row.destroyObserved || row.peerEnded || row.transportFailed || row.protocolEnd ||
      row.readyStatus !== 'T' || !protocolReady(client, row) || client.pipeline === true || !idleClient(client) || row.stream !== client.connection?.stream ||
      row.stream.destroyed || row.stream.writable !== true) throw fail('CONNECTION_ADMISSION_RECOVERY_TRANSACTION_REQUIRED');
  return Object.freeze({ database: Object.freeze({ ...state.plan.workerDatabase }),
    source: Object.freeze({ ...state.plan.source }),
    resourceEpoch: Object.freeze(Array.isArray(control.resourceEpoch) ? [...control.resourceEpoch] : []),
    principal: Object.freeze({ ...control.principal }) });
}

module.exports = { coldAdmission, closeColdAdmission, applicationTag, install, poolOptions, wrapPool, wrapClient, assertRecoveryTransaction, beginQuiesce, finalizeQuiescence, health };
