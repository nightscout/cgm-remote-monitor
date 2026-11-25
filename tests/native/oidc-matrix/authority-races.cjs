'use strict';

// Prepared native instrument. Import/admission never creates a connection.
// Native assertions and semantic mutants require the lead's later grant.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const NS = /^[a-z][a-z0-9_]{0,62}$/;
const PREFIX = '/__authority_project';
const API = '/api/v2/authorization';
const READ = 'api:entries:read';
const CREATE = 'api:entries:create';
const q = value => '"' + value.replaceAll('"', '""') + '"';
const fail = code => Object.assign(new Error(code), { code });

function admit (context) {
  const c = context || {}, env = c.env || {};
  if (env.HUMAN_SESSION_NATIVE_RESERVED !== '1' ||
      env.HUMAN_HTTPS_RESERVED !== '1' || c.binding?.persistence !== 'postgres' ||
      c.binding?.signing !== 'configured-transit' || c.nativeStore?.kind !== 'postgres' ||
      !UUID.test(c.tenant || '') || c.nativeStore.tenant !== c.tenant ||
      !NAME.test(c.nativeStore.subject || '') || !/^[a-f0-9]{16,32}$/.test(c.config?.nonce || '') ||
      !Array.isArray(c.config?.tenants) || c.config.tenants.length !== 2 ||
      c.config.tenants[0] !== c.tenant || new Set(c.config.tenants).size !== 2 ||
      c.config.tenants.some(value => !UUID.test(value)) || typeof c.req !== 'function' ||
      typeof c.admin?.query !== 'function' || typeof c.services?.authenticateManagement !== 'function' ||
      c.services.authenticateManagement.human !== true || typeof c.services?.subjects?.update !== 'function' ||
      typeof c.services?.issuer?.issueCredential !== 'function' || !NAME.test(c.parsed?.consumer || '')) {
    throw fail('AUTHORITY_NATIVE_EXPLICIT_BINDING_REQUIRED');
  }
  if (JSON.stringify(c.parsed.ownerPolicy?.catalogue) !== '["*"]' ||
      JSON.stringify(c.config.fixturePolicy?.ceiling) !== '["*"]' ||
      JSON.stringify(c.config.fixturePolicy?.delegable) !== '["*"]') throw fail('AUTHORITY_NATIVE_EXPLICIT_FULL_FIXTURE_REQUIRED');
  const namespaces = [c.parsed.namespaces?.authorization, c.parsed.namespaces?.credentials,
    c.parsed.ownerSettings?.namespaces?.settings, c.parsed.ownerCredentials?.namespace];
  if (namespaces.some(value => typeof value !== 'string' || !NS.test(value)) ||
      namespaces.slice(1).some(value => !value.startsWith('oc_' + c.config.nonce + '_')) ||
      c.parsed.namespaces.authorization !== c.nativeStore.resources?.authority ||
      !/^hh_authority_[a-f0-9]{16}$/.test(c.nativeStore.resources.authority) ||
      c.config.adminConnectionEnv !== 'HUMAN_SESSION_PG_ADMIN_URL' || !env[c.config.adminConnectionEnv]) {
    throw fail('AUTHORITY_NATIVE_OWNERSHIP_REQUIRED');
  }
  let address;
  try { address = new URL(env[c.config.adminConnectionEnv]); } catch { throw fail('AUTHORITY_NATIVE_DATASTORE_REQUIRED'); }
  if (!['postgres:', 'postgresql:'].includes(address.protocol) || address.hostname !== '127.0.0.1' ||
      !address.port || ['5432', '18080', '18081', '18082'].includes(address.port) ||
      address.pathname !== '/owner_oidc_' + c.config.nonce || !address.username || !address.password) {
    throw fail('AUTHORITY_NATIVE_DATASTORE_REQUIRED');
  }
  return true;
}

