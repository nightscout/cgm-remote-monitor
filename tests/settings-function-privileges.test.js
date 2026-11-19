'use strict';
const assert = require('node:assert/strict');
const { prepareAcl } = require('../tools/lab/tenant-whole-c/fixture-acl');
const { writerGrants } = require('../lib/tenant-settings/function-privileges');
const steps = [{ kind: 'tenant_settings', namespace: 'restored_settings', tables: ['tenant_settings', 'tenant_settings_history', 'tenant_connector_sources'] }];
const work = steps[0].tables.map(table => ({ kind: 'tenant_settings', table, columns: [{ name: 'values' }, { name: 'version' }] }));
async function statements (grant) {
  return (await prepareAcl(null, steps, work, { grants: [{ role: 'settings_actor', kind: 'tenant_settings', privileges: [], ...grant }] })).statements;
}
describe('settings validator execution follows declared restore writers', function () {
  it('retains INSERT and UPDATE writers including column grants for current state and history', async function () {
    for (const table of ['tenant_settings', 'tenant_settings_history']) {
      for (const privilege of ['INSERT', 'UPDATE']) {
        for (const declaration of [{ privileges: [privilege] }, { columnPrivileges: { [privilege]: ['values'] } }]) {
          assert.ok((await statements({ table, ...declaration })).includes(writerGrants({ namespace: 'restored_settings', role: 'settings_actor' })[0]));
        }
      }
    }
  });
  it('readers, deletion-only actors, ledgers and connector writers gain no validator execution', async function () {
    for (const declaration of [
      { table: 'tenant_settings', privileges: ['SELECT'] },
      { table: 'tenant_settings_history', columnPrivileges: { SELECT: ['values'] } },
      { table: 'tenant_settings', privileges: ['DELETE'] },
      { table: 'schema_migrations', privileges: ['SELECT'] },
      { table: 'tenant_connector_sources', privileges: ['INSERT', 'UPDATE'] }
    ]) assert.ok(!(await statements(declaration)).some(sql => sql.includes('GRANT EXECUTE')));
  });
  it('legacy broad settings writers retain execution and unsafe helper names refuse', async function () {
    const result = await prepareAcl(null, steps, work, { role: 'settings_actor' });
    assert.ok(result.statements.includes(writerGrants({ namespace: 'restored_settings', role: 'settings_actor' })[0]));
    for (const name of ['public', 'pg_temp', 'bad"name']) assert.throws(() => writerGrants({ namespace: name, role: 'settings_actor' }), TypeError);
  });
});
