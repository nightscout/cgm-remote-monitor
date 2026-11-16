'use strict';

const definition = require('./recommission-candidate');
const canonical = require('./catalogue-structure');
const publicRoles = require('../storage/postgres-public-policy-roles');
const { READS } = require('./pool-authority');
const { TABLE } = definition;
const LAYOUT = Object.freeze([
  ['tenant_id', 'uuid', true], ['request_id', 'uuid', true], ['claim_id', 'uuid', true],
  ['generation', 'bigint', true], ['artifact_digest', 'text', true], ['activated', 'boolean', true, 'false']
].map(Object.freeze));
const INSERT = Object.freeze(['tenant_id', 'request_id', 'claim_id', 'generation', 'artifact_digest']);
const CONSTRAINTS = Object.freeze([
  'PRIMARY KEY (request_id)', 'UNIQUE (claim_id)',
  'FOREIGN KEY (tenant_id) REFERENCES tenant_lifecycle_windows(tenant_id)',
  'FOREIGN KEY (request_id) REFERENCES tenant_lifecycle_requests(request_id)',
  'FOREIGN KEY (claim_id) REFERENCES tenant_lifecycle_restore_audit(claim_id)',
  'CHECK (generation > 0)', "CHECK (artifact_digest ~ '^[a-f0-9]{64}$'::text)"
]);
function policies () {
  return [
    { command: 'r', using: definition.tenant, check: null },
    { command: 'a', using: null, check: definition.tenant + ' AND activated = false AND ' + definition.authority + ' AND ' + definition.insertRecord + ' AND EXISTS (SELECT 1 FROM tenant_lifecycle_restore_audit r WHERE ' + definition.auditMatch + " AND r.state = 'suspended' AND " + definition.owner + ')' },
    { command: 'w', using: definition.tenant + ' AND activated = false AND ' + definition.authority, check: definition.tenant + ' AND activated = true AND ' + definition.authority + ' AND ' + definition.activation }
  ];
}
const fail = () => { throw Object.assign(new Error('LIFECYCLE_WINDOW_SCHEMA_UNSAFE'), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' }); };
function validate (row, namespace, maintenance) {
  if (!row || !row.oid || row.kind !== 'r' || row.persistence !== 'p' || row.owns !== false || row.reads !== maintenance || !row.secured ||
      row.broad_writes !== false || row.triggers !== false || row.rules !== false || row.inherited !== false || row.bad_indexes !== false || row.dropped !== false || row.owner_safe !== true ||
      !Array.isArray(row.columns) || row.columns.length !== LAYOUT.length) fail();
  LAYOUT.forEach(([name, type, required, expression], index) => {
    const column = row.columns[index];
    if (!column || column.name !== name || column.type !== type || column.not_null !== required || column.identity !== '' || column.generated !== '' ||
        canonical(column.default, namespace) !== canonical(expression || null, namespace) ||
        column.reads !== (maintenance || READS[TABLE].includes(name)) || column.inserts !== (maintenance && INSERT.includes(name)) || column.updates !== (maintenance && name === 'activated')) fail();
  });
  if (!Array.isArray(row.constraints) || row.constraints.some(constraint => !constraint.valid || constraint.deferrable) ||
      JSON.stringify(row.constraints.map(constraint => canonical(constraint.definition, namespace)).sort()) !== JSON.stringify(CONSTRAINTS.map(value => canonical(value, namespace)).sort())) fail();
  const expected = policies();
  if (!Array.isArray(row.policies) || row.policies.length !== expected.length) fail();
  for (const policy of expected) {
    const actual = row.policies.find(value => value.command === policy.command);
    if (!actual || !actual.permissive || !publicRoles(actual.roles) || canonical(actual.using, namespace) !== canonical(policy.using, namespace) || canonical(actual.check, namespace) !== canonical(policy.check, namespace)) fail();
  }
}
function operatorGrants ({ namespace, role }) {
  const who = '"' + role + '"', table = '"' + namespace + '".' + TABLE;
  if (![namespace, role].every(value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(value)) || namespace === 'public' || namespace.startsWith('pg_') || namespace === 'information_schema') throw new TypeError('LIFECYCLE_RECOMMISSION_GRANTS');
  return Object.freeze([
    'GRANT SELECT ON ' + table + ' TO ' + who,
    'GRANT INSERT (' + INSERT.join(',') + '), UPDATE (activated) ON ' + table + ' TO ' + who,
    'GRANT SELECT (artifact_digest) ON "' + namespace + '".tenant_lifecycle_key_retention TO ' + who
  ]);
}
module.exports = { TABLE, LAYOUT, INSERT, CONSTRAINTS, policies, validate, operatorGrants };