function assertNoEffects (before, after) {
  assert.deepEqual(after, before, 'AUTHORITY_REFUSAL_MUST_PRESERVE_OWNER_EFFECTS');
}

function assertRefusal (reply, status) {
  assert.equal(reply.status, status, 'AUTHORITY_REQUEST_MUST_REFUSE');
  assert.deepEqual(Object.keys(reply.body).sort(), ['error'], 'AUTHORITY_REFUSAL_MUST_NOT_RETURN_CREDENTIAL');
}

function assertCommitWitness (before, after) {
  assert.equal(before?.is_called, false, 'AUTHORITY_COMMIT_WITNESS_MUST_START_UNUSED');
  assert.equal(after?.is_called, true, 'AUTHORITY_DEFERRED_COMMIT_TRIGGER_MUST_EXECUTE');
  assert.equal(String(after.last_value), '1', 'AUTHORITY_COMMIT_TRIGGER_MUST_EXECUTE_ONCE');
}

function assertWaiterRows (rows, { blocker, waiter, relation }) {
  assert.ok(Array.isArray(rows), 'AUTHORITY_WAITER_ROWS_REQUIRED');
  const found = rows.find(row => Number.isSafeInteger(row.pid) && row.pid > 0 &&
    (waiter === undefined || row.pid === waiter) && Array.isArray(row.blockers) && row.blockers.includes(blocker) &&
    row.wait_event_type === 'Lock' && typeof row.query === 'string' && row.query.includes(relation));
  assert.ok(found, 'AUTHORITY_CAUSAL_NATIVE_WAITER_REQUIRED');
  return found.pid;
}

async function waitForWaiter (admin, expected, { durationMs = 2000, now = () => performance.now() } = {}) {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 2000) throw fail('AUTHORITY_WAITER_BOUND_REQUIRED');
  const end = now() + durationMs;
  do {
    const rows = (await admin.query(`SELECT pid,query,wait_event_type,pg_blocking_pids(pid) AS blockers
      FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
      AND $1=ANY(pg_blocking_pids(pid))`, [expected.blocker])).rows;
    if (rows.some(row => row.wait_event_type === 'Lock' && row.query?.includes(expected.relation) &&
        (expected.waiter === undefined || row.pid === expected.waiter))) return assertWaiterRows(rows, expected);
    if (now() >= end) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  } while (now() < end);
  throw fail('AUTHORITY_CAUSAL_NATIVE_WAITER_REQUIRED');
}

async function settleRaceResources (closers, pending, restore, primary) {
  const errors = [];
  for (const close of closers) { try { await close(); } catch (error) { errors.push(error); } }
  await Promise.allSettled(pending.filter(Boolean));
  try { await restore(); } catch (error) { errors.push(error); }
  if (errors.length) throw new globalThis.AggregateError(primary ? [primary, ...errors] : errors, 'AUTHORITY_RACE_AND_CLEANUP_FAILED');
  if (primary) throw primary;
}

