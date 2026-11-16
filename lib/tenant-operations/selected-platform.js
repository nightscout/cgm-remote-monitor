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
    c.relowner=(SELECT datdba FROM pg_database WHERE datname=current_database()) AS bootstrap_owned,
    EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid) OR
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal) OR
    EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid) OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid) AS augmented,
    (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'required',a.attnotnull,
      'identity',a.attidentity,'generated',a.attgenerated,'default',EXISTS(SELECT 1 FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum)) ORDER BY a.attnum)
      FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
    (SELECT jsonb_agg(jsonb_build_object('definition',pg_get_constraintdef(k.oid),'valid',k.convalidated,'deferred',k.condeferrable OR k.condeferred))
      FROM pg_constraint k WHERE k.conrelid=c.oid) AS constraints FROM pg_class c WHERE c.oid=to_regclass($1)`, [qualified])).rows;
  const columns = ['consumer', 'profile', 'digest', 'contract_digest'].map(name => ({ name, type: name === 'profile' ? 'jsonb' : 'text', required: true, identity: '', generated: '', default: false }));
  const row = rows[0], constraints = row?.constraints;
  if (rows.length !== 1 || row.global !== true || row.bootstrap_owned !== true || row.augmented !== false || !isDeepStrictEqual(row.columns, columns) ||
      !Array.isArray(constraints) || constraints.length !== 2 || constraints.some(item => item.valid !== true || item.deferred !== false) ||
      constraints.filter(item => item.definition === 'PRIMARY KEY (consumer)').length !== 1 ||
      constraints.filter(item => profileCheck(item.definition, profile)).length !== 1) throw fail('INFRASTRUCTURE_UNSUPPORTED', TABLE);
  const installed = (await connection.query('SELECT /* selected-global-profile-current */ consumer,profile,digest,contract_digest FROM ' + qualified)).rows;
  if (installed.length !== 1 || installed[0].consumer !== profile.binding.consumer + '-completed' || installed[0].digest !== profile.digest ||
      installed[0].contract_digest !== profile.contractDigest || !isDeepStrictEqual(installed[0].profile, profile.binding)) throw fail('INFRASTRUCTURE_CHANGED', TABLE);
}
module.exports = { TABLE, declaration, recognizes, assert };
