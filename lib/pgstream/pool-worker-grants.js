'use strict';
// Source grant plan/admission only; runtime effect authority remains the actual
// SQL owner/incarnation/lifecycle protocol. No grant runs at worker startup.
const profiles = require('./pool-intake-profile');
const { MAX_MEMBERS, RULE } = require('../pool-membership/slice');
const UPDATES = require('./worker-grants').UPDATES;
const READS = Object.freeze([...new Set(['tenant_id', 'consumer', 'contract_digest', 'checkpoint', 'projection', ...require('./work-state').COLUMNS, 'work_owner_ordinal', 'work_assignment_revision'])]);
const MEMBERS = Object.freeze(['pool_kind', 'ordinal', 'member_id', 'slice_rule', 'applied_members', 'lease_expires_at']);
const DESIRED = Object.freeze(['pool_kind', 'members', 'previous_members', 'slice_rule', 'revision', 'partitioned', 'previous_partitioned']);
const PROFILE = Object.freeze(['consumer', 'profile', 'digest', 'contract_digest']);
const LEDGER = Object.freeze(['name', 'checksum']);
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const q = value => { if (typeof value !== 'string' || !NAME.test(value) || value.startsWith('pg_') || ['public', 'information_schema'].includes(value)) throw new TypeError('PGSTREAM_POOL_WORKER_BINDING'); return '"' + value + '"'; };
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const sorted = values => JSON.stringify([...new Set(values)].sort());
function selected (profile, ordinal) {
  const p = profiles.validate(profile);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= MAX_MEMBERS) throw new TypeError('PGSTREAM_POOL_WORKER_ORDINAL');
  return { p, b: p.binding, ordinal };
}
function lifecycleReads (profile) {
  const b = profiles.validate(profile).binding, authority = require('../tenant-lifecycle/pool-authority').READS;
  return Object.freeze(Object.fromEntries([...new Set([...Object.keys(b.controlReads), ...Object.keys(authority)])].map(table => [table, Object.freeze([...new Set([...(b.controlReads[table] || []), ...(authority[table] || [])])])])));
}
function expression (profile, ordinal) {
  const { b } = selected(profile, ordinal);
  const bytes = "sha256(convert_to(tenant_consumer_checkpoint.tenant_id::text,'UTF8'::name))";
  const prefix = require('./pool-assignment-candidate').unsignedPrefix().replaceAll('bytes', bytes);
  return `EXISTS (SELECT 1 FROM ${q(b.membershipNamespace)}.pool_desired d WHERE d.pool_kind='evaluator' AND d.slice_rule='${RULE}' AND d.members>=1 AND d.members<=${MAX_MEMBERS} AND (d.partitioned OR d.members=1) AND ${ordinal}<d.members AND mod((${prefix}),d.members::numeric)=${ordinal}::numeric AND ((consumer=${literal(b.consumer)} AND work_owner_ordinal IS NULL AND work_assignment_revision IS NULL) OR (consumer=${literal(b.consumer + '-completed')} AND work_owner_ordinal=${ordinal} AND work_assignment_revision=d.revision)))`;
}
function policies (profile, ordinal) { return Object.freeze({ prefix: 'pgstream_pool_worker_', expression: expression(profile, ordinal), suffix: '_' + ordinal }); }
function metadata (profile, { worker = true } = {}) {
  const b = profiles.validate(profile).binding;
  const wanted = new Map([
    [b.namespace + '.tenant_consumer_checkpoint', { reads: worker ? READS : ['tenant_id', 'consumer', 'work_owner_ordinal', 'work_assignment_revision'], updates: worker ? UPDATES : ['work_owner_ordinal', 'work_assignment_revision'], secured: true }],
    [b.namespace + '.schema_migrations', { reads: LEDGER, updates: [], secured: false }],
    [b.namespace + '.pgstream_intake_profile', { reads: PROFILE, updates: [], secured: false }],
    [b.membershipNamespace + '.pool_membership', { reads: MEMBERS, updates: [], secured: false }],
    [b.membershipNamespace + '.pool_desired', { reads: DESIRED, updates: worker ? [] : ['members', 'previous_members', 'revision', 'updated_at', 'partitioned', 'previous_partitioned'], secured: false }],
    [b.membershipNamespace + '.schema_migrations', { reads: LEDGER, updates: [], secured: false }],
    ...Object.entries(lifecycleReads(profile)).map(([table, reads]) => [b.lifecycleNamespace + '.' + table, { reads, updates: [], secured: table !== 'schema_migrations' }])
  ]);
  return wanted;
}
function build ({ role, profile, ordinal }) {
  const { b } = selected(profile, ordinal), principal = q(role), table = q(b.namespace) + '.tenant_consumer_checkpoint', policy = policies(profile, ordinal);
  if (role === b.role || role === b.operatorRole) throw new TypeError('PGSTREAM_POOL_WORKER_PRINCIPAL');
  return Object.freeze([
    ...[b.namespace, b.membershipNamespace, b.lifecycleNamespace].map(namespace => 'GRANT USAGE ON SCHEMA ' + q(namespace) + ' TO ' + principal),
    'GRANT SELECT ON ' + table + ' TO ' + principal,
    'GRANT UPDATE(' + UPDATES.join(',') + ') ON ' + table + ' TO ' + principal,
    ...['restrict', 'allow'].map(kind => 'CREATE POLICY ' + policy.prefix + kind + policy.suffix + ' ON ' + table + ' AS ' + (kind === 'restrict' ? 'RESTRICTIVE' : 'PERMISSIVE') + ' FOR ALL TO ' + principal + ' USING (' + policy.expression + ') WITH CHECK (' + policy.expression + ')'),
    ...Object.entries(lifecycleReads(profile)).map(([relation, columns]) => 'GRANT SELECT(' + columns.join(',') + ') ON ' + q(b.lifecycleNamespace) + '.' + relation + ' TO ' + principal),
    ...[[b.namespace, 'schema_migrations', LEDGER], [b.namespace, 'pgstream_intake_profile', PROFILE], [b.membershipNamespace, 'schema_migrations', LEDGER], [b.membershipNamespace, 'pool_membership', MEMBERS], [b.membershipNamespace, 'pool_desired', DESIRED]].map(([namespace, relation, columns]) => 'GRANT SELECT(' + columns.join(',') + ') ON ' + q(namespace) + '.' + relation + ' TO ' + principal)
  ]);
}
// A bounded parser for this exact policy grammar. Parentheses retain precedence;
// literals/identifiers are never normalized by global string replacement.
function policyTree (source) {
  const refuse = () => { throw new Error('PGSTREAM_POOL_POLICY_GRAMMAR'); };
  if (typeof source !== 'string' || !source || source.length > 32768) refuse();
  const tokens = []; let offset = 0;
  while (offset < source.length) {
    const text = source.slice(offset); let match;
    if ((match = /^\s+/.exec(text))) { offset += match[0].length; continue; }
    if (text[0] === "'" || text[0] === '"') {
      const quote = text[0]; let value = '', i = 1, closed = false;
      while (i < text.length) { if (text[i] === quote) { if (text[i + 1] === quote) { value += quote; i += 2; continue; } i++; closed = true; break; } if (text[i] === '\\' || text.charCodeAt(i) === 0) refuse(); value += text[i++]; }
      if (!closed) refuse(); tokens.push({ kind: quote === "'" ? 'string' : 'id', value, quoted: quote === '"' }); offset += i;
    } else if ((match = /^[a-z_][a-z_0-9]*/i.exec(text))) { tokens.push({ kind: 'id', value: match[0].toLowerCase() }); offset += match[0].length; }
    else if ((match = /^[0-9]+/.exec(text))) { tokens.push({ kind: 'number', value: match[0] }); offset += match[0].length; }
    else if ((match = /^(::|<>|>=|<=|[()+*.,=<>])/.exec(text))) { tokens.push({ kind: 'punct', value: match[0] }); offset += match[0].length; }
    else refuse();
    if (tokens.length > 8192) refuse();
  }
  let at = 0, depth = 0;
  const peek = value => tokens[at]?.value === value && !tokens[at].quoted;
  const take = value => { if (peek(value)) { at++; return true; } return false; };
  const need = value => { if (!take(value)) refuse(); };
  const identifier = () => { const t = tokens[at++]; if (!t || t.kind !== 'id') refuse(); return t.value; };
  function names () { const values = [identifier()]; while (take('.')) values.push(identifier()); return values; }
  function atom () {
    if (take('(')) { const value = parse(0); need(')'); return value; }
    if (take('exists')) {
      need('('); need('select'); const one = tokens[at++]; if (one?.kind !== 'number' || one.value !== '1') refuse(); need('from'); const relation = names(), alias = identifier(); need('where'); const where = parse(0); need(')'); return ['exists', relation, alias, where];
    }
    const token = tokens[at];
    if (token?.kind === 'number' || token?.kind === 'string') { at++; return [token.kind, token.value]; }
    for (const keyword of ['null', 'true', 'false']) if (take(keyword)) return [keyword];
    let parts = names();
    if (take('(')) {
      if (parts.length === 2 && parts[0] === 'pg_catalog') parts = parts.slice(1);
      const arities = { mod: 2, get_byte: 2, sha256: 1, convert_to: 2 };
      if (parts.length !== 1 || !Object.hasOwn(arities, parts[0])) refuse();
      const args = []; if (!peek(')')) do { args.push(parse(0)); } while (take(',')); need(')'); if (args.length !== arities[parts[0]]) refuse(); return ['call', parts[0], args];
    }
    if (parts.length === 2 && parts[0] === 'tenant_consumer_checkpoint' && ['tenant_id', 'consumer', 'work_owner_ordinal', 'work_assignment_revision'].includes(parts[1])) parts = parts.slice(1);
    return ['field', parts];
  }
  function parse (minimum) {
    if (++depth > 128) refuse(); let left = atom();
    while (at < tokens.length) {
      if (peek('::') && 70 >= minimum) {
        at++; let type = names(); if (type.length === 2 && type[0] === 'pg_catalog') type = type.slice(1);
        if (type.length !== 1 || !['numeric', 'text', 'name', 'integer', 'bigint'].includes(type[0])) refuse();
        if (['text', 'name'].includes(type[0]) && left[0] === 'string') continue;
        if (type[0] === 'numeric' && left[0] === 'number') continue;
        // PG16 deparses large integer weights as ('digits'::bigint)::numeric.
        // Admit only exact canonical unsigned literals within that cast's real
        // signed range. Other operands/casts remain visible in the policy AST.
        if (['integer', 'bigint'].includes(type[0]) && ['number', 'string'].includes(left[0]) && /^(0|[1-9][0-9]*)$/.test(left[1]) && BigInt(left[1]) <= (type[0] === 'integer' ? 2147483647n : 9223372036854775807n)) { left = ['number', left[1]]; continue; }
        if (type[0] === 'numeric' && left[0] === 'string' && /^(0|[1-9][0-9]*)$/.test(left[1])) { left = ['number', left[1]]; continue; }
        if (type[0] === 'numeric' && left[0] === 'field' && JSON.stringify(left[1]) === JSON.stringify(['d', 'members'])) continue;
        left = ['cast', left, type[0]]; continue;
      }
      const op = tokens[at]?.value, priority = { or: 10, and: 20, '=': 30, '<>': 30, '>=': 30, '<=': 30, '<': 30, '>': 30, is: 30, '+': 40, '*': 50 }[op];
      if (!priority || priority < minimum || tokens[at].quoted) break; at++;
      if (op === 'is') { const not = take('not'); need('null'); left = ['is-null', left, not]; }
      else left = [op, left, parse(priority + 1)];
    }
    depth--; return left;
  }
  const result = parse(0); if (at !== tokens.length) refuse(); return result;
}
async function assertRole (query, { profile, expectedRole, operator = false }) {
  const b = profiles.validate(profile).binding;
  if (typeof query !== 'function' || expectedRole !== undefined && (typeof expectedRole !== 'string' || !NAME.test(expectedRole))) throw new TypeError('PGSTREAM_POOL_GRANT_INPUT');
  const rows = (await query(`SELECT /* pool-grant-principal */ current_user AS principal,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication,r.rolinherit,
    EXISTS(SELECT 1 FROM pg_roles other WHERE other.oid<>r.oid AND pg_has_role(r.oid,other.oid,'MEMBER')) AS memberships,
    EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_schema_privilege(n.oid,'CREATE')) AS creates,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f') AND pg_has_role(current_user,c.relowner,'MEMBER')) AS owns
    FROM pg_roles r WHERE r.rolname=current_user`)).rows;
  const row = rows[0];
  if (rows.length !== 1 || !row || typeof row.principal !== 'string' || !NAME.test(row.principal) || row.principal.startsWith('pg_') || ['public', 'information_schema'].includes(row.principal) || expectedRole !== undefined && row.principal !== expectedRole || (operator ? row.principal !== b.operatorRole : [b.operatorRole, b.role].includes(row.principal)) || ['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolinherit', 'memberships', 'creates', 'owns'].some(key => row[key] !== false)) throw new Error('PGSTREAM_POOL_GRANT_PRINCIPAL');
  return row.principal;
}
async function assertRelations (query, profile, { worker = true } = {}) {
  const wanted = metadata(profile, { worker });
  const rows = (await query(`SELECT /* pool-grant-relations */ n.nspname||'.'||c.relname AS relation,c.relkind AS kind,c.relpersistence AS persistence,c.relrowsecurity AS rls,c.relforcerowsecurity AS forced,EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited,pg_has_role(current_user,c.relowner,'MEMBER') AS owns,has_schema_privilege(n.oid,'USAGE') AS uses_schema,has_schema_privilege(n.oid,'CREATE') AS creates,
    has_table_privilege(c.oid,'INSERT,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(c.oid,'INSERT,REFERENCES') AS forbidden,
    ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(c.oid,a.attname,'SELECT') ORDER BY a.attname) AS reads,
    ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(c.oid,a.attname,'UPDATE') ORDER BY a.attname) AS updates
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname||'.'||c.relname=ANY($1::text[])`, [[...wanted.keys()]])).rows;
  if (rows.length !== wanted.size || new Set(rows.map(row => row.relation)).size !== wanted.size || rows.some(row => { const need = wanted.get(row.relation); return !need || row.kind !== 'r' || row.persistence !== 'p' || row.rls !== need.secured || row.forced !== need.secured || row.inherited !== false || row.owns !== false || row.uses_schema !== true || row.creates !== false || row.forbidden !== false || !Array.isArray(row.reads) || !Array.isArray(row.updates) || sorted(row.reads) !== sorted(need.reads) || sorted(row.updates) !== sorted(need.updates); })) throw new Error('PGSTREAM_POOL_GRANT_RELATIONS');
  const extra = (await query(`SELECT /* pool-grant-extras */ n.nspname||'.'||c.relname AS relation FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND NOT n.nspname||'.'||c.relname=ANY($1::text[]) AND (${worker ? '' : "has_table_privilege(c.oid,'SELECT') OR has_any_column_privilege(c.oid,'SELECT') OR "}pg_has_role(current_user,c.relowner,'MEMBER') OR has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES'))`, [[...wanted.keys()]])).rows;
  if (extra.length) throw new Error('PGSTREAM_POOL_GRANT_EXTRA_RIGHTS');
  return wanted;
}
async function assertPolicies (query, profile, policy) {
  const b = profiles.validate(profile).binding;
  const rows = (await query(`SELECT /* pool-grant-policies */ p.polname AS name,p.polcmd AS command,p.polpermissive AS permissive,pg_get_expr(p.polqual,p.polrelid) AS "using",pg_get_expr(p.polwithcheck,p.polrelid) AS "check",p.polroles=ARRAY[0::oid] AS public,p.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname=current_user)] AS exact_role FROM pg_policy p WHERE p.polrelid=$1::regclass AND (p.polroles=ARRAY[0::oid] OR (SELECT oid FROM pg_roles WHERE rolname=current_user)=ANY(p.polroles))`, [q(b.namespace) + '.tenant_consumer_checkpoint'])).rows;
  const original = rows.filter(row => row.public);
  const canonical = require('../tenant-lifecycle/catalogue-structure'), tenant = "tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid";
  if (original.length !== 1 || original[0].name !== 'tenant_consumer_checkpoint_isolation' || original[0].command !== '*' || original[0].permissive !== true || original[0].exact_role !== false || canonical(original[0].using, b.namespace) !== canonical(tenant, b.namespace) || canonical(original[0].check, b.namespace) !== canonical(tenant, b.namespace)) throw new Error('PGSTREAM_POOL_GRANT_PUBLIC_POLICY');
  const selected = rows.filter(row => !row.public), expected = JSON.stringify(policyTree(policy.expression));
  if (selected.length !== 2 || new Set(selected.map(row => row.name)).size !== 2 || selected.some(row => !['allow', 'restrict'].some(kind => row.name === policy.prefix + kind + policy.suffix && row.permissive === (kind === 'allow')) || row.command !== '*' || row.exact_role !== true || JSON.stringify(policyTree(row.using)) !== expected || JSON.stringify(policyTree(row.check)) !== expected)) throw new Error('PGSTREAM_POOL_GRANT_POLICY');
}
async function assertProfile (query, profile) {
  const p = profiles.validate(profile), b = p.binding;
  const rows = (await query('SELECT /* pool-grant-profile */ consumer,profile,digest,contract_digest FROM ' + q(b.namespace) + '.pgstream_intake_profile WHERE consumer=$1', [b.consumer + '-completed'])).rows;
  const canonical = require('../server/serve/evaluator-runtime').canonical, row = rows[0];
  if (rows.length !== 1 || !row || row.consumer !== b.consumer + '-completed' || canonical(row.profile) !== canonical(b) || row.digest !== p.digest || row.contract_digest !== p.contractDigest) throw new Error('PGSTREAM_POOL_GRANT_PROFILE');
  await require('../pool-membership/pool-candidate').assertInstalled(query, b.membershipNamespace);
  await require('../pool-membership/fixed-protocol').assertInstalled(query, b.membershipNamespace);
}
async function assertReady (query, { profile, ordinal, expectedRole } = {}) {
  selected(profile, ordinal);
  const principal = await assertRole(query, { profile, expectedRole });
  await assertRelations(query, profile); await assertPolicies(query, profile, policies(profile, ordinal)); await assertProfile(query, profile);
  return Object.freeze({ principal, ordinal, profile: profiles.validate(profile).digest });
}
module.exports = { build, assertReady, expression, policies, metadata, lifecycleReads, policyTree, assertRole, assertRelations, assertPolicies, assertProfile, UPDATES, READS, MEMBERS, DESIRED, PROFILE, LEDGER };