async function create (context) {
  admit(context);
  const c = context, { req, admin, parsed, nativeStore, tenant, config } = c;
  const ns = parsed.namespaces.authorization, credential = parsed.namespaces.credentials;
  const table = (schema, name) => q(schema) + '.' + name;
  const tables = {
    subjects: table(ns, 'tenant_authorization_subjects'), roles: table(ns, 'tenant_authorization_roles'),
    links: table(ns, 'tenant_authorization_subject_roles'), audit: table(ns, 'tenant_subject_admin_audit'),
    metadata: table(credential, 'legacy_credential_subjects'), policy: table(ns, 'tenant_owner_policy'),
    actors: table(ns, 'tenant_owner_actors'), settings: table(parsed.ownerSettings.namespaces.settings, 'tenant_settings'),
    history: table(parsed.ownerSettings.namespaces.settings, 'tenant_settings_history'),
    secretAudit: table(parsed.ownerCredentials.namespace, 'secret_audit')
  };
  const { catalogueDigest } = req('./lib/subject-admin/owner-policy');
  const project = [READ];
  const resources = [], clients = new Set(), objects = [], custody = { clients: [], objects: [] };
  const clientRecords = new WeakMap();
  let closing;
  async function close () {
    if (!closing) closing = (async () => {
      const errors = [];
      for (const client of clients) { try { await client.query('ROLLBACK'); } catch (error) { errors.push(error); } try { await client.end(); } catch (error) { errors.push(error); } }
      clients.clear();
      for (const resource of resources.slice().reverse()) { try { await resource.close(); } catch (error) { errors.push(error); } }
      for (const object of objects.slice().reverse()) { try { await object.close(); } catch (error) { errors.push(error); } }
      if (errors.length) throw fail('AUTHORITY_NATIVE_CLOSE_FAILED');
    })();
    return closing;
  }
  try {
    const narrow = await req('./lib/subject-admin/postgres')({ connectionString: parsed.writerConnectionString,
      namespace: ns, credentialNamespace: credential, ownerPolicy: { catalogue: project } });
    resources.push(narrow);
    const service = req('./lib/subject-admin/component').createSubjectAdmin({ store: narrow,
      issueCredential: c.services.issuer.issueCredential, authorizeManagement: async actor => actor.consumer === parsed.consumer });
    const narrowApp = req('./lib/server/subject-management-app').createSubjectManagementApp({ resolver: parsed.resolver,
      authenticateManagement: c.services.authenticateManagement, subjectAdmin: service });
    const router = req('express').Router(); router.use(PREFIX, narrowApp);

    async function capture (id, { includeRoles = true, includeSecretAudit = false } = {}) {
      const result = {};
      for (const name of ['subjects', ...(includeRoles ? ['roles'] : []), 'links', 'metadata', 'audit', 'settings', 'history',
        ...(includeSecretAudit ? ['secretAudit'] : [])]) {
        result[name] = (await admin.query('SELECT to_jsonb(t) AS value FROM ' + tables[name] +
          ' t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text', [id])).rows.map(row => row.value);
      }
      return result;
    }
    async function open () {
      if (clients.size >= 2) throw fail('AUTHORITY_NATIVE_CLIENT_LIMIT');
      const { Client } = req('pg');
      const client = new Client({ connectionString: c.env[config.adminConnectionEnv], connectionTimeoutMillis: 1000,
        statement_timeout: 2500, query_timeout: 3000, idle_in_transaction_session_timeout: 5000,
        application_name: 'owner-authority-control' });
      clients.add(client);
      try {
        await client.connect();
        const identity = (await client.query("SELECT pg_backend_pid() AS pid,current_user AS role,extract(epoch FROM backend_start)::text AS birth FROM pg_stat_activity WHERE pid=pg_backend_pid()")).rows[0];
        assert.ok(identity && Number.isSafeInteger(identity.pid) && identity.pid === client.processID &&
          typeof identity.role === 'string' && typeof identity.birth === 'string', 'AUTHORITY_BACKEND_IDENTITY_REQUIRED');
        const record = { ...identity, closeAcknowledged: false }; custody.clients.push(record); clientRecords.set(client, record);
        return client;
      } catch (error) { clients.delete(client); await client.end().catch(() => {}); throw error; }
    }
    async function endClient (client) {
      if (!client) return;
      try { await client.query('ROLLBACK'); } finally {
        await client.end(); const record = clientRecords.get(client); if (record) record.closeAcknowledged = true;
        clients.delete(client);
      }
    }
    async function ownedObject (kind, name, relation, createSql, dropSql) {
      const identity = async () => {
        const sql = kind === 'constraint' ? 'SELECT oid FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2'
          : kind === 'trigger' ? 'SELECT oid FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2'
            : kind === 'function' ? 'SELECT to_regprocedure($1)::oid AS oid' : 'SELECT to_regclass($1)::oid AS oid';
        return (await admin.query(sql, ['function', 'sequence'].includes(kind) ? [name] : [relation, name])).rows[0]?.oid;
      };
      if (await identity()) throw fail('AUTHORITY_NATIVE_OBJECT_ALREADY_EXISTS');
      await admin.query(createSql);
      const oid = await identity();
      if (!oid) throw fail('AUTHORITY_NATIVE_OBJECT_CREATE_UNCONFIRMED');
      const record = { kind, name, relation, oid: String(oid), dropAcknowledged: false }; custody.objects.push(record);
      let removed = false;
      const object = { async close () {
        if (removed) return;
        if (String(await identity()) !== String(oid)) throw fail('AUTHORITY_NATIVE_OBJECT_OWNERSHIP_CHANGED');
        await admin.query(dropSql); removed = true; record.dropAcknowledged = true;
      } };
      objects.push(object); return object;
    }
    async function exercise ({ transport, site, login, check }) {
      const operator = (await admin.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
      assert.ok(operator && (operator.rolsuper === true || operator.rolbypassrls === true),
        'AUTHORITY_INDEPENDENT_UNBOUND_OPERATOR_REQUIRED');
      const results = [], original = {
        policy: (await admin.query('SELECT catalogue_digest,ceiling FROM ' + tables.policy + ' WHERE tenant_id=$1', [tenant])).rows[0],
        actor: (await admin.query('SELECT active,can_update,delegable FROM ' + tables.actors +
          ' WHERE tenant_id=$1 AND principal=$2 AND consumer=$3', [tenant, nativeStore.subject, parsed.consumer])).rows[0]
      };
      assert.ok(original.policy && original.actor, 'AUTHORITY_CURRENT_PROVISIONED_ROWS_REQUIRED');
      const foreign = await capture(config.tenants[1], { includeSecretAudit: true });
      for (const name of ['subjects', 'roles', 'links', 'metadata', 'audit', 'settings', 'history']) {
        assert.ok(foreign[name].length > 0, 'AUTHORITY_NONEMPTY_B_REQUIRED:' + name);
      }
      const response = await login('bearer', 'management'); assert.equal(response.status, 200);
      const token = (await response.json()).token;
      async function request (method, route, body, prefix = '') {
        const response = await transport(site + prefix + route, { method, headers: {
          authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' })
        }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json() };
      }
      async function resetAuthority ({ catalogue = parsed.ownerPolicy.catalogue, ceiling = ['*'], delegation = ['*'], active = true, canUpdate = true } = {}) {
        await admin.query('UPDATE ' + tables.policy + ' SET catalogue_digest=$2,ceiling=$3 WHERE tenant_id=$1',
          [tenant, catalogueDigest(catalogue), ceiling]);
        await admin.query('UPDATE ' + tables.actors + ' SET active=$4,can_update=$5,delegable=$6 WHERE tenant_id=$1 AND principal=$2 AND consumer=$3',
          [tenant, nativeStore.subject, parsed.consumer, active, canUpdate, delegation]);
      }
      async function restoreOriginal () {
        await admin.query('UPDATE ' + tables.policy + ' SET catalogue_digest=$2,ceiling=$3 WHERE tenant_id=$1',
          [tenant, original.policy.catalogue_digest, original.policy.ceiling]);
        await admin.query('UPDATE ' + tables.actors + ' SET active=$4,can_update=$5,delegable=$6 WHERE tenant_id=$1 AND principal=$2 AND consumer=$3',
          [tenant, nativeStore.subject, parsed.consumer, original.actor.active, original.actor.can_update, original.actor.delegable]);
      }
      const role = 'ar_' + config.nonce, rolePath = API + '/roles', subjectPath = API + '/subjects';
      let subject;
      async function setRole () { await admin.query('UPDATE ' + tables.roles + ' SET permissions=$3 WHERE tenant_id=$1 AND name=$2', [tenant, role, [READ]]); }
      async function resetRace () { await resetAuthority({ ceiling: [READ], delegation: [READ] }); await setRole(); }
      const proposal = name => ({ _id: subject, name, roles: [role] });
      const changes = [
        { name: 'policy', relation: 'tenant_owner_policy', sql: 'UPDATE ' + tables.policy + ' SET ceiling=ARRAY[]::text[] WHERE tenant_id=$1', args: [tenant] },
        { name: 'delegation', relation: 'tenant_owner_actors', sql: 'UPDATE ' + tables.actors + ' SET delegable=ARRAY[]::text[] WHERE tenant_id=$1 AND principal=$2 AND consumer=$3', args: [tenant, nativeStore.subject, parsed.consumer] },
        { name: 'actor', relation: 'tenant_owner_actors', sql: 'UPDATE ' + tables.actors + ' SET active=false WHERE tenant_id=$1 AND principal=$2 AND consumer=$3', args: [tenant, nativeStore.subject, parsed.consumer] },
        { name: 'role', relation: 'tenant_authorization_roles', sql: 'UPDATE ' + tables.roles + ' SET permissions=$3 WHERE tenant_id=$1 AND name=$2', args: [tenant, role, [CREATE]] }
      ];
      async function assertNarrowed (change) {
        if (change.name === 'policy') {
          const row = (await admin.query('SELECT ceiling FROM ' + tables.policy + ' WHERE tenant_id=$1', [tenant])).rows[0];
          assert.deepEqual(row?.ceiling, [], 'AUTHORITY_NARROWED_POLICY_MUST_PERSIST');
        } else if (change.name === 'role') {
          const row = (await admin.query('SELECT permissions FROM ' + tables.roles + ' WHERE tenant_id=$1 AND name=$2', [tenant, role])).rows[0];
          assert.deepEqual(row?.permissions, [CREATE], 'AUTHORITY_NARROWED_ROLE_MUST_PERSIST');
          const grants = req('shiro-trie').new().add(row.permissions);
          assert.equal(grants.check(READ), false, 'AUTHORITY_OLD_EFFECTIVE_GRANT_MUST_BE_GONE');
          assert.equal(grants.check(CREATE), true, 'AUTHORITY_CURRENT_EFFECTIVE_GRANT_REQUIRED');
        } else {
          const row = (await admin.query('SELECT active,delegable FROM ' + tables.actors +
            ' WHERE tenant_id=$1 AND principal=$2 AND consumer=$3', [tenant, nativeStore.subject, parsed.consumer])).rows[0];
          if (change.name === 'actor') assert.equal(row?.active, false, 'AUTHORITY_DEACTIVATION_MUST_PERSIST');
          else assert.deepEqual(row?.delegable, [], 'AUTHORITY_NARROWED_DELEGATION_MUST_PERSIST');
        }
      }
      try {
        await resetAuthority();
        const grammar = [
          ['star', '*', 'api:entries:update'], ['comma', 'api:entries:read,create', 'api:entries:create'],
          ['prefix', 'api:entries', 'api:entries:read:extension'], ['extension', 'api:entries:read:extension', 'api:entries:read:extension:child']
        ];
        for (const [suffix, permission, demand] of grammar) {
          const name = role + '_' + suffix;
          check((await request('POST', rolePath, { name, permissions: [permission] })).status, 200);
          const stored = (await admin.query('SELECT permissions FROM ' + tables.roles + ' WHERE tenant_id=$1 AND name=$2', [tenant, name])).rows[0];
          assert.deepEqual(stored.permissions, [permission]);
          assert.equal(req('shiro-trie').new().add(stored.permissions).check(demand), true, 'AUTHORITY_SHIPPING_GRAMMAR_REQUIRED');
        }
        results.push('shipping-grammar');
        for (const bound of ['project', 'operator', 'delegation']) {
          await resetAuthority({ catalogue: bound === 'project' ? project : parsed.ownerPolicy.catalogue,
            ceiling: bound === 'operator' ? [READ] : ['*'], delegation: bound === 'delegation' ? [READ] : ['*'] });
          const before = await capture(tenant);
          assertRefusal(await request('POST', rolePath, { name: role + '_deny_' + bound, permissions: ['*'] }, bound === 'project' ? PREFIX : ''), 403);
          assertNoEffects(before, await capture(tenant));
          check((await request('POST', rolePath, { name: role + '_allowed_' + bound, permissions: [READ] }, bound === 'project' ? PREFIX : '')).status, 200);
          results.push(bound + '-containment');
        }
        for (const mode of ['inactive', 'not-management']) {
          await resetAuthority({ active: mode !== 'inactive', canUpdate: mode !== 'not-management' });
          const before = await capture(tenant);
          assertRefusal(await request('POST', rolePath, { name: role + '_deny_' + mode, permissions: [READ] }), 403);
          assertNoEffects(before, await capture(tenant));
          await resetAuthority();
          check((await request('POST', rolePath, { name: role + '_restored_' + mode, permissions: [READ] })).status, 200);
        }
        results.push('current-actor');
        await resetAuthority();
        check((await request('POST', rolePath, { name: role, permissions: [READ] })).status, 200);
        const created = await request('POST', subjectPath, { name: 'Authority race subject', roles: [role] });
        check(created.status, 200); subject = created.body.subjectId; assert.ok(typeof subject === 'string' && NAME.test(subject));
        for (const change of changes) {
          await resetRace();
          const before = await capture(tenant, { includeRoles: false });
          const holder = await open(); let pending, primary;
          try {
            await holder.query('BEGIN');
            const changed = await holder.query(change.sql + ' RETURNING tenant_id', change.args);
            assert.equal(changed.rowCount, 1, 'AUTHORITY_INTENDED_NARROWING_REQUIRED');
            pending = request('PUT', subjectPath, proposal('Denied after ' + change.name)); pending.catch(() => {});
            await waitForWaiter(admin, { blocker: holder.processID, relation: change.relation });
            assertNoEffects(before, await capture(tenant, { includeRoles: false }));
            await holder.query('COMMIT');
            await assertNarrowed(change);
            assertRefusal(await pending, 403);
            assertNoEffects(before, await capture(tenant, { includeRoles: false }));
            await resetRace();
            check((await request('PUT', subjectPath, proposal('Restored after ' + change.name))).status, 200);
            results.push('prior-' + change.name + '-waiter');
          } catch (error) { primary = error; }
          finally { await settleRaceResources([() => endClient(holder)], [pending], resetRace, primary); }
        }
        for (const change of changes) {
          await resetRace();
          const before = await capture(tenant, { includeRoles: false });
          const holder = await open(), narrower = await open(); let pending, narrowing, primary;
          try {
            await holder.query('BEGIN');
            await holder.query('SELECT subject_id FROM ' + tables.subjects + ' WHERE tenant_id=$1 AND subject_id=$2 FOR UPDATE', [tenant, subject]);
            pending = request('PUT', subjectPath, proposal('Held through ' + change.name)); pending.catch(() => {});
            const ownerPid = await waitForWaiter(admin, { blocker: holder.processID, relation: 'tenant_authorization_subjects' });
            await narrower.query('BEGIN');
            narrowing = narrower.query(change.sql + ' RETURNING tenant_id', change.args); narrowing.catch(() => {});
            await waitForWaiter(admin, { blocker: ownerPid, waiter: narrower.processID, relation: change.relation });
            assertNoEffects(before, await capture(tenant, { includeRoles: false }));
            await holder.query('COMMIT');
            check((await pending).status, 200);
            assert.equal((await narrowing).rowCount, 1);
            const committed = await capture(tenant, { includeRoles: false });
            assert.equal(committed.subjects.find(row => row.subject_id === subject).display_name, 'Held through ' + change.name);
            assert.equal(committed.audit.length, before.audit.length + 1);
            await narrower.query('COMMIT');
            await assertNarrowed(change);
            assertRefusal(await request('PUT', subjectPath, proposal('Must stay denied')), 403);
            assertNoEffects(committed, await capture(tenant, { includeRoles: false }));
            await resetRace();
            check((await request('PUT', subjectPath, proposal('Restored held ' + change.name))).status, 200);
            results.push('held-' + change.name + '-through-commit');
          } catch (error) { primary = error; }
          finally { await settleRaceResources([() => endClient(holder), () => endClient(narrower)], [pending, narrowing], resetRace, primary); }
        }
        await resetRace();
        async function liveIssuance () {
          const reply = await request('POST', subjectPath + '/' + subject + '/credential', {});
          assert.equal(reply.status, 200, 'AUTHORITY_LIVE_ISSUER_REQUIRED');
          assert.ok(typeof reply.body.token === 'string' && /^[a-z0-9_]{0,10}-[a-f0-9]{16}$/.test(reply.body.token),
            'AUTHORITY_LIVE_ISSUER_MUST_RETURN_SYNTHETIC_LEGACY_CREDENTIAL');
        }
        for (const [name, relation, operation] of [['owner-audit', tables.audit, 'issue'], ['secret-audit', tables.secretAudit, 'issue-legacy']]) {
          await liveIssuance();
          const constraintName = 'ar_' + config.nonce + '_' + name.replace('-', '_');
          const constraint = await ownedObject('constraint', constraintName, relation,
            'ALTER TABLE ' + relation + ' ADD CONSTRAINT ' + q(constraintName) + " CHECK (operation <> '" + operation + "') NOT VALID",
            'ALTER TABLE ' + relation + ' DROP CONSTRAINT ' + q(constraintName));
          try {
            const before = await capture(tenant, { includeSecretAudit: true });
            assertRefusal(await request('POST', subjectPath + '/' + subject + '/credential', {}), 503);
            assertNoEffects(before, await capture(tenant, { includeSecretAudit: true }));
          } finally { await constraint.close(); }
          await liveIssuance();
          results.push(name + '-refusal');
        }
        const functionName = 'ar_' + config.nonce + '_commit';
        const sequenceRef = q(ns) + '.' + q('ar_' + config.nonce + '_commit_witness');
        const witness = await ownedObject('sequence', sequenceRef, null,
          'CREATE SEQUENCE ' + sequenceRef + ' START WITH 1', 'DROP SEQUENCE ' + sequenceRef);
        // Deferred trigger runs as the least-privilege owner writer. Grant only
        // this new test witness sequence, never authority-table mutation rights.
        await admin.query('GRANT USAGE ON SEQUENCE ' + sequenceRef + ' TO ' +
          q(decodeURIComponent(new URL(parsed.writerConnectionString).username)));
        const functionRef = q(ns) + '.' + q(functionName) + '()';
        const fn = await ownedObject('function', functionRef, null,
          'CREATE FUNCTION ' + functionRef + " RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('" + sequenceRef + "'::regclass); RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='synthetic owner commit refusal'; END; $$",
          'DROP FUNCTION ' + functionRef);
        const triggerName = 'ar_' + config.nonce + '_commit';
        const trigger = await ownedObject('trigger', triggerName, tables.audit,
          'CREATE CONSTRAINT TRIGGER ' + q(triggerName) + ' AFTER INSERT ON ' + tables.audit +
          " DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.operation='issue') EXECUTE FUNCTION " + functionRef,
          'DROP TRIGGER ' + q(triggerName) + ' ON ' + tables.audit);
        try {
          const before = await capture(tenant), receipts = await capture(tenant, { includeSecretAudit: true });
          const beforeWitness = (await admin.query('SELECT last_value,is_called FROM ' + sequenceRef)).rows[0];
          assertRefusal(await request('POST', subjectPath + '/' + subject + '/credential', {}), 503);
          assertCommitWitness(beforeWitness, (await admin.query('SELECT last_value,is_called FROM ' + sequenceRef)).rows[0]);
          assertNoEffects(before, await capture(tenant));
          const after = await capture(tenant, { includeSecretAudit: true });
          assert.equal(after.secretAudit.length, receipts.secretAudit.length + 1, 'AUTHORITY_COMMIT_REFUSAL_RETAINS_AUTHORIZED_ATTEMPT_ONLY');
          const added = after.secretAudit.filter(row => !receipts.secretAudit.some(old => old.event_id === row.event_id));
          assert.equal(added.length, 1); assert.equal(added[0].phase, 'authorized'); assert.equal(added[0].operation, 'issue-legacy');
        } finally { await trigger.close(); await fn.close(); await witness.close(); }
        results.push('commit-refusal-no-credential');
        assertNoEffects(foreign, await capture(config.tenants[1], { includeSecretAudit: true }));
        const completed = name => results.includes(name);
        const families = {
          shiroGrammar: completed('shipping-grammar'),
          projectContainment: completed('project-containment'),
          operatorContainment: completed('operator-containment'),
          delegationContainment: completed('delegation-containment'),
          actorRevocation: completed('current-actor'),
          policyWaiter: completed('prior-policy-waiter') && completed('held-policy-through-commit'),
          actorWaiter: completed('prior-actor-waiter') && completed('held-actor-through-commit') &&
            completed('prior-delegation-waiter') && completed('held-delegation-through-commit'),
          roleWaiter: completed('prior-role-waiter') && completed('held-role-through-commit'),
          heldThroughCommit: changes.every(value => completed('held-' + value.name + '-through-commit')),
          auditRefusal: completed('owner-audit-refusal') && completed('secret-audit-refusal'),
          commitRefusal: completed('commit-refusal-no-credential')
        };
        assert.ok(Object.values(families).every(value => value === true), 'AUTHORITY_NATIVE_FAMILIES_INCOMPLETE');
        return { classification: 'native-PG-authority-fencing-under-human-HTTPS',
          grammarContainment: true, projectOperatorDelegation: true, currentActor: true,
          priorNarrowingWaiters: true, heldThroughCommit: true, auditFailureAtomic: true,
          commitFailureNoCredential: true, foreignTenantUnchanged: true, cases: results, families };
      } finally { await restoreOriginal(); }
    }
    return { router, exercise, close, manifest, custody: () => JSON.parse(JSON.stringify(custody)) };
  } catch (error) { await close().catch(() => {}); throw error; }
}

const manifest = Object.freeze({
  family: 'native-authority-fences', nativeExecution: 'NOTEXECUTED',
  stageActiveCeilingMs: 60000, causalWaiterMs: 2000, observationPollMs: 5,
  resources: { extraOwnerStorePoolMax: 4, transientAdminClientsMax: 2,
    adminClientConnectMs: 1000, adminClientStatementMs: 2500, adminClientQueryMs: 3000,
    adminClientIdleTransactionMs: 5000, sharedAdminPoolMax: 1 },
  sourceDependencies: ['lib/subject-admin/postgres.js', 'lib/subject-admin/owner-policy.js',
    'lib/subject-admin/permission-implication.js', 'lib/subject-admin/component.js',
    'lib/server/subject-management-app.js', 'lib/storage/postgres-connection.js', 'lib/secrets/component.js'],
  setup: 'No new schemas/roles; scenario-owned roles/subjects and exact-OID temporary constraint/trigger/function/nontransactional-sequence witness in owned schemas. Mount router before owner catch-all. custody() exposes backend births/object OIDs; API close acknowledgements are not independent physical closure.'
});

module.exports = { admit, create, manifest, assertNoEffects, assertRefusal, assertCommitWitness, assertWaiterRows, waitForWaiter, settleRaceResources };
