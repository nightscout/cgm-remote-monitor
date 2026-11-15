'use strict';

// Explicit unselected operator capability. Registered tenants NEVER receive
// replacement key material. The two repair cases require retained provenance.
const { createHash } = require('node:crypto');
const { Pool } = require('pg');
const admission = require('../storage/connection-admission');
const rules = require('./rules');
const { parseSpec, createProvisioningState, HUMAN_KIDS, sameEnsureProfile, bindEnsureProfile, preKeyEnsureRefusal } = require('./provision');
const { createVaultKeys } = require('./vault-keys');
const shape = require('./ensure-shape');
const lock = require('./ensure-lock');
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const ACTOR = /^[A-Za-z0-9_-]{1,128}$/;
const KIDS = { access: 'key1', management: 'management1', 'human-data': HUMAN_KIDS.data, 'human-management': HUMAN_KIDS.management };
const q = name => '"' + name + '"';
const fail = code => Object.assign(new Error(code), { code });
const unselected = () => { if (admission.health() !== null) throw fail('TENANT_ENSURE_SELECTED_UNSUPPORTED'); };
const namespace = name => {
  if (!NAME.test(name || '') || name === 'public' || name.startsWith('pg_') || name === 'information_schema') throw new TypeError('Explicit ensure namespace required');
  return name;
};
function request (input, mode) {
  if (!shape.request(input)) throw fail('TENANT_ENSURE_INVALID');
  const spec = parseSpec({ id: input.id, hosts: input.hosts, ...(input.internalHost ? { internalHost: input.internalHost } : {}) }, { mode });
  rules.tenant(input.operationId);
  return { operationId: input.operationId, id: spec.id, hosts: spec.aliases, ...(spec.internal ? { internalHost: spec.internal } : {}) };
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function safeCode (error) {
  if (shape.result({ id: '11111111-1111-4111-8111-111111111111', operationId: '11111111-1111-4111-8111-111111111111', outcome: 'refused', code: error?.code, changed: [] })) return error.code;
  if (error?.code === 'TENANT_PROVISION_BUSY') return 'TENANT_ENSURE_BUSY';
  if (error?.code === 'TENANT_PROVISION_VAULT_KEY_MISMATCH') return 'TENANT_ENSURE_KEY_MISMATCH';
  if (/^(42|3F)[0-9A-Z]{3}$/.test(error?.code || '')) return 'TENANT_ENSURE_STORE_UNPREPARED';
  return 'TENANT_ENSURE_UNAVAILABLE';
}
function declarations (namespaces, ledgerNamespace, checkpoints) {
  const ns = Object.fromEntries(['registry','legacy','secrets','authorization','access','clock','control','settings','operatorPolicy'].map(k => [k, namespace(namespaces?.[k])]));
  const ledger = namespace(ledgerNamespace);
  if (new Set([...Object.values(ns), ledger]).size !== 10) throw new TypeError('Distinct ensure namespaces required');
  if (!Array.isArray(checkpoints) || checkpoints.length > 8 || checkpoints.some(r => !r || Object.keys(r).sort().join(',') !== 'consumer,digest,namespace' || !ACTOR.test(r.consumer || '') || !/^[a-f0-9]{64}$/.test(r.digest || ''))) throw new TypeError('Explicit ensure checkpoints required');
  checkpoints.forEach(r => namespace(r.namespace));
  return { ns, ledger };
}
function grants ({ namespaces, ledgerNamespace, checkpoints = [], role, dependencyNamespaces }) {
  if (!NAME.test(role || '')) throw new TypeError('Explicit ensure role required');
  const { ns, ledger } = declarations(namespaces, ledgerNamespace, checkpoints);
  const t = (kind, table) => q(ns[kind]) + '.' + q(table), who = q(role);
  const result = [...new Set([...Object.values(ns), ledger, ...checkpoints.map(r => namespace(r.namespace))])].map(n => 'GRANT USAGE ON SCHEMA ' + q(n) + ' TO ' + who);
  result.push(...require('./provision-residue').grantReads(ns,role));
  result.push(...require('./ensure-dependencies').grantReads(require('./ensure-dependencies').prepare(dependencyNamespaces,ns,ledger,checkpoints),role));
  for (const [kind, table] of [['legacy','legacy_data_keys'],['legacy','legacy_credential_config'],['secrets','secret_records'],['authorization','tenant_authorization_config'],['authorization','tenant_owner_policy'],['access','access_tenants'],['access','access_keys'],['clock','tenant_write_clock'],['control','tenant_activity'],['settings','tenant_settings'],['operatorPolicy','tenant_operator_policy']]) {
    result.push('GRANT SELECT (tenant_id' + (table === 'legacy_credential_config' ? ',root_reference_id,root_verifiers,verifier_root_reference_id' : table === 'legacy_data_keys' ? ',active,signing' : table === 'access_keys' ? ',kid,purpose' : '') + ') ON ' + t(kind, table) + ' TO ' + who);
  }
  for (const table of ['tenant_registry','tenant_registry_hosts','tenant_registry_keys']) result.push('GRANT SELECT ON ' + t('registry', table) + ' TO ' + who);
  for (const table of ['schema_migrations','tenant_lifecycle_windows','tenant_lifecycle_operations','tenant_lifecycle_requests','tenant_lifecycle_ceremony']) result.push('GRANT SELECT ON ' + t('control', table) + ' TO ' + who);
  result.push('GRANT SELECT ON ' + q(ledger) + '.schema_migrations TO ' + who,
    'GRANT SELECT ON ' + t('settings','schema_migrations') + ' TO ' + who,
    'GRANT SELECT ON ' + t('settings','tenant_settings_history') + ' TO ' + who,
    'GRANT SELECT ON ' + q(ledger) + '.tenant_ensure_events TO ' + who,
    'GRANT INSERT (tenant_id,operation_id,phase,request_digest,principal,consumer,result,observations,registered) ON ' + q(ledger) + '.tenant_ensure_events TO ' + who,
    'GRANT USAGE ON SEQUENCE ' + q(ledger) + '.tenant_ensure_events_event_number_seq TO ' + who,
    'GRANT INSERT (tenant_id,version,values) ON ' + t('settings','tenant_settings') + ' TO ' + who,
    'GRANT INSERT (tenant_id,purpose,kid,public_key) ON ' + t('registry','tenant_registry_keys') + ' TO ' + who);
  result.push('GRANT EXECUTE ON FUNCTION '+q(ns.settings)+'.tenant_settings_values_valid(jsonb) TO '+who);
  for (const row of checkpoints) result.push('GRANT SELECT (tenant_id,consumer) ON ' + q(namespace(row.namespace)) + '.tenant_consumer_checkpoint TO ' + who);
  return Object.freeze(result);
}
async function createEnsure ({ connectionString, namespaces, ledgerNamespace, checkpoints = [], actor, vault, mode = 'direct-alias', freshProvisioning, dependencyNamespaces } = {}) {
  unselected(); // before Pool, credential read or any other effect
  const { ns, ledger } = declarations(namespaces, ledgerNamespace, checkpoints);
  if (!actor || !ACTOR.test(actor.principal || '') || !ACTOR.test(actor.consumer || '') || !['direct-alias','canonical-internal'].includes(mode)) throw new TypeError('Explicit ensure actor and mode required');
  const t = (kind, table) => q(ns[kind]) + '.' + q(table), events = q(ledger) + '.tenant_ensure_events';
  const dependencies = require('./ensure-dependencies').prepare(dependencyNamespaces,ns,ledger,checkpoints);
  const keys = createVaultKeys(vault), state = createProvisioningState({ namespaces: ns, checkpoints, retainedByDependencies: true });
  const pool = new Pool({ ...require('../migrations/postgres-check').connectionOptions(connectionString), max: 1, connectionTimeoutMillis: 1000, query_timeout: 1000, statement_timeout: 5000, application_name: 'nightscout-admin-ensure' });
  require('../diagnostics/m7').observePool(pool,'storage');
  pool.on('error', () => {});
  let closed = false, running = false, binding;
  const makeResult = (input, outcome, code, changed = []) => ({ id: input.id, operationId: input.operationId, outcome, code, changed });
  const specOf = input => parseSpec({ id: input.id, hosts: input.hosts, ...(input.internalHost ? { internalHost: input.internalHost } : {}) }, { mode });
  async function begin (client, input) {
    await client.query('BEGIN');
    await client.query("SET LOCAL synchronous_commit = 'on'");
    await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [input.id]);
  }
  async function record (client, input, hash, phase, result, observations, registered) {
    await client.query('INSERT INTO ' + events + ' (tenant_id,operation_id,phase,request_digest,principal,consumer,result,observations,registered) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [input.id,input.operationId,phase,hash,actor.principal,actor.consumer,result ? JSON.stringify(result) : null,observations ? JSON.stringify(observations) : null,phase === 'result' ? registered : null]);
  }
  async function commit (client) {
    if (binding && !require('./ensure-datastore').same(binding,await require('./ensure-datastore').observe(client))) throw fail('TENANT_ENSURE_CONFLICT');
    const row = await client.query('COMMIT');
    if (row.command !== 'COMMIT') throw fail('TENANT_ENSURE_COMMIT_UNKNOWN');
  }
  async function observations (id, client) {
    const result = [];
    for (const [purpose, type] of Object.entries(rules.PURPOSES)) {
      const observed = await client.run(() => keys.observe(rules.vaultKey(id, purpose), type, client.check));
      if (!observed) throw fail('TENANT_ENSURE_DEPENDENCY_UNKNOWN');
      result.push({ purpose, ...(KIDS[purpose] ? { kid: KIDS[purpose] } : {}), ...observed });
    }
    return result;
  }
  async function repair (client, input, found) {
    if (found.state === 'removed') throw fail('TENANT_ENSURE_REMOVED');
    const decision = state.decide(specOf(input), found);
    if (decision?.code && decision.code !== 'TENANT_PROVISION_INCOMPLETE') throw fail('TENANT_ENSURE_CONFLICT');
    const phase = await require('../tenant-lifecycle/tenant-phase').tenantPhase(client, { namespace: ns.control, tenant: input.id, hold: true });
    if (!phase.active) throw fail('TENANT_ENSURE_LIFECYCLE_REFUSED');
    const window = (await client.query('SELECT lock_key::text AS key FROM ' + t('control','tenant_lifecycle_windows') + ' WHERE tenant_id=$1', [input.id])).rows;
    if (window.length !== 1 || window[0].key !== rules.lockKey(input.id)) throw fail('TENANT_ENSURE_LIFECYCLE_REFUSED');
    const pending = (await client.query('SELECT EXISTS(SELECT 1 FROM ' + t('control','tenant_lifecycle_operations') + ' WHERE tenant_id=$1 AND NOT finished) AS pending', [input.id])).rows[0];
    if (pending?.pending !== false) throw fail('TENANT_ENSURE_LIFECYCLE_REFUSED');
    await require('../operator-policy/fence')(client, input.id);
    for (const [name, held] of Object.entries(found.records)) {
      if (name === 'checkpoints') { if (held.some(r => !r.ok)) throw fail('TENANT_ENSURE_PROVENANCE_REQUIRED'); }
      else if (!['settings','registryKeys'].includes(name) && !held.ok) throw fail('TENANT_ENSURE_PROVENANCE_REQUIRED');
    }
    await require('./ensure-readiness').admit({ client, namespaces: ns, ledgerNamespace: ledger, checkpoints, dependencyNamespaces:dependencies?.mapping });
    const observed = await client.run(() => observations(input.id,client)), changed = [];
    const registered = (await client.query('SELECT purpose,kid,public_key FROM ' + t('registry','tenant_registry_keys') + " WHERE tenant_id=$1 AND (purpose,kid) IN (('access','key1'),('management','management1'),('human-data','human-data-1'),('human-management','human-management-1')) ORDER BY purpose,kid LIMIT 5", [input.id])).rows;
    const previous = (await client.query("SELECT CASE WHEN octet_length(observations::text)<=4096 THEN observations ELSE NULL END AS observations FROM " + events + " WHERE tenant_id=$1 AND phase='result' AND result->>'outcome' IN ('complete','created','repaired') ORDER BY event_number DESC LIMIT 1", [input.id])).rows;
    for (const row of observed.filter(r => r.publicKey)) {
      const current = registered.find(r => r.purpose === row.purpose && r.kid === KIDS[row.purpose]);
      if (current && current.public_key !== row.publicKey) throw fail('TENANT_ENSURE_KEY_MISMATCH');
      if (!current) {
        const proven = Array.isArray(previous[0]?.observations) && previous[0].observations.some(prior => prior.purpose === row.purpose && prior.kid === row.kid && prior.type === row.type && prior.version === row.version && prior.publicKey === row.publicKey);
        if (!proven) throw fail('TENANT_ENSURE_PROVENANCE_REQUIRED');
        await client.query('INSERT INTO ' + t('registry','tenant_registry_keys') + ' (tenant_id,purpose,kid,public_key) VALUES ($1,$2,$3,$4)', [input.id,row.purpose,KIDS[row.purpose],row.publicKey]);
        if (!changed.includes('registryKeys')) changed.push('registryKeys');
      }
    }
    if (!found.records.settings.ok) {
      const proof = (await client.query('SELECT count(*)::integer AS count,min(version)::integer AS first,max(version)::integer AS version FROM ' + t('settings','tenant_settings_history') + ' WHERE tenant_id=$1', [input.id])).rows[0];
      if (!proof || !Number.isSafeInteger(proof.count) || proof.count < 1 || proof.first !== 1 || proof.count !== proof.version) throw fail('TENANT_ENSURE_PROVENANCE_REQUIRED');
      // Scalar completeness over the indexed tenant history, then ONE bounded
      // highest value. Never return all prior settings rows or all values.
      const history = (await client.query('SELECT version,CASE WHEN octet_length(values::text)<=1048576 THEN values ELSE NULL END AS values FROM ' + t('settings','tenant_settings_history') + ' WHERE tenant_id=$1 AND version=$2 LIMIT 2', [input.id,proof.version])).rows;
      if (history.length !== 1 || history[0].version !== proof.version || !history[0].values) throw fail('TENANT_ENSURE_PROVENANCE_REQUIRED');
      const latest = history[0];
      try {
        if (!require('node:util').isDeepStrictEqual(require('../tenant-settings/catalogue').normalize(latest.values),latest.values)) throw Error('noncanonical');
      } catch { throw fail('TENANT_ENSURE_PROVENANCE_REQUIRED'); }
      await client.query('INSERT INTO ' + t('settings','tenant_settings') + ' (tenant_id,version,values) VALUES ($1,$2,$3)', [input.id,latest.version,JSON.stringify(latest.values)]);
      changed.push('settings');
    }
    // Recheck all actual structural predicates in the SAME transaction.
    if (!((await state.current(client, specOf(input))).complete)) throw fail('TENANT_ENSURE_PROVENANCE_REQUIRED');
    return { observed, changed };
  }
  async function ensure (raw) {
    unselected();
    if (closed) throw fail('TENANT_ENSURE_UNAVAILABLE');
    let input;
    try { input = request(raw, mode); } catch { throw fail('TENANT_ENSURE_INVALID'); }
    if (running) return makeResult(input,'refused','TENANT_ENSURE_BUSY');
    running = true;
    const hash = digest(input);
    let client, failure, locked = false, inTransaction = false, requested = false, replayedIntent, mutating = false, registered = false;
    try {
      client = await require('./held-client').checkout(pool); await lock.acquire(client, ns.registry, input.id); locked = true;
      await begin(client,input); inTransaction = true;
      if (!require('./ensure-datastore').same(binding,await require('./ensure-datastore').observe(client))) throw fail('TENANT_ENSURE_CONFLICT');
      const prior = (await client.query('SELECT phase,request_digest,CASE WHEN octet_length(result::text)<=4096 THEN result ELSE NULL END AS result FROM ' + events + ' WHERE tenant_id=$1 AND operation_id=$2 ORDER BY phase LIMIT 3', [input.id,input.operationId])).rows;
      if (prior.length > 2) throw fail('TENANT_ENSURE_STORE_UNPREPARED');
      if (prior.some(r => r.request_digest !== hash)) throw fail('TENANT_ENSURE_CONFLICT');
      const done = prior.find(r => r.phase === 'result');
      if (done) {
        if (!shape.result(done.result) || done.result.id !== input.id || done.result.operationId !== input.operationId) throw fail('TENANT_ENSURE_STORE_UNPREPARED');
        await commit(client); inTransaction = false; return done.result;
      }
      requested = prior.some(r => r.phase === 'requested'); replayedIntent = requested;
      if (!requested) await record(client,input,hash,'requested');
      // Intent survives a crash before Vault or a transaction result becomes known.
      await commit(client); inTransaction = false; requested = true;
      await begin(client,input); inTransaction = true;
      let found = await state.current(client,specOf(input)), created = false; registered = !!found.state;
      if (!found.state) {
        // A prior unresolved intent may have dispatched Vault writes. Never
        // replay key birth, including with a different operation identifier.
        const unresolved = (await client.query("SELECT EXISTS(SELECT 1 FROM " + events + " r WHERE r.tenant_id=$1 AND r.phase='requested' AND r.operation_id<>$2 AND NOT EXISTS(SELECT 1 FROM " + events + " d WHERE d.tenant_id=r.tenant_id AND d.operation_id=r.operation_id AND d.phase='result') LIMIT 1) AS unresolved",[input.id,input.operationId])).rows[0];
        if (replayedIntent || unresolved?.unresolved !== false) throw fail('TENANT_ENSURE_COMMIT_UNKNOWN');
        if (found.unregistered || state.decide(specOf(input),found)) throw fail('TENANT_ENSURE_PROVENANCE_REQUIRED');
        if (!sameEnsureProfile(freshProvisioning,dependencies)) throw fail('TENANT_ENSURE_FRESH_UNAVAILABLE');
        // Release the NEW shared key-birth fence: the actual provisioning entry
        // takes it itself, rechecks the full predicate and owns its one client.
        await commit(client); inTransaction = false;
        await lock.release(client,ns.registry,input.id); locked = false;
        mutating = true;
        const fresh = await client.run(() => freshProvisioning.provision({ id: input.id, hosts: input.hosts, ...(input.internalHost ? { internalHost: input.internalHost } : {}) }));
        if (!['created','existing'].includes(fresh.outcome)) {
          const known = {TENANT_PROVISION_INCOMPLETE:'TENANT_ENSURE_PROVENANCE_REQUIRED',TENANT_PROVISION_DEPENDENCIES_UNPREPARED:'TENANT_ENSURE_FRESH_UNAVAILABLE',TENANT_PROVISION_BUSY:'TENANT_ENSURE_BUSY',TENANT_PROVISION_DATASTORE_CHANGED:'TENANT_ENSURE_CONFLICT'};
          if (known[fresh.code] && preKeyEnsureRefusal(freshProvisioning,fresh)) {
            mutating = false;
            await lock.acquire(client,ns.registry,input.id); locked = true;
            await begin(client,input); inTransaction = true;
            throw fail(known[fresh.code]);
          }
          throw fail('TENANT_ENSURE_UNAVAILABLE');
        }
        created = fresh.outcome === 'created'; mutating = false;
        await lock.acquire(client,ns.registry,input.id); locked = true;
        await begin(client,input); inTransaction = true;
        found = await state.current(client,specOf(input));
        if (!found.state) throw fail('TENANT_ENSURE_UNAVAILABLE');
        registered = true;
      }
      mutating = true;
      const { observed, changed } = await repair(client,input,found);
      const result = makeResult(input,created ? 'created' : changed.length ? 'repaired' : 'complete','TENANT_ENSURE_OK',changed);
      await record(client,input,hash,'result',result,observed,registered);
      await commit(client); inTransaction = false; mutating = false;
      return result;
    } catch (error) {
      failure = error;
      // No queued ROLLBACK/unlock behind a timed-out query. Failed release asks
      // the real driver to evict; it makes no server-retirement/credit claim.
      const code = safeCode(error);
      const conclusive = /^TENANT_ENSURE_(BUSY|CONFLICT|DEPENDENCY_UNKNOWN|KEY_MISMATCH|PROVENANCE_REQUIRED|LIFECYCLE_REFUSED|FRESH_UNAVAILABLE|REMOVED|STORE_UNPREPARED)$/.test(error?.code || '') || error?.code === 'TENANT_PROVISION_VAULT_KEY_MISMATCH';
      if (client && locked && inTransaction && conclusive) {
        try {
          const rolled = await client.query('ROLLBACK');
          if (rolled.command !== 'ROLLBACK') throw fail('TENANT_ENSURE_COMMIT_UNKNOWN');
          inTransaction = false; mutating = false;
          const result = makeResult(input,'refused',code);
          if (requested) {
            await begin(client,input); inTransaction = true;
            await record(client,input,hash,'result',result,undefined,registered);
            await commit(client); inTransaction = false;
          }
          failure = null;
          return result;
        } catch { return makeResult(input,'unknown','TENANT_ENSURE_COMMIT_UNKNOWN'); }
      }
      if (inTransaction || mutating) return makeResult(input,'unknown',mutating ? 'TENANT_ENSURE_COMMIT_UNKNOWN' : code);
      return makeResult(input,'refused',code);
    } finally {
      try { if (client) await lock.finish(client,ns.registry,input.id,locked,failure); }
      finally { running = false; }
    }
  }
  try {
    const client = await require('./held-client').checkout(pool); let failure;
    try {
      await require('./ensure-readiness')({ client, namespaces: ns, ledgerNamespace: ledger, checkpoints, dependencyNamespaces:dependencies?.mapping });
      binding = await require('./ensure-datastore').observe(client);
      if (dependencies && freshProvisioning) await bindEnsureProfile(freshProvisioning,dependencies,client);
    }
    catch (error) { failure = error; throw fail('TENANT_ENSURE_STORE_UNPREPARED'); }
    finally { client.release(failure); }
  } catch (error) { await pool.end(); throw error; }
  return Object.freeze({ ensure, close: async () => { closed = true; await pool.end(); } });
}
module.exports = { createEnsure, grants, request };
