'use strict';
const { name } = require('./config');
const catalogue = require('./postgres-candidate.json');
const q = value => '"' + value + '"';
const fail = code => { throw Object.assign(new Error(code),{ code }); };
const functions = catalogue.migrations[0].up.filter(sql => sql.startsWith('CREATE FUNCTION'));
const sources = functions.map(sql => /AS \$fn\$(.*)\$fn\$$/s.exec(sql)[1]);
const signatures = ['feed_peek(integer,integer,integer)','feed_advance(pg_lsn)'];
function provision ({ namespace, clockNamespace, activityNamespace, slot, publication, owner, reader }) {
  if ([namespace,clockNamespace,activityNamespace,slot,publication,owner,reader].some(v => !name(v)) || owner === reader) throw new TypeError('Explicit feed deployment identities required');
  return Object.freeze([
    'CREATE PUBLICATION ' + q(publication) + ' FOR TABLE ' + q(clockNamespace) + '.tenant_write_clock, ' + q(activityNamespace) + '.tenant_activity WITH (publish = \'insert,update,delete\')',
    'SELECT pg_create_logical_replication_slot(\'' + slot + '\', \'pgoutput\')',
    'ALTER ROLE ' + q(reader) + ' SET temp_file_limit = \'64MB\'',
    'ALTER ROLE ' + q(reader) + ' SET logical_decoding_work_mem = \'64kB\'',
    ...signatures.flatMap(sig => ['ALTER FUNCTION ' + q(namespace) + '.' + sig + ' OWNER TO ' + q(owner),
      'ALTER FUNCTION ' + q(namespace) + '.' + sig + ' SET nightscout.feed_slot = \'' + slot + '\'',
      'ALTER FUNCTION ' + q(namespace) + '.' + sig + ' SET nightscout.feed_publication = \'' + publication + '\'',
      'GRANT EXECUTE ON FUNCTION ' + q(namespace) + '.' + sig + ' TO ' + q(reader)]),
    'GRANT USAGE ON SCHEMA ' + q(namespace) + ' TO ' + q(reader),
    'GRANT USAGE ON SCHEMA ' + q(clockNamespace) + ', ' + q(activityNamespace) + ' TO ' + q(owner),
    'GRANT SELECT ON ' + q(clockNamespace) + '.tenant_write_clock, ' + q(activityNamespace) + '.tenant_activity TO ' + q(owner)
  ]);
}
// This client is intentionally not a tenant data connection. A fixed wrapper is
// the only replication authority of its NOREPLICATION login; all hints are metadata.
async function create (config, { Client = require('pg').Client } = {}) {
  const client = new Client({ connectionString: config.connectionString, application_name: 'nightscout-feed-reader',
    connectionTimeoutMillis: config.statementTimeoutMs, query_timeout: config.statementTimeoutMs + 1000,
    options: '-c statement_timeout=' + config.statementTimeoutMs + ' -c work_mem=64kB -c idle_in_transaction_session_timeout=5000' });
  client.on('error',() => {});
  await client.connect();
  const schema = q(config.namespace);
  let closed = false;
  async function safe () {
    const result = await client.query(`SELECT p.proname,p.prosrc,p.prosecdef,p.proconfig,l.lanname,
      r.rolname,r.rolcanlogin,r.rolsuper,r.rolbypassrls,r.rolreplication,
      pg_has_role(current_user,p.proowner,'MEMBER') AS member,
      EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute,
      EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=current_user) AND a.privilege_type='EXECUTE') AS extra_execute
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner JOIN pg_language l ON l.oid=p.prolang
      WHERE p.oid IN (to_regprocedure($1),to_regprocedure($2))`,signatures.map(sig => config.namespace + '.' + sig));
    const expected = ['search_path=pg_catalog','nightscout.feed_slot='+config.slot,'nightscout.feed_publication='+config.publication].sort();
    if (result.rows.length !== 2 || result.rows.some(row => {
      const index = row.proname === 'feed_peek' ? 0 : row.proname === 'feed_advance' ? 1 : -1;
      return index < 0 || row.prosrc !== sources[index] || !row.prosecdef || row.lanname !== 'plpgsql' ||
        row.rolname !== config.owner || row.rolcanlogin || row.rolsuper || row.rolbypassrls || !row.rolreplication || row.member || row.public_execute || row.extra_execute ||
        JSON.stringify((row.proconfig || []).map(v => v.replace(/"/g,'')).sort()) !== JSON.stringify(expected);
    })) fail('FEED_WRAPPER_UNSAFE');
    const identity = (await client.query(`SELECT rolsuper,rolbypassrls,rolreplication,
      current_setting('statement_timeout') AS timeout,current_setting('temp_file_limit') AS temp,
      current_setting('logical_decoding_work_mem') AS decoding FROM pg_roles WHERE rolname=current_user`)).rows[0];
    const settings = Object.fromEntries((await client.query("SELECT name,setting FROM pg_settings WHERE name IN ('statement_timeout','max_slot_wal_keep_size')")).rows.map(row => [row.name,Number(row.setting)]));
    if (settings.statement_timeout !== config.statementTimeoutMs || settings.max_slot_wal_keep_size < 1 || settings.max_slot_wal_keep_size > 1024) fail('FEED_RESOURCE_CONFIGURATION_UNSAFE');
    if (!identity || identity.rolsuper || identity.rolbypassrls || identity.rolreplication ||
        !['64MB','65536kB'].includes(identity.temp) || !['64kB'].includes(identity.decoding)) fail('FEED_IDENTITY_UNSAFE');
    const publication = (await client.query(`SELECT p.puballtables,p.pubinsert,p.pubupdate,p.pubdelete,p.pubtruncate,p.pubviaroot,
      EXISTS (SELECT 1 FROM pg_publication_rel pr WHERE pr.prpubid=p.oid AND (pr.prqual IS NOT NULL OR pr.prattrs IS NOT NULL)) AS filtered,
      ARRAY(SELECT n.nspname||'.'||c.relname FROM pg_publication_rel pr JOIN pg_class c ON c.oid=pr.prrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE pr.prpubid=p.oid ORDER BY 1) AS tables
      FROM pg_publication p WHERE pubname=$1`,[config.publication])).rows[0];
    if (!publication || publication.puballtables || !publication.pubinsert || !publication.pubupdate || !publication.pubdelete || publication.pubtruncate || publication.pubviaroot || publication.filtered ||
        JSON.stringify(publication.tables) !== JSON.stringify([config.clockNamespace+'.tenant_write_clock',config.activityNamespace+'.tenant_activity'].sort())) fail('FEED_PUBLICATION_UNSAFE');
    const slot = (await client.query('SELECT slot_type,plugin,database,wal_status FROM pg_replication_slots WHERE slot_name=$1',[config.slot])).rows[0];
    if (!slot || slot.slot_type !== 'logical' || slot.plugin !== 'pgoutput' || !['reserved','extended'].includes(slot.wal_status) ||
        slot.database !== (await client.query('SELECT current_database() AS name')).rows[0].name) fail('FEED_SLOT_UNSAFE');
  }
  try {
    await safe();
    if (!(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[config.namespace+'.'+config.slot])).rows[0].locked) fail('FEED_READER_ALREADY_RUNNING');
  } catch (error) { await client.end(); throw error; }
  return Object.freeze({
    async peek () { await safe(); try { return (await client.query('SELECT lsn::text,data FROM ' + schema + '.feed_peek($1,$2,$3)',[config.targetChanges,config.maxMessages,config.maxBytes])).rows; }
      catch (error) { if (error?.message === 'FEED_BATCH_BOUNDS') fail('FEED_BATCH_BOUNDS'); throw error; } },
    async notify (payloads) {
      await client.query('BEGIN');
      try { for (const payload of payloads) await client.query('SELECT pg_notify($1,$2)',[config.channel,JSON.stringify(payload)]); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    },
    async advance (upto) { await safe(); return (await client.query('SELECT ' + schema + '.feed_advance($1)::text AS lsn',[upto])).rows[0].lsn; },
    close: async () => { if (!closed) { closed = true; await client.end(); } }
  });
}
module.exports = { create, provision, catalogue, signatures, sources };
