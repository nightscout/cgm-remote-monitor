'use strict';

const assert = require('node:assert/strict');
const replicas = require('./multitenant-preview-replicas');
const { layout } = require('../../lib/server/serve/deployment-settings');

module.exports = function clientReplayHTTP () {
  const lab = replicas();
  const [A, B] = lab.tenants;
  const domains = ['entries', 'treatments', 'devicestatus', 'profile'];
  const permissions = domains.flatMap(domain => ['read', 'create', 'update', 'delete'].map(action => 'api:' + domain + ':' + action));
  let namespaces;

  async function open () {
    await lab.setup();
    namespaces = layout({ NS_PG_PREFIX: lab.platform.prefix }).namespaces;
  }
  async function rows (domain, tenant = A) {
    assert.ok(domains.includes(domain));
    return (await lab.admin.query(`SELECT doc FROM ${namespaces[domain]}.${domain}
      WHERE tenant_id=$1 ORDER BY "_id",id_kind`, [tenant])).rows.map(row => row.doc);
  }
  async function grants (permissions, tenant = A) {
    const result = await lab.admin.query(`UPDATE ${namespaces.authorization}.tenant_authorization_roles
      SET permissions=$1 WHERE tenant_id=$2 AND name='viewer'`, [permissions, tenant]);
    assert.equal(result.rowCount, 1, 'changed the registered synthetic subject role');
  }
  async function reset () {
    for (const domain of domains) await lab.admin.query(`DELETE FROM ${namespaces[domain]}.${domain}`);
    for (const tenant of lab.tenants) await grants(permissions, tenant);
  }
  return { A, B, open, close: lab.cleanup, start: lab.start, ready: lab.ready, stop: lab.stop, http: lab.http, exchange: lab.exchange,
    rows, reset, grants, credential: lab.subjectCredential, rootCredential: lab.rootCredential, permissions };
};
