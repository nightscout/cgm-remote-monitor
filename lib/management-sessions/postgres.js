'use strict';

const { selected, q, BODY, FUNCTION, SIGNATURE, OWNER, searchPath, grants } = require('./authority');
const connect = require('../storage/postgres-connection');
const scope = require('../storage/tenant-scope');
const phase = require('../tenant-lifecycle/tenant-phase');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const named = value => typeof value === 'string' && NAME.test(value);
const fail = code => Object.assign(new Error(code), { code });
const canonical = value => String(value).replace(/\s+/g, ' ').trim();
const schema = require('../tenant-authorization/access-candidate.json');
const table = (namespace, name) => q(namespace) + '.' + q(name);

async function createStore ({ connectionString, namespaces: ns, consumer, actor, maxLifetimeSeconds = 600, now = () => Math.floor(Date.now() / 1000) }) {
  selected(ns);
  if (scope.getTenancyMode() !== 'multi' || !named(consumer) || !actor || !named(actor.principal) || !named(actor.consumer) ||
      !Number.isSafeInteger(maxLifetimeSeconds) || maxLifetimeSeconds < 1 || maxLifetimeSeconds > 600 || typeof now !== 'function') throw new TypeError('Explicit management-session policy, identity and current clock required');
  const connection = await connect({ connectionString, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 10000,
    application_name: 'nightscout-management-sessions' });
  const access = name => table(ns.access, name), fn = q(ns.access) + '.' + FUNCTION;
  let closed = false;
  async function assertSafe () {
    const result = await connection.withTenant('00000000-0000-0000-0000-000000000000', async () => {
      const metadata = (await connection.query(`SELECT p.oid,p.proowner,p.prosrc,p.prosecdef,p.provolatile,p.proretset,p.proargnames,p.proallargtypes,p.proargmodes,
        p.proconfig,l.lanname,r.rolcanlogin,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,
        pg_has_role(current_user,p.proowner,'MEMBER') AS owns,has_function_privilege(p.oid,'EXECUTE') AS executes,
        EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_executes
        FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=to_regprocedure($1)`, [fn + SIGNATURE])).rows[0];
      if (!metadata || canonical(metadata.prosrc) !== canonical(BODY) || !metadata.prosecdef || metadata.provolatile !== 'v' || !metadata.proretset || metadata.lanname !== 'plpgsql' ||
          metadata.rolcanlogin || metadata.rolsuper || metadata.rolbypassrls || metadata.rolcreatedb || metadata.rolcreaterole || metadata.rolreplication || metadata.owns || !metadata.executes || metadata.public_executes ||
          JSON.stringify(metadata.proargnames) !== JSON.stringify(['target_tenant', 'target_subject', 'target_consumer', 'kid', 'public_key']) ||
          !Array.isArray(metadata.proconfig) || metadata.proconfig.length !== 1 || metadata.proconfig[0].replace(/[\s"]/g, '') !== 'search_path=' + searchPath(ns).join(',')) throw fail('MANAGEMENT_SESSION_UNSAFE');
      const owner = new Map();
      for (const [kind, tables] of Object.entries(OWNER)) for (const [name, column] of Object.entries(tables)) owner.set(table(ns[kind], name), column ? [column] : []);
      const issuer = new Map([
        [access('schema_migrations'), { insert: false, updates: [] }],
        [access('access_credentials'), { insert: true, updates: ['enabled', 'generation'] }],
        [access('access_sessions'), { insert: true, updates: ['active', 'expires_at', 'generation'] }],
        [access('management_session_requests'), { insert: true, updates: [] }],
        ...phase.TABLES.map(name => [table(ns.control, name), { insert: false, updates: [] }])
      ]);
      const refs = [...new Set([...owner.keys(), ...issuer.keys()])];
      const rows = (await connection.query(`SELECT c.oid,c.relrowsecurity AND c.relforcerowsecurity AS secured,pg_has_role(current_user,c.relowner,'MEMBER') AS owns,
        pg_has_role($2::oid,c.relowner,'MEMBER') AS owner_owns,
        has_table_privilege(c.oid,'SELECT') AS reads,has_table_privilege(c.oid,'INSERT') AS inserts,
        has_table_privilege(c.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(c.oid,'REFERENCES') AS mutates,
        ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(c.oid,a.attnum,'UPDATE') ORDER BY a.attname) AS updates,
        has_table_privilege($2::oid,c.oid,'SELECT') AS owner_reads,
        has_table_privilege($2::oid,c.oid,'INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($2::oid,c.oid,'INSERT,REFERENCES') AS owner_mutates,
        ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege($2::oid,c.oid,a.attnum,'UPDATE') ORDER BY a.attname) AS owner_updates
        FROM pg_class c WHERE c.oid=ANY($1::regclass[])`, [refs, metadata.proowner])).rows;
      if (rows.length !== refs.length) throw fail('MANAGEMENT_SESSION_UNSAFE');
      const ids = (await connection.query('SELECT x.ref,to_regclass(x.ref)::oid AS oid FROM unnest($1::text[]) x(ref)', [refs])).rows;
      const names = new Map(ids.map(row => [row.oid, row.ref]));
      for (const row of rows) {
        const name = names.get(row.oid), login = issuer.get(name), locked = owner.get(name);
        if ((!row.secured && name !== access('schema_migrations')) || row.owns || row.owner_owns || row.mutates || row.owner_mutates || row.reads !== !!login || row.inserts !== !!login?.insert ||
            JSON.stringify(row.updates) !== JSON.stringify(login?.updates || []) || row.owner_reads !== !!locked ||
            JSON.stringify(row.owner_updates) !== JSON.stringify(locked || [])) throw fail('MANAGEMENT_SESSION_UNSAFE');
      }
      const extra = (await connection.query(`SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND p.oid<>$1::oid AND has_function_privilege(p.oid,'EXECUTE')) AS executes,
        EXISTS(SELECT 1 FROM pg_roles r WHERE (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication) AND
          (pg_has_role($2::oid,r.oid,'MEMBER') OR pg_has_role(current_user,r.oid,'MEMBER'))) AS elevated,
        has_database_privilege(current_database(),'CREATE') OR has_database_privilege($2::oid,current_database(),'CREATE') OR
        EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND
          (has_schema_privilege(n.oid,'CREATE') OR has_schema_privilege($2::oid,n.oid,'CREATE'))) AS creates,
        EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid<>ALL($3::regclass[])
          AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f') AND
          (has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES') OR
           has_table_privilege($2::oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($2::oid,c.oid,'INSERT,UPDATE,REFERENCES') OR
           (c.relrowsecurity OR c.relname=ANY(ARRAY['entries','treatments','devicestatus','profile','food','activity','tenant_write_clock','tenant_insertion_ordinal'])) AND
             (has_table_privilege(c.oid,'SELECT') OR has_table_privilege($2::oid,c.oid,'SELECT')))) AS foreign_data`, [metadata.oid, metadata.proowner, refs])).rows[0];
      if (extra.executes || extra.elevated || extra.creates || extra.foreign_data) throw fail('MANAGEMENT_SESSION_UNSAFE');
      const ledger = (await connection.query('SELECT name,checksum FROM ' + access('schema_migrations') + ' ORDER BY name COLLATE "C"')).rows;
      const expected = require('../migrations/catalogue').validateCatalogue(schema);
      if (ledger.length !== expected.length || ledger.some((row, i) => row.name !== expected[i].name || row.checksum !== expected[i].checksum)) throw fail('MANAGEMENT_SESSION_UNSAFE');
      return true;
    });
    if (!result) throw fail('MANAGEMENT_SESSION_UNSAFE');
  }
  try { await assertSafe(); }
  catch (error) { await connection.end(); throw fail(error.code === 'MANAGEMENT_SESSION_UNSAFE' ? error.code : 'MANAGEMENT_SESSION_UNAVAILABLE'); }

  return Object.freeze({
    async issue ({ tenant, subjectId, requestId, lifetimeSeconds = maxLifetimeSeconds }, sign) {
      if (closed) throw fail('MANAGEMENT_SESSION_UNAVAILABLE');
      if (!UUID.test(tenant || '') || !UUID.test(requestId || '') || !named(subjectId) || !Number.isSafeInteger(lifetimeSeconds) ||
          lifetimeSeconds < 1 || lifetimeSeconds > maxLifetimeSeconds || typeof sign !== 'function') throw fail('MANAGEMENT_SESSION_INVALID');
      try {
        await assertSafe();
        return await connection.withTenant(tenant, async () => {
          await connection.query("SET LOCAL synchronous_commit='on'");
          if (!(await phase.tenantPhase(connection, { namespace: ns.control, tenant, hold: true })).active) throw fail('MANAGEMENT_SESSION_REFUSED');
          await connection.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", ['management-session:' + ns.access, tenant + ':' + requestId]);
          const keys = (await connection.query('SELECT * FROM ' + fn + '($1,$2,$3)', [tenant, subjectId, consumer])).rows;
          let record = (await connection.query('SELECT * FROM ' + access('management_session_requests') + ' WHERE tenant_id=$1 AND request_id=$2', [tenant, requestId])).rows[0];
          const existing = !!record;
          if (existing) {
            if (record.subject_id !== subjectId || record.consumer !== consumer || record.lifetime_seconds !== lifetimeSeconds) throw fail('MANAGEMENT_SESSION_CONFLICT');
            const state = (await connection.query('SELECT c.enabled,c.generation,c.subject_id AS credential_subject,s.generation AS session_generation,s.active,s.expires_at,s.purpose,s.subject_id FROM ' + access('access_credentials') + ' c JOIN ' + access('access_sessions') +
              ' s ON s.tenant_id=c.tenant_id AND s.credential_id=c.credential_id WHERE c.tenant_id=$1 AND c.credential_id=$2 AND s.session_id=$3 FOR SHARE OF c,s', [tenant, record.credential_id, record.session_id])).rows[0];
            if (!state?.enabled || !state.active || state.generation !== record.credential_generation || state.session_generation !== record.credential_generation || state.credential_subject !== subjectId || state.subject_id !== subjectId || state.purpose !== 'management' ||
                Number(state.expires_at) !== Number(record.expires_at)) throw fail('MANAGEMENT_SESSION_REFUSED');
          } else {
            const issued = now();
            if (!Number.isSafeInteger(issued) || issued < 0 || !Number.isSafeInteger(issued + lifetimeSeconds)) throw fail('MANAGEMENT_SESSION_INVALID');
            record = { tenant_id: tenant, request_id: requestId, subject_id: subjectId, consumer, credential_id: 'management_' + requestId.replaceAll('-', ''), session_id: requestId,
              credential_generation: 1, issued_at: issued, expires_at: issued + lifetimeSeconds, lifetime_seconds: lifetimeSeconds };
          }
          if (![Number(record.issued_at), Number(record.expires_at), record.credential_generation].every(Number.isSafeInteger) ||
              record.credential_generation < 1 || Number(record.expires_at) - Number(record.issued_at) !== lifetimeSeconds || Number(record.issued_at) > now() ||
              record.session_id !== requestId || record.credential_id !== 'management_' + requestId.replaceAll('-', '')) throw fail('MANAGEMENT_SESSION_REFUSED');
          if (Number(record.expires_at) <= now()) throw fail('MANAGEMENT_SESSION_EXPIRED');
          const signed = await sign({ record, keys, existing });
          if (!signed || typeof signed.token !== 'string' || !named(signed.kid) || !Number.isSafeInteger(signed.keyVersion) || signed.keyVersion < 1 ||
              existing && (signed.kid !== record.kid || signed.keyVersion !== record.key_version)) throw fail('MANAGEMENT_SESSION_REFUSED');
          if (Number(record.expires_at) <= now()) throw fail('MANAGEMENT_SESSION_EXPIRED');
          if (!(await phase.tenantPhase(connection, { namespace: ns.control, tenant })).active) throw fail('MANAGEMENT_SESSION_REFUSED');
          if (!existing) {
            await connection.query('INSERT INTO ' + access('access_credentials') + '(tenant_id,credential_id,subject_id,generation,enabled) VALUES($1,$2,$3,1,true)', [tenant, record.credential_id, subjectId]);
            await connection.query('INSERT INTO ' + access('access_sessions') + '(tenant_id,session_id,subject_id,credential_id,generation,expires_at,active,purpose) VALUES($1,$2,$3,$4,1,$5,true,\'management\')', [tenant, record.session_id, subjectId, record.credential_id, record.expires_at]);
            await connection.query('INSERT INTO ' + access('management_session_requests') +
              '(tenant_id,request_id,subject_id,consumer,credential_id,session_id,credential_generation,issued_at,expires_at,kid,key_version,lifetime_seconds,operator_principal,operator_consumer) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13)',
            [tenant, requestId, subjectId, consumer, record.credential_id, record.session_id, record.issued_at, record.expires_at, signed.kid, signed.keyVersion, lifetimeSeconds, actor.principal, actor.consumer]);
          }
          return Object.freeze({ token: signed.token, expiresAt: Number(record.expires_at), sessionId: record.session_id, requestId, outcome: existing ? 'existing' : 'created' });
        });
      } catch (error) {
        if (/^MANAGEMENT_SESSION_/.test(error.code || '')) throw error;
        if (error.code === 'P0001') throw fail('MANAGEMENT_SESSION_REFUSED');
        throw fail('MANAGEMENT_SESSION_UNAVAILABLE');
      }
    },
    async close () { closed = true; await connection.end(); }
  });
}
module.exports = { createStore, grants };
