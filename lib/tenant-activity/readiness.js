'use strict';
// Shared, unchanged capability screen. Ordinary activity construction retains
// its lower connection's NOSUPERUSER/NOBYPASSRLS admission; the fixed publication
// reader performs that check on its one admitted backend before using this.
const NAME=/^[a-z][a-z0-9_]{0,62}$/;
async function screen(client,namespace,capability){
  if(typeof namespace!=='string'||!NAME.test(namespace)||['public','information_schema'].includes(namespace)||namespace.startsWith('pg_')||!['reader','owner','operator'].includes(capability))throw new TypeError('Explicit activity screen required');
  const table='"'+namespace+'".tenant_activity',audit='"'+namespace+'".tenant_activity_audit';
  const rows=(await client.query(`
      SELECT c.oid = to_regclass($1) AS current_state, c.relrowsecurity AND c.relforcerowsecurity AS secured,
        pg_has_role(current_user,c.relowner,'MEMBER') AS owns, has_table_privilege(c.oid,'SELECT') AS reads,
        has_table_privilege(c.oid,'INSERT') AS inserts,
        has_table_privilege(c.oid,'DELETE,TRUNCATE,TRIGGER,REFERENCES') AS destroys,
        ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
          AND has_column_privilege(c.oid,a.attnum,'UPDATE') ORDER BY a.attname) AS updates
      FROM pg_class c WHERE c.oid IN (to_regclass($1), to_regclass($2))`,[table,audit])).rows;
  const state = rows.find(row => row.current_state), log = rows.find(row => !row.current_state);
  const expected = {
    reader: { stateInsert: false, stateUpdates: [], logInsert: false },
    owner: { stateInsert: false, stateUpdates: ['paused', 'version'], logInsert: true },
    operator: { stateInsert: true, stateUpdates: ['paused', 'suspended', 'version'], logInsert: true }
  }[capability];
  if (rows.length !== 2 || rows.some(row => !row.secured || row.owns || row.destroys) || !state.reads ||
    state.inserts !== expected.stateInsert || JSON.stringify(state.updates) !== JSON.stringify(expected.stateUpdates) ||
    log.inserts !== expected.logInsert || log.updates.length) throw Object.assign(new Error('ACTIVITY_STORE_UNSAFE'),{code:'ACTIVITY_STORE_UNSAFE'});
}
module.exports={screen};
