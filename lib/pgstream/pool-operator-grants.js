'use strict';
// Assignment control sees only the known completed consumer's metadata across
// tenants. It receives no clinical projection/output/receipt/ACK privilege.
const profiles = require('./pool-intake-profile');
const worker = require('./pool-worker-grants');
const READS = Object.freeze(['tenant_id', 'consumer', 'work_owner_ordinal', 'work_assignment_revision']);
const UPDATES = Object.freeze(['work_owner_ordinal', 'work_assignment_revision']);
const DESIRED_UPDATES = Object.freeze(['members', 'previous_members', 'revision', 'updated_at', 'partitioned', 'previous_partitioned']);
const q = value => '"' + value + '"';
function expression (profile) { return "consumer='" + profiles.validate(profile).binding.consumer + "-completed'"; }
function policies (profile) { return Object.freeze({ prefix: 'pgstream_pool_operator_', suffix: '', expression: expression(profile) }); }
function build ({ role, profile }) {
  const p = profiles.validate(profile), b = p.binding;
  if (role !== b.operatorRole) throw new TypeError('PGSTREAM_POOL_OPERATOR_PRINCIPAL');
  const principal = q(role), table = q(b.namespace) + '.tenant_consumer_checkpoint', policy = policies(p);
  return Object.freeze([
    ...[b.namespace, b.membershipNamespace, b.lifecycleNamespace].map(namespace => 'GRANT USAGE ON SCHEMA ' + q(namespace) + ' TO ' + principal),
    'GRANT SELECT(' + READS.join(',') + '),UPDATE(' + UPDATES.join(',') + ') ON ' + table + ' TO ' + principal,
    ...['restrict', 'allow'].map(kind => 'CREATE POLICY ' + policy.prefix + kind + ' ON ' + table + ' AS ' + (kind === 'restrict' ? 'RESTRICTIVE' : 'PERMISSIVE') + ' FOR ALL TO ' + principal + ' USING (' + policy.expression + ') WITH CHECK (' + policy.expression + ')'),
    ...Object.entries(worker.lifecycleReads(p)).map(([relation, columns]) => 'GRANT SELECT(' + columns.join(',') + ') ON ' + q(b.lifecycleNamespace) + '.' + relation + ' TO ' + principal),
    ...[[b.namespace, 'schema_migrations', worker.LEDGER], [b.namespace, 'pgstream_intake_profile', worker.PROFILE], [b.membershipNamespace, 'schema_migrations', worker.LEDGER], [b.membershipNamespace, 'pool_membership', worker.MEMBERS]].map(([namespace, relation, columns]) => 'GRANT SELECT(' + columns.join(',') + ') ON ' + q(namespace) + '.' + relation + ' TO ' + principal),
    'GRANT SELECT(' + worker.DESIRED.join(',') + '),UPDATE(' + DESIRED_UPDATES.join(',') + ') ON ' + q(b.membershipNamespace) + '.pool_desired TO ' + principal
  ]);
}
async function assertReady (query, { profile } = {}) {
  const p = profiles.validate(profile), b = p.binding;
  const principal = await worker.assertRole(query, { profile: p, expectedRole: b.operatorRole, operator: true });
  await worker.assertRelations(query, p, { worker: false });
  await worker.assertPolicies(query, p, policies(p));
  await worker.assertProfile(query, p);
  return Object.freeze({ principal, profile: p.digest });
}
module.exports = { build, assertReady, expression, READS, UPDATES, DESIRED_UPDATES, lifecycleReads: worker.lifecycleReads };
