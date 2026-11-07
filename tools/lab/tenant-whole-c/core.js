'use strict';
/* eslint-disable security/detect-non-literal-fs-filename -- Explicit private parent capture and immutable OLD archive. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const operations = require('../../../lib/tenant-operations');
const common = require('../../../lib/tenant-operations/common');
const restoreModule = require('../../../lib/tenant-operations/restore');
const lifecycle = require('../../../lib/tenant-lifecycle');
const migrations = require('../../../lib/migrations/postgres');
const oracle = require('./oracle');
const scope = require('../../../lib/storage/tenant-scope');
const lowerPort = require('../../../lib/storage/postgres-connection');
const { A, B, populatedRows } = require('../../../tests/fixtures/tenant-deployment-data');
const { checkpointInputs, populatedInstanceRows } = require('../../../tests/fixtures/tenant-deployment-checkpoints');
const { alarmInputs } = require('../../../tests/fixtures/tenant-deployment-alarm');
const { notificationInputs } = require('../../../tests/fixtures/tenant-deployment-notifications');
const { currentAuthority } = require('./authority');
const { processIdentity, stoppedWindow } = require('./window');
const { fork } = require('node:child_process');
const q = oracle.quote;
const sourceRoot = path.resolve(__dirname, '../../..');
const actions = ['request', 'confirm', 'cancel', 'claim', 'execute'];
const identity = { principal: 'whole_c_operator', consumer: 'whole_c_core', plane: 'operator' };
const ownerIdentity = { principal: 'whole_c_owner', consumer: 'whole_c_core', plane: 'owner' };
const marker = () => 'whole_c_' + crypto.randomBytes(8).toString('hex');
async function run (config, selected = 'all') {
  scope.setTenancyMode('multi');
  const admin = new Client({ connectionString: config.connectionString, statement_timeout: 15000 });
  const observer = new Client({ connectionString: config.connectionString, statement_timeout: 15000 });
  await admin.connect(); await observer.connect();
  const owned = { namespaces: [], roles: [], children: [], births: [], ports: new Set() }, results = [];
  let serial = 0, eventSerial = 0;
  const emit = (phase, value) => {
    const event = { sequence: ++eventSerial, phase, value };
    fs.appendFileSync(path.join(config.captureDirectory, 'observations.ndjson'), JSON.stringify(event) + '\n');
    return event;
  };
  const observerChild = fork(path.join(__dirname, 'observer.js'), [], { silent: true,
    env: { NODE_PATH: process.env.NODE_PATH || '', NS_WHOLE_C_OBSERVER_URI: config.connectionString, NS_WHOLE_C_PREFIX: config.prefix } });
  owned.children.push(observerChild);
  owned.births.push(processIdentity(observerChild.pid));
  emit('owned-child-birth', { kind: 'observer', birth: processIdentity(observerChild.pid) });
  observerChild.stdout.on('data', () => {}); observerChild.stderr.on('data', () => {});
  const observed = (type, message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clear(); reject(new Error('WHOLE_C_OBSERVER_TIMEOUT')); }, 20000);
    function clear () { clearTimeout(timer); observerChild.off('message', receive); observerChild.off('exit', exited); }
    function receive (value) {
      if (message && value.id !== message.id) return;
      if (value.type === type) { clear(); resolve(value.value); }
      else if (value.type === 'failure') { clear(); reject(Object.assign(new Error('WHOLE_C_OBSERVER_FAILURE'), { code: value.code })); }
    }
    function exited () { clear(); reject(new Error('WHOLE_C_OBSERVER_EXIT')); }
    observerChild.on('message', receive); observerChild.on('exit', exited); if (message) observerChild.send(message);
  });
  const observerReady = observed('ready'); observerReady.catch(() => {});
  let observationId = 0;
  const physical = async (label, admission) => {
    await observerReady;
    const value = await observed('physical', { type: 'physical', id: ++observationId,
      catalogues: admission.catalogues.map(entry => ({ kind: entry.kind, namespace: entry.namespace, tables: entry.tables })) });
    emit(label, value); return value;
  };
  const migrate = (action, input) => migrations.run(action, { ...input, connectionString: config.connectionString, direct: true });
  const now = async () => Number((await observer.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS at')).rows[0].at);
  async function reserve (prefix, kinds) {
    const namespaces = Object.fromEntries(kinds.map(kind => [kind, prefix + '_' + kind]));
    for (const namespace of Object.values(namespaces)) {
      assert.equal((await observer.query('SELECT to_regnamespace($1) AS present', [namespace])).rows[0].present, null, 'WHOLE_C_NAMESPACE_PREEXISTS');
      owned.namespaces.push(namespace); // Absent and exclusively reserved before any migration.
    }
    emit('reserved-namespaces', namespaces); return namespaces;
  }
  async function roles (prefix) {
    const names = {}, urls = {};
    for (const name of config.classes) {
      const role = prefix + '_' + name;
      assert.equal((await observer.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname=$1', [role])).rows[0].n, 0, 'WHOLE_C_ROLE_PREEXISTS');
      const password = crypto.randomBytes(24).toString('hex');
      await admin.query('CREATE ROLE ' + q(role) + " LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '" + password + "'");
      owned.roles.push(role); names[name] = role;
      const url = new URL(config.connectionString); url.username = role; url.password = password; urls[name] = url.toString();
    }
    emit('owned-roles', names); return { names, urls };
  }
  function operationalAcl (admission, names) {
    const grants = [];
    for (const entry of admission.catalogues) {
      if (entry.kind === 'lifecycle') continue;
      grants.push({ role: names.lifecycle_operator, kind: entry.kind, table: 'schema_migrations', privileges: ['SELECT'] });
      for (const table of entry.tables) grants.push({ role: names.lifecycle_operator, kind: entry.kind, table, privileges: ['SELECT', 'DELETE'] });
    }
    // Owner has no clinical DELETE. Both authority reads take the real policy fence.
    grants.push({ role: names.lifecycle_owner, kind: 'operator_policy', table: 'tenant_operator_policy', privileges: ['SELECT'] });
    for (const role of [names.lifecycle_owner, names.lifecycle_operator]) {
      grants.push({ role, kind: 'lifecycle', table: 'schema_migrations', privileges: ['SELECT'] },
        { role, kind: 'lifecycle', table: 'tenant_lifecycle_requests', privileges: ['SELECT', 'INSERT'], columnPrivileges: { UPDATE: role === names.lifecycle_operator ? ['phase', 'executed_at'] : ['phase'] } });
      if (admission.catalogues.find(e => e.kind === 'lifecycle').tables.includes('tenant_lifecycle_ceremony')) {
        grants.push({ role, kind: 'lifecycle', table: 'tenant_lifecycle_ceremony', privileges: ['SELECT'], columnPrivileges: {
          INSERT: ['request_id', 'tenant_id', 'phase', 'requested_by', 'requested_consumer'],
          UPDATE: role === names.lifecycle_operator
            ? ['phase', 'confirmed_by', 'confirmed_consumer', 'confirmed_at', 'cancelled_by', 'cancelled_consumer', 'cancelled_at', 'claim_id', 'started_by', 'started_consumer', 'started_at', 'executed_by', 'executed_consumer', 'executed_at']
            : ['phase', 'cancelled_by', 'cancelled_consumer', 'cancelled_at']
        } });
      }
    }
    return grants;
  }
  function acl (admission, names) {
    const kinds = new Set(admission.catalogues.map(e => e.kind));
    return { grants: config.acl.filter(g => kinds.has(g.kind)).map(g => ({ ...g, role: names[g.role] })).concat(operationalAcl(admission, names)) };
  }
  async function applyAcl (admission, selectedAcl) {
    const work = [];
    for (const entry of admission.catalogues) for (const table of entry.tables) work.push({ kind: entry.kind, namespace: entry.namespace, table, columns: await common.columnsOf(admin, entry.namespace, table) });
    const steps = common.plan(admission.catalogues);
    restoreModule.validateAcl(selectedAcl, steps);
    const prepared = await restoreModule.prepareAcl(admin, steps, work, selectedAcl);
    for (const statement of prepared.statements) await admin.query(statement);
    emit('explicit-acl', { grants: selectedAcl.grants, statements: prepared.statements });
  }
  async function make ({ old = false, existing, prepare = true, seed = true } = {}) {
    const prefix = config.prefix + '_' + (++serial);
    const runtime = await roles(prefix);
    const baseKinds = lifecycle.admittedCatalogue().map(e => e.kind).concat(['lifecycle']);
    const kinds = old ? baseKinds : baseKinds.concat(['alarm_suppression', 'notification_outbox', 'evaluator_checkpoint']);
    const ns = existing || await reserve(prefix, kinds);
    const epoch = await now();
    const extensions = old ? [] : [alarmInputs({ tenants: [A, B], now: epoch, writerRole: runtime.names.alarm, readerRole: runtime.names.suppression }).extension,
      notificationInputs({ tenants: [A, B], now: epoch, outboxRole: runtime.names.outbox, checkpointWriterRole: runtime.names.evaluator, ackReaderRole: runtime.names.alarm }).extension];
    const selection = Object.fromEntries((old ? ['treatments', 'devicestatus'] : ['treatments', 'devicestatus', 'profile']).map(k => [k, 'migrations/candidates/postgres-' + k + '-socket-order-v1.json']));
    const instances = old ? [] : [{ kind: 'evaluator_checkpoint', of: 'checkpoint' }];
    const admission = operations.deploymentAdmission({ root: old ? config.oldRoot : sourceRoot, namespaces: ns, selection, extensions, instances });
    const directory = path.join(config.captureDirectory, prefix); await fs.promises.mkdir(directory, { mode: 0o700 });
    const deployment = operations.createDeploymentOperations({ directory, root: old ? config.oldRoot : sourceRoot, namespaces: ns, selection, extensions, instances });
    const cohort = { prefix, ns, admission, deployment, directory, epoch, runtime, selection, instances, extensions };
    cohort.acl = acl(admission, runtime.names);
    emit('cohort-admission', { prefix, old, census: admission.census, selectedRoleClasses: Object.keys(runtime.names) });
    if (prepare) {
      for (const entry of admission.catalogues) await migrate('up', entry);
      if (seed) await seedRows(cohort, old);
      await applyAcl(admission, cohort.acl);
    }
    return cohort;
  }
  async function seedRows (cohort, old) {
    const tableRows = populatedRows({ now: cohort.epoch, profileSocketOrder: !old });
    // This is a SQL-fidelity cohort, not runtime-ready clinical/plugin/provider data.
    for (const row of tableRows.tenant_operator_policy) row.policy = { wholeCFixtureActors: [identity, ownerIdentity].map(actor => ({ ...actor, active: true, actions })) };
    let instanceRows;
    if (old) {
      instanceRows = Object.fromEntries(cohort.admission.catalogues.flatMap(e => e.tables.map(table => [e.kind + '.' + table, table === 'profile' ? [] : tableRows[table]])));
    } else {
      const checkpoints = checkpointInputs({ namespaces: cohort.ns, tenants: [A, B],
        realtime: { namespace: cohort.ns.checkpoint, consumer: 'sql-core-realtime-fixture', contractDigest: 'a'.repeat(64) },
        evaluator: { namespace: cohort.ns.evaluator_checkpoint, consumer: 'sql-core-evaluator-fixture', contractDigest: 'b'.repeat(64) },
        realtimeRole: cohort.runtime.names.realtime, evaluatorRole: cohort.runtime.names.evaluator });
      instanceRows = populatedInstanceRows(cohort.admission, tableRows, checkpoints);
    }
    for (const entry of cohort.admission.catalogues) for (const table of entry.tables) {
      const columns = await common.columnsOf(admin, entry.namespace, table);
      const names = new Set(columns.map(c => c.name));
      for (const row of instanceRows[entry.kind + '.' + table]) {
        assert.ok(Object.keys(row).every(name => names.has(name)), 'WHOLE_C_SEED_UNKNOWN_COLUMN ' + table);
        const selectedColumns = columns.filter(column => Object.hasOwn(row, column.name));
        await admin.query(restoreModule.insertStatement(entry.namespace, table, selectedColumns), restoreModule.insertValues(selectedColumns, row));
      }
    }
    // Fresh private fixture only: no allocator sessions exist yet and all rows
    // are globally visible to this operator. This is not tenant-import recovery.
    for (const entry of cohort.admission.catalogues) for (const table of entry.tables) {
      for (const column of (await common.columnsOf(admin, entry.namespace, table)).filter(column => column.identity)) {
        await admin.query('SELECT setval(pg_get_serial_sequence($1,$2), (SELECT max(' + q(column.name) + ') FROM ' + q(entry.namespace) + '.' + q(table) + '), true)', [q(entry.namespace) + '.' + q(table), column.name]);
      }
    }
  }
  async function writeProbe (cohort, roleClass, kind, table, operation = 'INSERT', column) {
    const conn = new Client({ connectionString: cohort.runtime.urls[roleClass] }); await conn.connect();
    let code = null, count = null;
    try {
      await conn.query('BEGIN'); await conn.query("SELECT set_config('app.current_tenant_id',$1,true)", [A]);
      const qualified = q(cohort.ns[kind]) + '.' + q(table);
      let result;
      if (operation === 'INSERT') {
        if (table === 'tenant_notification_state') result = await conn.query('INSERT INTO ' + qualified + '(tenant_id,consumer,revision,config_identity,producer) VALUES($1,$2,1,$3,$4::jsonb)', [A, marker(), 'sql-core', JSON.stringify({ alarms: [], effects: [], acks: [], output: null })]);
        else {
          // Explicit identity value prevents a missing sequence grant from
          // masquerading as a clinical INSERT denial in the broadening control.
          const identityColumns = (await observer.query("SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attidentity<>'' AND attnum>0", [qualified])).rows;
          const column = identityColumns[0]?.attname;
          result = await conn.query('INSERT INTO ' + qualified + '(tenant_id,id_kind,doc' + (column ? ',' + q(column) : '') + ')' +
            (column ? ' OVERRIDING SYSTEM VALUE' : '') + ' VALUES($1,\'string\',$2::jsonb' + (column ? ',999999' : '') + ')', [A, JSON.stringify({ _id: marker(), date: cohort.epoch })]);
        }
      } else if (operation === 'UPDATE') result = await conn.query('UPDATE ' + qualified + ' SET ' + q(column) + '=' + q(column) + ' WHERE tenant_id=$1', [A]);
      else result = await conn.query('DELETE FROM ' + qualified + ' WHERE tenant_id=$1', [A]);
      count = result.rowCount;
    } catch (error) { code = error.code; }
    finally { await conn.query('ROLLBACK'); await conn.end(); }
    emit('actual-role-statement', { roleClass, kind, table, operation, column, code, count });
    assert.equal(code, '42501', 'WHOLE_C_ROLE_DENIAL ' + roleClass + ':' + kind + ':' + operation);
  }
  async function denials (cohort) {
    for (const role of ['realtime', 'evaluator']) for (const kind of ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity']) await writeProbe(cohort, role, kind, kind);
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) await writeProbe(cohort, 'alarm', 'notification_outbox', 'tenant_notification_state', operation, 'producer');
    await writeProbe(cohort, 'lifecycle_owner', 'entries', 'entries', 'DELETE');
  }
  async function sequenceProbes (cohort) {
    const conn = new Client({ connectionString: cohort.runtime.urls.api }); await conn.connect();
    try {
      for (const kind of ['entries', 'treatments', 'devicestatus', 'profile']) {
        const table = q(cohort.ns[kind]) + '.' + q(kind);
        const max = (await observer.query('SELECT max(insertion_ordinal)::text AS n FROM ' + table)).rows[0].n;
        await conn.query('BEGIN');
        try {
          await conn.query("SELECT set_config('app.current_tenant_id',$1,true)", [A]);
          const next = (await conn.query('INSERT INTO ' + table + '(tenant_id,id_kind,doc) VALUES($1,\'string\',$2::jsonb) RETURNING insertion_ordinal::text AS n', [A, JSON.stringify({ _id: marker(), date: cohort.epoch })])).rows[0].n;
          emit('actual-writer-next-identity', { kind, max, next });
          assert.ok(BigInt(next) > BigInt(max), 'WHOLE_C_NEXT_IDENTITY ' + kind);
        } finally { await conn.query('ROLLBACK'); }
      }
    } finally { await conn.end(); }
  }
  const codes = error => { const found = []; for (let e = error; e; e = e.cause) if (e.code) found.push(e.code); return found; };
  async function expectedFailure (fn, expectedCode, label, beforeVerdict) {
    let failure; try { await fn(); } catch (error) { failure = error; }
    if (beforeVerdict) await beforeVerdict();
    emit('expected-refusal', { label, codes: codes(failure), name: failure?.name });
    assert.ok(failure && codes(failure).includes(expectedCode), 'WHOLE_C_REFUSAL ' + label + ' expected ' + expectedCode);
    return failure;
  }
  let upgradeState;
  const cases = {
    async C1 () {
      const source = await make();
      assert.equal(source.admission.census.tables, 37); assert.equal(source.admission.catalogues.length, 21);
      const before = await physical('C1-source-before-verdict', source.admission);
      for (const [key, table] of Object.entries(before)) for (const tenant of [A, B]) assert.ok(table.rows.some(row => row.tenant_id === tenant), 'WHOLE_C_EMPTY_DOMAIN ' + key);
      const artifact = await source.deployment.backup(admin, { sourceCommit: config.sourceHead });
      await oracle.artifact(source.directory, before, value => emit('C1-independent-artifact-before-verdict', value));
      const reloaded = await source.deployment.load(operations.artifactName(artifact));
      assert.deepEqual(reloaded, artifact, 'WHOLE_C_DURABLE_READBACK');
      const target = await make({ seed: false });
      await target.deployment.restore(admin, reloaded, { acl: target.acl });
      const after = await physical('C1-restored-before-verdict', target.admission);
      oracle.sameRows(before, after);
      await denials(target); await sequenceProbes(target);
      oracle.sameRows(before, await physical('C1-after-denials-before-verdict', target.admission));
    },
    async C2 () {
      const source = await make(); const artifact = await source.deployment.backup(admin, { sourceCommit: config.sourceHead });
      const target = await make({ seed: false });
      const empty = await physical('C2-empty-before', target.admission);
      const bad = structuredClone(artifact), key = Object.keys(bad.tables).find(key => bad.tables[key].length > 0);
      const changedRows = bad.tables[key].trimEnd().split('\n').map(line => JSON.parse(line));
      changedRows[0].doc.extension.zero = 17;
      bad.tables[key] = changedRows.map(row => JSON.stringify(row)).join('\n') + '\n';
      const statements = [], completed = [], recording = { query: async (text, values) => { statements.push(text); const result = await admin.query(text, values); completed.push({ command: text.trim().split(/\s+/)[0], rowCount: result.rowCount }); return result; } };
      await expectedFailure(() => target.deployment.restore(recording, bad, { acl: target.acl }), 'RESTORE_DIGEST_MISMATCH', 'tampered-file', async () => {
        emit('C2-tamper-actual-statements-before-verdict', statements.map(text => text.trim().split(/\s+/)[0]));
        emit('C2-tamper-completed-SQL-before-verdict', completed);
        await physical('C2-tamper-physical-before-verdict', target.admission);
      });
      emit('C2-tamper-statement-categories', statements.map(text => text.trim().split(/\s+/)[0]));
      assert.equal(statements.filter(text => /^(INSERT|GRANT|SELECT setval)/.test(text)).length, 0, 'WHOLE_C_DAMAGE_PREWRITE');
      oracle.sameRows(empty, await physical('C2-damaged-target-before-verdict', target.admission));
      for (const boundary of ['write', 'file-sync', 'directory-sync', 'rename', 'readback']) {
        const directory = path.join(source.directory, boundary); await fs.promises.mkdir(directory, { mode: 0o700 });
        let renamed = false;
        const io = { ...fs.promises,
          open: async (...args) => {
            const handle = await fs.promises.open(...args), writable = Boolean(args[1] & fs.constants.O_WRONLY);
            return { writeFile: async (...values) => { if (boundary === 'write') throw new Error('owned write interruption'); return handle.writeFile(...values); },
              readFile: async (...values) => { if (boundary === 'readback' && renamed) throw new Error('owned readback interruption'); return handle.readFile(...values); }, stat: () => handle.stat(),
              sync: async () => { if ((boundary === 'file-sync' && writable) || (boundary === 'directory-sync' && !writable)) throw new Error('owned sync interruption'); return handle.sync(); }, close: () => handle.close() };
          },
          rename: async (...args) => { if (boundary === 'rename') throw new Error('owned rename interruption'); const result = await fs.promises.rename(...args); renamed = true; return result; }
        };
        await expectedFailure(() => operations.saveArtifact(artifact, { directory, io }), 'BACKUP_DURABILITY_FAILED', boundary, async () => emit('C2-durability-physical-before-verdict', { boundary, renamed, files: await fs.promises.readdir(directory) }));
        const files = await fs.promises.readdir(directory); emit('C2-durability-physical', { boundary, files, renamed });
        assert.equal(files.length, renamed ? 1 : 0, 'WHOLE_C_PUBLICATION_STATE ' + boundary);
      }
      await assert.rejects(target.deployment.restore(admin, artifact, { acl: target.acl, onRow: ({ total }) => { if (total === 3) throw Object.assign(new Error('owned restore interruption'), { code: 'WHOLE_C_RESTORE_INTERRUPT' }); } }), { code: 'WHOLE_C_RESTORE_INTERRUPT' });
      const interrupted = await physical('C2-interrupted-before-verdict', target.admission);
      oracle.sameRows(empty, interrupted);
      await target.deployment.restore(admin, artifact, { acl: target.acl });
      oracle.sameRows(await physical('C2-source', source.admission), await physical('C2-rerun-before-verdict', target.admission));
    },
    async C3 () {
      // Actual OLDsource, no invented migration. Guarded OLDprofile is empty.
      const old = await make({ old: true });
      const extra = await reserve(config.prefix + '_new_' + (++serial), ['alarm_suppression', 'notification_outbox', 'evaluator_checkpoint']);
      const target = await make({ existing: { ...old.ns, ...extra }, prepare: false });
      const before = await physical('C3-OLD-before-verdict', old.admission);
      assert.equal(old.admission.census.tables, 31);
      assert.equal(before['profile.profile'].rows.length, 0);
      assert.ok(before['lifecycle.tenant_lifecycle_requests'].rows.length > 0);
      let independentOldArtifact = false;
      const observedMigrate = async (action, input) => {
        if (action === 'up' && !independentOldArtifact) { const head = await oracle.artifact(target.directory, before, value => emit('C3-independent-OLD-artifact-before-NEW', value)); assert.equal(head.manifest.sourceCommit, config.oldHead); independentOldArtifact = true; }
        return migrate(action, input);
      };
      const result = await target.deployment.upgrade(admin, { source: { root: config.oldRoot, sourceCommit: config.oldHead, namespaces: old.ns, selection: old.selection }, sourceCommit: config.sourceHead, migrate: observedMigrate });
      assert.equal(independentOldArtifact, true, 'WHOLE_C_OLD_ARTIFACT_PRECEDES_NEW');
      emit('C3-upgrade-record', result.record);
      const retained = await operations.loadArtifact({ directory: target.directory, name: result.record.backup.name });
      assert.deepEqual(retained, result.artifact, 'WHOLE_C_OLD_DURABLE_ARTIFACT');
      assert.equal(retained.manifest.catalogues.length, 18);
      const after = await physical('C3-NEW-before-verdict', target.admission);
      oracle.preserved(before, after);
      assert.equal(after['lifecycle.tenant_lifecycle_ceremony'].rows.length, 0, 'WHOLE_C_NO_IMPLICIT_CONFIRMATION');
      assert.equal(after['lifecycle.tenant_lifecycle_requests'].ledger.length, 2);
      upgradeState = { old, target, before, after, result };
      // Real failure within unchanged lifecycle0002, after its first ALTER has
      // executed. A scoped ddl_command_end trigger raises57014 in that same tx.
      const interruptedOld = await make({ old: true });
      const interruptedExtra = await reserve(config.prefix + '_int_' + (++serial), ['alarm_suppression', 'notification_outbox', 'evaluator_checkpoint']);
      const interruptedTarget = await make({ existing: { ...interruptedOld.ns, ...interruptedExtra }, prepare: false });
      const life = { catalogues: interruptedOld.admission.catalogues.filter(e => e.kind === 'lifecycle') };
      const prior = await physical('C3-interruption-lifecycle-before', life);
      const interruptedBefore = await physical('C3-interruption-OLD-before', interruptedOld.admission);
      let interruptedArtifactChecked = false;
      const interruptedMigrate = async (action, input) => {
        if (action === 'up' && !interruptedArtifactChecked) {
          const head = await oracle.artifact(interruptedTarget.directory, interruptedBefore, value => emit('C3-interrupted-OLD-artifact-before-NEW', value));
          assert.equal(head.manifest.sourceCommit, config.oldHead); interruptedArtifactChecked = true;
        }
        return migrate(action, input);
      };
      const trigger = config.prefix + '_abort_lifecycle', functionName = q(interruptedOld.ns.lifecycle) + '.whole_c_abort';
      await admin.query('CREATE FUNCTION ' + functionName + "() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN IF current_schema() = '" + interruptedOld.ns.lifecycle + "' AND current_query() LIKE 'ALTER TABLE tenant_lifecycle_requests ADD CONSTRAINT%' THEN RAISE EXCEPTION USING ERRCODE='57014', MESSAGE='whole-c-owned-interruption'; END IF; END $$");
      emit('C3-owned-DDL-interruption', { trigger, functionName, namespace: interruptedOld.ns.lifecycle });
      await admin.query('CREATE EVENT TRIGGER ' + q(trigger) + ' ON ddl_command_end WHEN TAG IN (\'ALTER TABLE\') EXECUTE FUNCTION ' + functionName + '()');
      let failure;
      try {
        try { await interruptedTarget.deployment.upgrade(admin, { source: { root: config.oldRoot, sourceCommit: config.oldHead, namespaces: interruptedOld.ns, selection: interruptedOld.selection }, sourceCommit: config.sourceHead, migrate: interruptedMigrate }); } catch (error) { failure = error; }
      } finally {
        await admin.query('DROP EVENT TRIGGER ' + q(trigger)); await admin.query('DROP FUNCTION ' + functionName + '()');
      }
      const physicalAfter = await physical('C3-interrupted-lifecycle-before-verdict', life);
      emit('C3-interruption-failure', { codes: codes(failure), retainedArtifact: Boolean(failure?.artifact) });
      assert.ok(codes(failure).includes('57014'), 'WHOLE_C_ACTUAL_MIGRATION_INTERRUPTION');
      assert.ok(failure.artifact);
      assert.deepEqual(await interruptedTarget.deployment.load(operations.artifactName(failure.artifact)), failure.artifact);
      oracle.sameRows(prior, physicalAfter);
      assert.deepEqual(physicalAfter['lifecycle.tenant_lifecycle_requests'].constraints, prior['lifecycle.tenant_lifecycle_requests'].constraints, 'WHOLE_C_MIGRATION_CONSTRAINT_ATOMICITY');
    },
    async C4 () {
      if (!upgradeState) await cases.C3();
      const { old, target, before, result } = upgradeState;
      // eslint-disable-next-line security/detect-non-literal-require -- Parent-extracted exact immutable OLDsource archive.
      const oldOperations = require(path.join(config.oldRoot, 'lib/tenant-operations'));
      // eslint-disable-next-line security/detect-non-literal-require -- Parent-extracted exact immutable OLDsource archive.
      const oldMigrations = require(path.join(config.oldRoot, 'lib/migrations/postgres'));
      const oldBinary = oldOperations.createDeploymentOperations({ root: config.oldRoot, namespaces: old.ns, selection: old.selection, directory: old.directory });
      let refusal; try { oldBinary.checkRecord(result.record); } catch (error) { refusal = error.code; }
      emit('C4-actual-OLD-record-refusal', { refusal });
      assert.ok(['OPERATIONS_BINARY_CATALOGUE_NEWER', 'OPERATIONS_BINARY_CATALOGUE_UNKNOWN'].includes(refusal));
      const oldMigrate = (action, input) => oldMigrations.run(action, { ...input, connectionString: config.connectionString, direct: true });
      await expectedFailure(() => oldMigrate('check', old.admission.catalogues.find(e => e.kind === 'lifecycle')), 'MIG_UNKNOWN', 'actual-OLD-lifecycle-readiness');
      await admin.query('UPDATE ' + q(target.ns.clock) + '.tenant_write_clock SET last_stamp=last_stamp+37 WHERE tenant_id=$1', [A]);
      const forensic = await physical('C4-NEW-forensic-before-rollback', target.admission);
      const fresh = await make({ old: true, prepare: false });
      const rollback = oldOperations.createDeploymentOperations({ root: config.oldRoot, namespaces: fresh.ns, selection: old.selection, directory: fresh.directory });
      const report = await rollback.rollback(admin, result.artifact, { migrate: oldMigrate, upgraded: target.ns, upgradeRecord: result.record, acl: fresh.acl });
      emit('C4-rollback-record', report);
      oracle.sameRows(before, await physical('C4-fresh-OLD-before-verdict', fresh.admission));
      oracle.sameRows(forensic, await physical('C4-NEW-retained-before-verdict', target.admission));
      for (const entry of fresh.admission.catalogues) await oldMigrate('check', entry);
      for (const family of ['profile', 'heads', 'requests']) for (const populated of [true, false]) {
        const kind = family === 'profile' ? 'profile' : 'notification_outbox';
        const candidate = kind === 'profile' ? (config.guardCandidatePath ? JSON.parse(fs.readFileSync(config.guardCandidatePath, 'utf8')) : require('../../../migrations/candidates/postgres-profile-socket-order-v1.json')) : require('../../../lib/tenant-notifications/postgres-candidate.json');
        const base = { ...candidate, migrations: [candidate.migrations[0]] };
        const ns = (await reserve(config.prefix + '_g_' + (++serial), [kind]))[kind];
        const tables = kind === 'profile' ? ['profile'] : ['tenant_notification_heads', 'tenant_notification_requests'];
        const baseEntry = { kind, namespace: ns, catalogue: base, tables };
        await migrate('up', baseEntry);
        if (populated) {
          if (family === 'profile') await admin.query('INSERT INTO ' + q(ns) + '.profile(tenant_id,id_kind,doc) VALUES($1,\'string\',$2::jsonb)', [A, JSON.stringify({ _id: 'guarded-profile' })]);
          else if (family === 'heads') await admin.query('INSERT INTO ' + q(ns) + '.tenant_notification_heads VALUES($1,$2,$3,NULL,0)', [A, 'sql-core', 'pushnotify:guard']);
          else await admin.query('INSERT INTO ' + q(ns) + '.tenant_notification_requests(tenant_id,request_id,consumer,dedup_key,origin,config_identity,payload,state,created_at,next_at,attempt) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,\'pending\',1,1,0)', [A, crypto.randomUUID(), 'sql-core', 'pushnotify:guard', 'guard-origin', 'guard-config', JSON.stringify({ title: 'Synthetic', message: 'guard' })]);
        }
        const beforeGuard = await physical('C4-guard-before-' + family + '-' + populated, { catalogues: [baseEntry] });
        let failure; try { await migrate('up', { namespace: ns, catalogue: candidate }); } catch (error) { failure = error; }
        const afterGuard = await physical('C4-guard-after-before-verdict-' + family + '-' + populated, { catalogues: [baseEntry] });
        emit('C4-guard-result', { family, populated, codes: codes(failure) });
        if (populated) {
          assert.ok(codes(failure).includes('23514'), 'WHOLE_C_POPULATED_GUARD ' + family);
          oracle.sameRows(beforeGuard, afterGuard);
          for (const key of Object.keys(beforeGuard)) assert.deepEqual(afterGuard[key].constraints, beforeGuard[key].constraints, 'WHOLE_C_GUARD_CONSTRAINT_ATOMICITY');
        } else {
          assert.equal(failure, undefined, 'WHOLE_C_EMPTY_UPGRADE ' + family);
          await expectedFailure(() => migrate('check', baseEntry), 'MIG_UNKNOWN', 'empty-success-old-refusal-' + family);
        }
      }
    },
    async C5 () {
      async function fixture () {
        const cohort = await make();
        const writer = fork(path.join(__dirname, 'writer.js'), [cohort.ns.clock, A], { silent: true,
          env: { NODE_PATH: process.env.NODE_PATH || '', NS_WHOLE_C_WRITER_URI: cohort.runtime.urls.api } });
        owned.children.push(writer); owned.births.push(processIdentity(writer.pid));
        emit('owned-child-birth', { kind: 'writer', birth: processIdentity(writer.pid) });
        writer.stdout.on('data', () => {}); writer.stderr.on('data', () => {});
        async function message (type, send) {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { clear(); reject(new Error('WHOLE_C_WRITER_TIMEOUT')); }, 10000);
            function clear () { clearTimeout(timer); writer.off('message', receive); writer.off('exit', exited); }
            function receive (value) { if (value.type === type) { clear(); resolve(value); } else if (value.type === 'error') { clear(); reject(Object.assign(new Error('WHOLE_C_WRITER_FAILURE'), { code: value.code })); } }
            function exited () { clear(); reject(new Error('WHOLE_C_WRITER_EXIT')); }
            writer.on('message', receive); writer.on('exit', exited); if (send) writer.send(send);
          });
        }
        await message('ready');
        const birth = { ...processIdentity(writer.pid), kind: 'owned-sql-fixture-writer', namespace: cohort.ns.clock };
        emit('C5-owned-writer-birth', birth);
        const liveWindow = stoppedWindow({ tenant: A, births: [birth], onObservation: rows => emit('C5-live-writer-observation', rows) });
        const liveProof = await liveWindow({ tenant: A });
        emit('C5-live-writer-physical-before-verdict', { proof: liveProof, clock: (await observer.query('SELECT tenant_id,last_stamp FROM ' + q(cohort.ns.clock) + '.tenant_write_clock')).rows });
        assert.equal(liveProof.quiesced, false, 'WHOLE_C_RUNNING_WRITER_REFUSED');
        await message('drained', { type: 'drain' }); writer.kill('SIGSTOP');
        for (let i = 0; i < 100 && processIdentity(writer.pid)?.state !== 'T'; i++) await new Promise(resolve => setTimeout(resolve, 10));
        const window = stoppedWindow({ tenant: A, births: [birth], onObservation: rows => emit('C5-stopped-writer-window', rows) });
        assert.equal((await window({ tenant: A })).quiesced, true, 'WHOLE_C_ACTUAL_WRITER_STOPPED');
        const ports = {};
        for (const name of ['owner', 'operator', 'other']) { ports[name] = await lowerPort({ connectionString: cohort.runtime.urls[name === 'owner' ? 'lifecycle_owner' : 'lifecycle_operator'],
          max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000, query_timeout: 10000, application_name: cohort.prefix + '_' + name }); owned.ports.add(ports[name]); }
        const artifact = await cohort.admission.lifecycle.exportTenant(ports.operator, { tenant: A, namespaces: cohort.ns, sourceCommit: config.sourceHead });
        const directory = path.join(cohort.directory, 'tenant-artifacts');
        await lifecycle.saveTenantArtifact(artifact, { directory });
        const capabilities = actor => ({ authorize: currentAuthority({ namespace: cohort.ns.operator_policy, ...actor }),
          verifyDurableArtifact: lifecycle.createFilesystemArtifactVerifier({ directory }), executionWindow: window });
        const operator = cohort.admission.lifecycle.withCapabilities(capabilities(identity));
        const owner = cohort.admission.lifecycle.withCapabilities(capabilities(ownerIdentity));
        const args = { tenant: A, namespaces: cohort.ns, ledgerNamespace: cohort.ns.lifecycle, artifact };
        return { cohort, ports, operator, owner, args, writer, artifactDirectory: directory, async close () { for (const port of Object.values(ports)) { await port.end(); owned.ports.delete(port); } } };
      }
      async function race (state, claimFirst) {
        const { cohort, ports, operator, owner, args } = state;
        const request = await owner.requestDeletion(ports.owner, args), options = { ...args, requestId: request.requestId };
        await operator.confirmDeletion(ports.operator, options);
        await admin.query('BEGIN');
        await admin.query('SELECT request_id FROM ' + q(cohort.ns.lifecycle) + '.tenant_lifecycle_requests WHERE request_id=$1 FOR UPDATE', [request.requestId]);
        const pending = [];
        const begin = claim => {
          const promise = claim ? operator.claimDeletion(ports.operator, options) : owner.cancelDeletion(ports.owner, options);
          // Attach rejection handler immediately while the deliberate barrier holds.
          const wrapped = promise.then(value => ({ ok: true, value }), error => ({ ok: false, code: error.code })); pending.push(wrapped);
        };
        async function waiting (suffix) {
          for (let i = 0; i < 200; i++) {
            const rows = (await observer.query("SELECT pid,application_name,wait_event_type,wait_event FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [cohort.prefix + '_' + suffix])).rows;
            if (rows.length) { emit('C5-real-connection-barrier', rows); return; }
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          throw new Error('WHOLE_C_RACE_BARRIER_TIMEOUT');
        }
        try { begin(claimFirst); await waiting(claimFirst ? 'operator' : 'owner'); begin(!claimFirst); await waiting(claimFirst ? 'owner' : 'operator'); }
        finally { await admin.query('COMMIT'); }
        const outcomes = await Promise.all(pending);
        const rows = await physical('C5-race-before-verdict', cohort.admission); emit('C5-race-outcomes', { claimFirst, outcomes });
        assert.equal(outcomes.filter(value => value.ok).length, 1, 'WHOLE_C_CANCEL_CLAIM_ONE_WINNER');
        assert.equal(outcomes[0].ok, true);
        assert.equal(outcomes[1].code, claimFirst ? 'LIFECYCLE_EXECUTION_STARTED' : 'LIFECYCLE_REQUEST_CANCELLED');
        return { options, claim: claimFirst ? outcomes[0].value : null, rows };
      }
      const state = await fixture();
      try {
        // Ordinary inheritance is not a partition and can cross the selected
        // namespace boundary. Never use ONLY as a silent recovery workaround.
        const external = (await reserve(config.prefix + '_inherit_' + (++serial), ['outside'])).outside;
        await admin.query('CREATE SCHEMA ' + q(external));
        const descendant = q(external) + '.whole_c_descendant';
        await admin.query('CREATE TABLE ' + descendant + '(descendant_only text NOT NULL) INHERITS (' + q(state.cohort.ns.entries) + '.entries)');
        const inheritedA = { tenant_id: A, id_kind: 'string', doc: { _id: 'whole_c_inherited_a', type: 'sgv', sgv: 123, date: state.cohort.epoch }, insertion_ordinal: '991' };
        const inheritedB = { ...inheritedA, tenant_id: B, doc: { ...inheritedA.doc, _id: 'whole_c_inherited_b' }, insertion_ordinal: '992' };
        for (const row of [inheritedA, inheritedB]) await admin.query('INSERT INTO ' + descendant + '(tenant_id,id_kind,doc,insertion_ordinal,descendant_only) VALUES($1,$2,$3::jsonb,$4,$5)', [row.tenant_id, row.id_kind, JSON.stringify(row.doc), row.insertion_ordinal, 'synthetic descendant-only ' + (row.tenant_id === A ? 'a' : 'b')]);
        const inheritedArtifact = require('../../../lib/tenant-lifecycle/artifact').buildArtifact({ tenant: A, sourceCommit: config.sourceHead, exportedAt: state.args.artifact.manifest.exportedAt,
          catalogues: state.args.artifact.manifest.catalogues.map(entry => ({ ...entry, tables: entry.tables.map(table => ({ ...table,
            rows: state.args.artifact.tables[entry.kind + '.' + table.table].concat(entry.kind === 'entries' && table.table === 'entries' ? [inheritedA] : []), secrets: table.keyReferences !== undefined, keyReferences: table.keyReferences })) })) });
        await lifecycle.saveTenantArtifact(inheritedArtifact, { directory: state.artifactDirectory });
        const inheritedRequest = await state.owner.requestDeletion(state.ports.owner, { ...state.args, artifact: inheritedArtifact });
        const inheritedArgs = { ...state.args, artifact: inheritedArtifact, requestId: inheritedRequest.requestId };
        await state.operator.confirmDeletion(state.ports.operator, inheritedArgs);
        const inheritanceBefore = await physical('C5-inheritance-before', state.cohort.admission);
        const childBefore = (await observer.query('SELECT * FROM ONLY ' + descendant + ' ORDER BY tenant_id')).rows;
        let inheritanceExport, inheritanceErase, inheritanceBackup, acceptedInheritedExport;
        try { acceptedInheritedExport = await state.cohort.admission.lifecycle.exportTenant(state.ports.operator, { tenant: A, namespaces: state.cohort.ns, sourceCommit: config.sourceHead }); } catch (error) { inheritanceExport = error; }
        try { await state.cohort.deployment.backup(admin, { sourceCommit: config.sourceHead }); } catch (error) { inheritanceBackup = error; }
        try { await state.operator.executeDeletion(state.ports.operator, inheritedArgs); } catch (error) { inheritanceErase = error; }
        const inheritanceAfter = await physical('C5-inheritance-after-before-verdict', state.cohort.admission);
        const childAfter = (await observer.query('SELECT * FROM ONLY ' + descendant + ' ORDER BY tenant_id')).rows;
        emit('C5-inheritance-effects-before-verdict', { exportCodes: codes(inheritanceExport), backupCodes: codes(inheritanceBackup), eraseCodes: codes(inheritanceErase), childBefore, childAfter,
          exportAccepted: Boolean(acceptedInheritedExport), extraOmitted: acceptedInheritedExport ? acceptedInheritedExport.tables['entries.entries'].every(row => !Object.hasOwn(row, 'descendant_only')) : null });
        assert.ok(codes(inheritanceExport).includes('LIFECYCLE_RELATION_UNSUPPORTED'), 'WHOLE_C_INHERITANCE_EXPORT_REFUSED');
        assert.ok(codes(inheritanceBackup).includes('OPERATIONS_RELATION_UNSUPPORTED'), 'WHOLE_C_INHERITANCE_BACKUP_REFUSED');
        assert.ok(codes(inheritanceErase).includes('LIFECYCLE_RELATION_UNSUPPORTED'), 'WHOLE_C_INHERITANCE_ERASE_REFUSED');
        oracle.sameRows(inheritanceBefore, inheritanceAfter); assert.deepEqual(childAfter, childBefore);
        await admin.query('DROP TABLE ' + descendant); await admin.query('DROP SCHEMA ' + q(external));
        const unknownName = '0999_whole_c_unknown', unknownChecksum = 'e'.repeat(64);
        const hidden = q(state.cohort.ns.entries) + '.whole_c_unreviewed_state';
        const createHidden = async () => {
          await admin.query('CREATE TABLE ' + hidden + '(tenant_id uuid NOT NULL,value text NOT NULL)');
          await admin.query('INSERT INTO ' + hidden + ' VALUES($1,\'synthetic-a\'),($2,\'synthetic-b\')', [A, B]);
        };
        // Keep physical drift and ledger drift orthogonal: a guard control must
        // fail at its intended boundary, not be masked by the other protection.
        await createHidden();
        const driftRequest = await state.owner.requestDeletion(state.ports.owner, state.args);
        const driftArgs = { ...state.args, requestId: driftRequest.requestId };
        await state.operator.confirmDeletion(state.ports.operator, driftArgs);
        const driftBefore = await physical('C5-known-ledger-drift-before', state.cohort.admission);
        let driftExport, driftErase, driftBackup, acceptedBackup;
        try { await state.cohort.admission.lifecycle.exportTenant(state.ports.operator, { tenant: A, namespaces: state.cohort.ns, sourceCommit: config.sourceHead }); } catch (error) { driftExport = error; }
        try { acceptedBackup = await state.cohort.deployment.backup(admin, { sourceCommit: config.sourceHead }); } catch (error) { driftBackup = error; }
        try { await state.operator.executeDeletion(state.ports.operator, driftArgs); } catch (error) { driftErase = error; }
        const driftAfter = await physical('C5-known-ledger-drift-after-before-verdict', state.cohort.admission);
        emit('C5-known-ledger-drift-effects-before-verdict', { exportCodes: codes(driftExport), backupCodes: codes(driftBackup), eraseCodes: codes(driftErase), backupAccepted: Boolean(acceptedBackup), hiddenRows: (await observer.query('SELECT * FROM ' + hidden + ' ORDER BY tenant_id')).rows });
        assert.ok(codes(driftExport).includes('LIFECYCLE_RELATION_UNADMITTED'), 'WHOLE_C_PHYSICAL_DRIFT_EXPORT_REFUSED');
        assert.ok(codes(driftBackup).includes('OPERATIONS_RELATION_UNADMITTED'), 'WHOLE_C_PHYSICAL_DRIFT_BACKUP_REFUSED');
        assert.ok(codes(driftErase).includes('LIFECYCLE_RELATION_UNADMITTED'), 'WHOLE_C_PHYSICAL_DRIFT_ERASE_REFUSED');
        oracle.sameRows(driftBefore, driftAfter);
        await admin.query('DROP TABLE ' + hidden); // Exact owned fixture fault only.
        // Unknown ledger with otherwise exact physical relations: remove only
        // the ledger guard to calibrate that causal boundary independently.
        await admin.query('INSERT INTO ' + q(state.cohort.ns.entries) + '.schema_migrations(name,checksum) VALUES($1,$2)', [unknownName, unknownChecksum]);
        const build = require('../../../lib/tenant-lifecycle/artifact');
        const poisoned = build.buildArtifact({ tenant: A, sourceCommit: config.sourceHead, exportedAt: state.args.artifact.manifest.exportedAt,
          catalogues: state.args.artifact.manifest.catalogues.map(entry => ({ ...entry,
            ledger: entry.kind === 'entries' ? [...entry.ledger, { name: unknownName, checksum: unknownChecksum }] : entry.ledger,
            tables: entry.tables.map(table => ({ ...table, rows: state.args.artifact.tables[entry.kind + '.' + table.table], secrets: table.keyReferences !== undefined, keyReferences: table.keyReferences })) })) });
        await lifecycle.saveTenantArtifact(poisoned, { directory: state.artifactDirectory });
        const badRequest = await state.owner.requestDeletion(state.ports.owner, { ...state.args, artifact: poisoned });
        const badArgs = { ...state.args, artifact: poisoned, requestId: badRequest.requestId };
        await state.operator.confirmDeletion(state.ports.operator, badArgs);
        const unknownBefore = await physical('C5-unknown-ledger-before', state.cohort.admission);
        let exportFailure, eraseFailure;
        try { await state.cohort.admission.lifecycle.exportTenant(state.ports.operator, { tenant: A, namespaces: state.cohort.ns, sourceCommit: config.sourceHead }); } catch (error) { exportFailure = error; }
        try { await state.operator.executeDeletion(state.ports.operator, badArgs); } catch (error) { eraseFailure = error; }
        const unknownAfter = await physical('C5-unknown-ledger-after-before-verdict', state.cohort.admission);
        emit('C5-unknown-ledger-effects-before-verdict', { exportCodes: codes(exportFailure), eraseCodes: codes(eraseFailure),
          relations: (await observer.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','f','m','v') ORDER BY c.relname", [state.cohort.ns.entries])).rows });
        assert.ok(codes(exportFailure).includes('LIFECYCLE_SCHEMA_UNKNOWN'), 'WHOLE_C_UNKNOWN_EXPORT_REFUSED');
        assert.ok(codes(eraseFailure).includes('LIFECYCLE_SCHEMA_UNKNOWN'), 'WHOLE_C_UNKNOWN_ERASE_REFUSED');
        oracle.sameRows(unknownBefore, unknownAfter);
        await createHidden();
        const combinedBefore = await physical('C5-combined-ledger-physical-before', state.cohort.admission);
        await expectedFailure(() => state.operator.executeDeletion(state.ports.operator, badArgs), 'LIFECYCLE_SCHEMA_UNKNOWN', 'combined-unknown-ledger-physical-drift', () => physical('C5-combined-ledger-physical-after-before-verdict', state.cohort.admission));
        oracle.sameRows(combinedBefore, await physical('C5-combined-ledger-physical-preserved', state.cohort.admission));
        // Restore only this explicitly injected fixture fault; no operator
        // migration rollback or production unknown-schema workaround is implied.
        await admin.query('DELETE FROM ' + q(state.cohort.ns.entries) + '.schema_migrations WHERE name=$1', [unknownName]);
        await admin.query('DROP TABLE ' + hidden);
        const request = await state.owner.requestDeletion(state.ports.owner, state.args);
        await expectedFailure(() => state.operator.claimDeletion(state.ports.operator, { ...state.args, requestId: request.requestId }), 'LIFECYCLE_CONFIRMATION_REQUIRED', 'operator-must-have-confirmation', () => physical('C5-unconfirmed-before-verdict', state.cohort.admission));
        await expectedFailure(() => state.owner.confirmDeletion(state.ports.owner, { ...state.args, requestId: request.requestId }), 'LIFECYCLE_OPERATOR_REQUIRED', 'owner-never-confirms');
        const wrong = { ...state.args, tenant: B, requestId: request.requestId };
        await expectedFailure(() => state.operator.claimDeletion(state.ports.operator, wrong), 'LIFECYCLE_TENANT_MISMATCH', 'foreign-artifact');
        const foreignArtifact = await state.cohort.admission.lifecycle.exportTenant(state.ports.operator, { tenant: B, namespaces: state.cohort.ns, sourceCommit: config.sourceHead });
        await expectedFailure(() => state.operator.claimDeletion(state.ports.operator, { ...state.args, tenant: B, artifact: foreignArtifact, requestId: request.requestId }), 'LIFECYCLE_REQUEST_MISSING', 'actual-foreign-request-RLS', () => physical('C5-foreign-request-before-verdict', state.cohort.admission));
        await race(state, false);
        const claimed = await race(state, true);
        await assert.rejects(state.operator.executeDeletion(state.ports.operator, { ...claimed.options, claimId: claimed.claim.claimId,
          onRow: () => { throw Object.assign(new Error('owned delete interruption'), { code: 'WHOLE_C_DELETE_INTERRUPT' }); } }), { code: 'WHOLE_C_DELETE_INTERRUPT' });
        oracle.sameRows(claimed.rows, await physical('C5-destructive-rollback-before-verdict', state.cohort.admission));
        await expectedFailure(() => state.owner.cancelDeletion(state.ports.owner, claimed.options), 'LIFECYCLE_EXECUTION_STARTED', 'no-reopened-cancel');
        await state.operator.executeDeletion(state.ports.other, { ...claimed.options, claimId: claimed.claim.claimId });
        const final = await physical('C5-deleted-before-verdict', state.cohort.admission);
        for (const [key, table] of Object.entries(final)) {
          assert.deepEqual(table.rows.filter(row => row.tenant_id === B), claimed.rows[key].rows.filter(row => row.tenant_id === B), 'WHOLE_C_FOREIGN_PRESERVED ' + key);
          if (!key.startsWith('lifecycle.')) assert.equal(table.rows.filter(row => row.tenant_id === A).length, 0, 'WHOLE_C_TARGET_DELETED ' + key);
        }
        const ceremony = final['lifecycle.tenant_lifecycle_ceremony'].rows.find(row => row.request_id === claimed.options.requestId);
        assert.equal(ceremony.phase, 'executed');
        const sequenceBefore = (await observer.query('SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname=ANY($1::text[]) ORDER BY schemaname,sequencename', [Object.values(state.cohort.ns)])).rows;
        await expectedFailure(() => state.cohort.admission.lifecycle.importArtifact(state.ports.operator, state.args.artifact, { tenant: A, namespaces: state.cohort.ns }), 'LIFECYCLE_IDENTITY_IMPORT_UNSUPPORTED', 'bound-shared-identity-import', () => physical('C5-identity-import-refusal-before-verdict', state.cohort.admission));
        const sequenceAfter = (await observer.query('SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname=ANY($1::text[]) ORDER BY schemaname,sequencename', [Object.values(state.cohort.ns)])).rows;
        emit('C5-identity-refusal-sequences-before-verdict', { before: sequenceBefore, after: sequenceAfter, tenantRestoreComplete: false });
        assert.deepEqual(sequenceAfter, sequenceBefore, 'WHOLE_C_IMPORT_NO_SEQUENCE_EFFECT');
        oracle.sameRows(final, await physical('C5-identity-refusal-foreign-before-verdict', state.cohort.admission));
        const api = await lowerPort({ connectionString: state.cohort.runtime.urls.api, max: 1, application_name: state.cohort.prefix + '_canonical_writer' });
        owned.ports.add(api);
        try {
          const id = marker();
          const entryPort = require('../../../lib/server/tenant-app/entries')({ connection: api, table: state.cohort.ns.entries + '.entries', source: 'v3', bus: new (require('node:events').EventEmitter)() });
          await scope.withTenant(A, () => entryPort.intentFactory().write({ op: 'create', docs: [{ _id: id, sgv: 123, date: state.cohort.epoch }] }));
          const inserted = (await observer.query('SELECT tenant_id,insertion_ordinal,doc FROM ' + q(state.cohort.ns.entries) + '.entries WHERE tenant_id=$1 AND doc->>\'_id\'=$2', [A, id])).rows;
          const priorCounter = sequenceBefore.find(row => row.schemaname === state.cohort.ns.entries && row.sequencename === 'entries_insertion_ordinal_seq');
          emit('C5-next-canonical-writer-before-verdict', { inserted, priorCounter, scope: 'actual selected entries v3 write-intent component, not HTTP/current-token admission or a completed tenant restore' });
          assert.equal(inserted.length, 1);
          assert.ok(BigInt(inserted[0].insertion_ordinal) > BigInt(priorCounter.last_value), 'WHOLE_C_CANONICAL_NEXT_AFTER_REFUSAL');
          const afterWriter = await physical('C5-canonical-writer-foreign-before-verdict', state.cohort.admission);
          for (const key of Object.keys(final)) assert.deepEqual(afterWriter[key].rows.filter(row => row.tenant_id === B), final[key].rows.filter(row => row.tenant_id === B), 'WHOLE_C_CANONICAL_FOREIGN_PRESERVED ' + key);
        } finally { await api.end(); owned.ports.delete(api); }
        if (config.allocatorResearch === 'private-cache-counterexample-v1') await require('./allocator-research').cachedAllocatorCounterexample({ admin, observer, connectionString: config.connectionString, namespace: state.cohort.ns.lifecycle, emit });

      } finally { await state.close(); }
      // A late write/authority change invalidates this terminal fixture. Do not
      // silently restore policy generations or claim a same-artifact workaround.
      const stale = await fixture();
      try {
        const request = await stale.owner.requestDeletion(stale.ports.owner, stale.args);
        const options = { ...stale.args, requestId: request.requestId };
        await stale.operator.confirmDeletion(stale.ports.operator, options);
        const claim = await stale.operator.claimDeletion(stale.ports.operator, options);
        await admin.query('UPDATE ' + q(stale.cohort.ns.clock) + '.tenant_write_clock SET last_stamp=last_stamp+1 WHERE tenant_id=$1', [A]);
        const before = await physical('C5-late-write-before-refusal', stale.cohort.admission);
        await expectedFailure(() => stale.operator.executeDeletion(stale.ports.operator, { ...options, claimId: claim.claimId }), 'LIFECYCLE_ARTIFACT_STALE', 'late-write');
        oracle.sameRows(before, await physical('C5-late-write-after-before-verdict', stale.cohort.admission));
        await expectedFailure(() => stale.owner.cancelDeletion(stale.ports.owner, options), 'LIFECYCLE_EXECUTION_STARTED', 'late-write-does-not-reopen-cancel');
      } finally { await stale.close(); }
      const revoked = await fixture();
      try {
        const request = await revoked.owner.requestDeletion(revoked.ports.owner, revoked.args), options = { ...revoked.args, requestId: request.requestId };
        await revoked.operator.confirmDeletion(revoked.ports.operator, options);
        const claim = await revoked.operator.claimDeletion(revoked.ports.operator, options);
        await admin.query('BEGIN');
        try {
          await require('../../../lib/operator-policy/fence')(admin, A);
          await admin.query('UPDATE ' + q(revoked.cohort.ns.operator_policy) + ".tenant_operator_policy SET generation=generation+1,policy=jsonb_set(policy,'{wholeCFixtureActors,0,active}', 'false'::jsonb) WHERE tenant_id=$1", [A]);
          await admin.query('COMMIT');
        } catch (error) { await admin.query('ROLLBACK'); throw error; }
        const before = await physical('C5-revoked-authority-before', revoked.cohort.admission);
        await expectedFailure(() => revoked.operator.executeDeletion(revoked.ports.operator, { ...options, claimId: claim.claimId }), 'LIFECYCLE_AUTHORITY_REFUSED', 'current-SQL-authority-revoked');
        oracle.sameRows(before, await physical('C5-revoked-authority-after-before-verdict', revoked.cohort.admission));
      } finally { await revoked.close(); }
    }
  };
  try {
    await observerReady; emit('owned-observer-birth', processIdentity(observerChild.pid));
    assert.equal((await observer.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0].rolsuper, true, 'WHOLE_C_OWNED_TEST_ADMIN_REQUIRED');
    emit('native-server', { version: (await observer.query('SHOW server_version')).rows[0].server_version, sourceHead: config.sourceHead, oldHead: config.oldHead, roleManifest: config.actualRoleManifestSha256 });
    for (const [name, execute] of Object.entries(cases)) {
      if (selected !== 'all' && selected !== name) continue;
      try { await execute(); results.push({ case: name, status: 'passed' }); }
      catch (error) {
        results.push({ case: name, status: 'failed', name: error.name, codes: codes(error), ...(error.name === 'AssertionError' ? { assertion: error.message } : {}) });
        emit('case-failed', results[results.length - 1]); throw error;
      }
    }
  } finally {
    const cleanup = [];
    try { await admin.query('ROLLBACK'); } catch { cleanup.push({ kind: 'transaction', error: 'ROLLBACK' }); }
    for (const port of owned.ports) { try { await port.end(); } catch { cleanup.push({ kind: 'port', error: 'CLOSE' }); } }
    for (const child of owned.children) {
      const before = processIdentity(child.pid);
      if (!before) { cleanup.push({ kind: 'child', pid: child.pid, absent: true }); continue; }
      const birth = owned.births.find(row => row?.pid === child.pid);
      // A process object is held from fork; pid reuse still requires a birth match.
      if (!birth || birth.startTicks !== before.startTicks || birth.uid !== before.uid) { cleanup.push({ kind: 'child', pid: child.pid, error: 'BIRTH_MISMATCH' }); continue; }
      child.kill('SIGCONT'); child.kill('SIGTERM');
      await new Promise(resolve => { const timer = setTimeout(resolve, 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
      const after = processIdentity(child.pid); cleanup.push({ kind: 'child', pid: child.pid, absent: !after });
    }
    for (const namespace of owned.namespaces.slice().reverse()) {
      try { await admin.query('DROP SCHEMA IF EXISTS ' + q(namespace) + ' CASCADE'); cleanup.push({ kind: 'namespace', namespace, absent: !(await observer.query('SELECT to_regnamespace($1) AS found', [namespace])).rows[0].found }); }
      catch (error) { cleanup.push({ kind: 'namespace', namespace, error: error.code || 'CLEANUP' }); }
    }
    for (const role of owned.roles.slice().reverse()) {
      try { await admin.query('DROP OWNED BY ' + q(role)); await admin.query('DROP ROLE ' + q(role)); cleanup.push({ kind: 'role', role, absent: Number((await observer.query('SELECT count(*) AS n FROM pg_roles WHERE rolname=$1', [role])).rows[0].n) === 0 }); }
      catch (error) { cleanup.push({ kind: 'role', role, error: error.code || 'CLEANUP' }); }
    }
    emit('cleanup', cleanup);
    fs.writeFileSync(path.join(config.captureDirectory, 'result.json'), JSON.stringify({ sourceHead: config.sourceHead, selected, results, cleanup, runtimeScope: 'owned SQL core only; no serving/journey/provider or whole-programme acceptance' }, null, 2) + '\n');
    await admin.end(); await observer.end();
    assert.ok(cleanup.every(item => item.absent === true), 'WHOLE_C_CLEANUP_INCOMPLETE');
  }
  return results;
}
module.exports = { run };
