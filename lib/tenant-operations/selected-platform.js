'use strict';

// Source-owned global infrastructure admission. Tenant artifacts never choose
// this declaration and never capture, erase or replay the global profile row.
const { isDeepStrictEqual } = require('node:util');
const profiles = require('../pgstream/pool-intake-profile');
const genuine = new WeakMap();
const TABLE = 'pgstream_intake_profile';
const q = value => '"' + value + '"';
function declaration (profile) {
  const selected = profiles.validate(profile);
  const value = Object.freeze({ namespace: selected.binding.namespace, table: TABLE, contract: profiles.PROTOCOL });
  genuine.set(value, selected); return value;
}
function recognizes (value) { return genuine.has(value); }
// Parse only this generated four-equality CHECK; retain literal bytes and parse
// the jsonb literal as JSON rather than erasing whitespace from its contents.
function profileCheck (value, profile) {
  if (typeof value !== 'string' || value.length > 16384) return false;
  const tokens = []; let at = 0;
  while (at < value.length) {
    const rest = value.slice(at); let match;
    if ((match = /^[\s()]+/.exec(rest))) { at += match[0].length; continue; }
    if ((match = /^'((?:[^']|'')*)'/.exec(rest))) { tokens.push({ literal: match[1].replace(/''/g, "'") }); at += match[0].length; continue; }
    if ((match = /^(CHECK\b|AND\b|consumer\b|profile\b|digest\b|contract_digest\b|::text\b|::jsonb\b|=)/.exec(rest))) { tokens.push(match[0]); at += match[0].length; continue; }
    return false;
  }
  if (tokens.shift() !== 'CHECK') return false;
  const expected = { consumer: profile.binding.consumer + '-completed', profile: profile.binding, digest: profile.digest, contract_digest: profile.contractDigest };
  const seen = new Set();
  for (let i = 0; i < 4; i++) {
    const [name, equals, literal] = tokens.splice(0, 3);
    if (!Object.hasOwn(expected, name) || seen.has(name) || equals !== '=' || typeof literal?.literal !== 'string') return false;
    seen.add(name);
    const cast = name === 'profile' ? '::jsonb' : '::text';
    if (tokens[0] === cast) tokens.shift();
    if (name === 'profile') {
      try { if (!isDeepStrictEqual(JSON.parse(literal.literal), expected[name])) return false; } catch { return false; }
    } else if (literal.literal !== expected[name]) return false;
    if (i < 3 && tokens.shift() !== 'AND') return false;
  }
  return tokens.length === 0;
}
async function assert (connection, value, namespace, fail) {
  const profile = genuine.get(value);
  if (!profile || value.namespace !== namespace) throw fail('INVALID', 'infrastructure');
  const qualified = q(namespace) + '.' + q(TABLE);
  const rows = (await connection.query(`SELECT /* selected-global-profile-shape */
    c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AS global,
    c.relowner=(SELECT relowner FROM pg_class WHERE oid=to_regclass($2))
      AND c.relowner=(SELECT nspowner FROM pg_namespace WHERE nspname=$3)
      AND NOT o.rolcanlogin AND NOT o.rolsuper AND NOT o.rolbypassrls AND NOT o.rolcreaterole AND NOT o.rolcreatedb AND NOT o.rolreplication
      AND NOT pg_has_role(current_user,o.oid,'MEMBER') AS owner_safe,
    EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid) OR
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal) OR
    EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid) OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid) AS augmented,
    (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'required',a.attnotnull,
      'identity',a.attidentity,'generated',a.attgenerated,'default',EXISTS(SELECT 1 FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum)) ORDER BY a.attnum)
      FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
    (SELECT jsonb_agg(jsonb_build_object('definition',pg_get_constraintdef(k.oid),'valid',k.convalidated,'deferred',k.condeferrable OR k.condeferred))
      FROM pg_constraint k WHERE k.conrelid=c.oid) AS constraints FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=to_regclass($1)`, [qualified, q(namespace) + '.tenant_consumer_checkpoint', namespace])).rows;
  const columns = ['consumer', 'profile', 'digest', 'contract_digest'].map(name => ({ name, type: name === 'profile' ? 'jsonb' : 'text', required: true, identity: '', generated: '', default: false }));
  const row = rows[0], constraints = row?.constraints;
  if (rows.length !== 1 || row.global !== true || row.owner_safe !== true || row.augmented !== false || !isDeepStrictEqual(row.columns, columns) ||
      !Array.isArray(constraints) || constraints.length !== 2 || constraints.some(item => item.valid !== true || item.deferred !== false) ||
      constraints.filter(item => item.definition === 'PRIMARY KEY (consumer)').length !== 1 ||
      constraints.filter(item => profileCheck(item.definition, profile)).length !== 1) throw fail('INFRASTRUCTURE_UNSUPPORTED', TABLE);
  const installed = (await connection.query('SELECT /* selected-global-profile-current */ consumer,profile,digest,contract_digest FROM ' + qualified)).rows;
  if (installed.length !== 1 || installed[0].consumer !== profile.binding.consumer + '-completed' || installed[0].digest !== profile.digest ||
      installed[0].contract_digest !== profile.contractDigest || !isDeepStrictEqual(installed[0].profile, profile.binding)) throw fail('INFRASTRUCTURE_CHANGED', TABLE);
}
// Explicit selected-v2 source construction, after the JSON census has admitted
// every baseline family. Dynamic DDL comes only from these reviewed builders.
function compose (catalogues, { intakeProfile, nativeSelection, predecessorProfile, notificationBindings = [] }) {
  if(nativeSelection!==undefined){
    const selected=require('../tenant-lifecycle/native-selection').validate(nativeSelection),b=selected.binding;
    if(intakeProfile!==undefined||predecessorProfile!==undefined||!Array.isArray(catalogues)||!Array.isArray(notificationBindings))throw new TypeError('LIFECYCLE_NATIVE_SELECTION_INVALID');
    require('../tenant-lifecycle/native-selection').notificationBindings(notificationBindings,selected);
    const checkpoint=catalogues.filter(entry=>entry.namespace===b.namespace),lifecycle=catalogues.filter(entry=>entry.namespace===b.lifecycleNamespace);
    if(checkpoint.length!==1||!['checkpoint','evaluator_checkpoint'].includes(checkpoint[0].kind)&&checkpoint[0].instanceOf!=='checkpoint'||checkpoint[0].tables.join(',')!=='tenant_consumer_checkpoint'||!isDeepStrictEqual(checkpoint[0].catalogue,require('../../migrations/candidates/postgres-evaluator-work-v2.json'))||lifecycle.length!==1||lifecycle[0].kind!=='lifecycle')throw new TypeError('LIFECYCLE_NATIVE_SELECTION_INVALID');
    if(notificationBindings.some(value=>!value||Object.keys(value).sort().join(',')!=='consumer,namespace'||typeof value.consumer!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value.consumer))||new Set(notificationBindings.map(value=>value.namespace)).size!==notificationBindings.length||catalogues.some(entry=>entry.kind==='notification_outbox'&&!notificationBindings.some(value=>value.namespace===entry.namespace)))throw new TypeError('LIFECYCLE_NATIVE_SELECTION_INVALID');
    const control=require('../tenant-lifecycle/native-selection').catalogue(selected);
    return catalogues.map(entry=>entry===lifecycle[0]?{...entry,catalogue:control,tables:require('../migrations/catalogue').validateCatalogue(control).flatMap(migration=>migration.up.map(sql=>/^CREATE TABLE ([a-z][a-z0-9_]+) \(/.exec(sql)).filter(Boolean).map(match=>match[1])),sourceConstruction:'lib/tenant-lifecycle/native-selection.js',sourceProfileDigest:selected.digest}:entry);
  }
  const profile = profiles.validate(intakeProfile), b = profile.binding;
  const fail = () => { throw require('./common').refuse('OPERATIONS_SELECTED_BINDING_INVALID'); };
  if (!Array.isArray(catalogues) || !Array.isArray(notificationBindings) || notificationBindings.length > 32) fail();
  const checkpoints = catalogues.filter(entry => entry.namespace === b.namespace);
  const lifecycle = catalogues.filter(entry => entry.namespace === b.lifecycleNamespace);
  if (checkpoints.length !== 1 || checkpoints[0].kind !== 'checkpoint' && checkpoints[0].instanceOf !== 'checkpoint' ||
      checkpoints[0].tables.join(',') !== 'tenant_consumer_checkpoint' || lifecycle.length !== 1 || lifecycle[0].kind !== 'lifecycle') fail();
  const pool = require('../pgstream/pool-catalogue').build(profile, { predecessorProfile }).catalogue;
  const control = require('../tenant-lifecycle/generation-domain').catalogue(profile);
  const tablesOf = candidate => require('../migrations/catalogue').validateCatalogue(candidate).flatMap(migration => migration.up.map(sql => /^CREATE TABLE ([a-z][a-z0-9_]+) \(/.exec(sql)).filter(Boolean).map(match => match[1]));
  if (tablesOf(pool).join(',') !== 'tenant_consumer_checkpoint,' + TABLE) fail();
  const notifications = new Map();
  for (const value of notificationBindings) {
    const { namespace, ...binding } = value;
    require('../tenant-notifications/partition-candidate').quote(namespace);
    if (notifications.has(namespace)) fail();
    const built = require('../tenant-notifications/pool-partition-candidate').build({ binding, intakeProfile: profile });
    const entries = catalogues.filter(entry => entry.namespace === namespace);
    if (entries.length !== 1 || entries[0].kind !== 'notification_outbox' ||
        !isDeepStrictEqual([...entries[0].tables].sort(), [...require('../tenant-notifications/partition-candidate').TABLES].sort())) fail();
    notifications.set(namespace, built.catalogue);
  }
  if (catalogues.some(entry => entry.kind === 'notification_outbox' && !notifications.has(entry.namespace))) fail();
  return catalogues.map(entry => {
    if (entry === checkpoints[0]) return { ...entry, catalogue: pool, infrastructure: declaration(profile),
      sourceConstruction: 'lib/pgstream/pool-catalogue.js', sourceProfileDigest: profile.digest };
    if (entry === lifecycle[0]) return { ...entry, catalogue: control, tables: tablesOf(control),
      sourceConstruction: 'lib/tenant-lifecycle/generation-domain.js', sourceProfileDigest: profile.digest };
    if (notifications.has(entry.namespace)) return { ...entry, catalogue: notifications.get(entry.namespace),
      sourceConstruction: 'lib/tenant-notifications/pool-partition-candidate.js', sourceProfileDigest: profile.digest };
    return entry;
  });
}
module.exports = { TABLE, declaration, recognizes, assert, compose };
