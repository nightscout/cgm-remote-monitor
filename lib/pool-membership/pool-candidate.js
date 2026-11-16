'use strict';
// Applied placement is database effect authority. Requested replicas remain
// the deployment platform's responsibility; this migration starts no workers.
const { checksum, validateCatalogue } = require('../migrations/catalogue');
const base = require('../../migrations/candidates/postgres-pool-mutation-v1.json');
const CONSTRAINT = 'pool_placement_mode_count';
const EXPRESSION = '((partitioned OR members = 1) AND (previous_partitioned IS NULL OR previous_partitioned OR previous_members = 1) AND ((previous_members IS NULL) = (previous_partitioned IS NULL)))';
const UP = Object.freeze([
  'ALTER TABLE pool_desired ADD COLUMN partitioned boolean NOT NULL DEFAULT true',
  'ALTER TABLE pool_desired ADD COLUMN previous_partitioned boolean',
  `CREATE FUNCTION pool_placement_backfill(namespace text,kind text) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $pool_placement$
DECLARE bytes bytea; high_key bigint; low_key bigint;
BEGIN
 bytes:=sha256(convert_to('nightscout:pool-membership:xact:v1:'||namespace||':'||kind,'UTF8'));
 high_key:=((get_byte(bytes,0)::bigint<<24)+(get_byte(bytes,1)::bigint<<16)+(get_byte(bytes,2)::bigint<<8)+get_byte(bytes,3));
 low_key:=((get_byte(bytes,4)::bigint<<24)+(get_byte(bytes,5)::bigint<<16)+(get_byte(bytes,6)::bigint<<8)+get_byte(bytes,7));
 PERFORM pg_advisory_xact_lock((CASE WHEN high_key>=2147483648 THEN high_key-4294967296 ELSE high_key END)::integer,(CASE WHEN low_key>=2147483648 THEN low_key-4294967296 ELSE low_key END)::integer);
 RETURN true;
END;
$pool_placement$`,
  'UPDATE pool_desired SET previous_partitioned=pool_placement_backfill(current_schema()::text,pool_kind) WHERE previous_members IS NOT NULL',
  'DROP FUNCTION pool_placement_backfill(text,text)',
  'ALTER TABLE pool_desired ADD CONSTRAINT ' + CONSTRAINT + ' CHECK ' + EXPRESSION
]);
const migration = Object.freeze({ name: '0005_pool_placement', up: UP, checksum: checksum(UP) });
function build () {
  return Object.freeze({ version: 1, migrations: Object.freeze([...validateCatalogue(base), migration]) });
}
const normalize = value => typeof value === 'string' ? value.replace(/[\s()]/g, '').toLowerCase() : null;
async function assertInstalled (query, namespace) {
  require('./transaction-lock').key(namespace, 'evaluator');
  const current = await require('../migrations/postgres-check').inspect(query, {
    table: '"' + namespace + '".schema_migrations', files: validateCatalogue(build())
  });
  if (!current.current) throw new Error('POOL_PLACEMENT_CATALOGUE_PENDING');
  const columns = (await query(`SELECT /* pool-placement-columns */ a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required,
    pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname=$1 AND c.relname='pool_desired' AND a.attname=ANY($2::text[]) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attname`, [namespace, ['partitioned', 'previous_partitioned']])).rows;
  if (columns.length !== 2 || columns[0].name !== 'partitioned' || columns[0].type !== 'boolean' || columns[0].required !== true || normalize(columns[0].default_value) !== 'true' || columns[1].name !== 'previous_partitioned' || columns[1].type !== 'boolean' || columns[1].required !== false || columns[1].default_value !== null) throw new Error('POOL_PLACEMENT_COLUMNS_UNQUALIFIED');
  const constraints = (await query(`SELECT /* pool-placement-constraint */ pg_get_expr(k.conbin,k.conrelid) AS expression,k.convalidated AS valid,k.condeferrable AS deferrable
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname='pool_desired' AND k.conname=$2`, [namespace, CONSTRAINT])).rows;
  const canonical=require('../tenant-lifecycle/catalogue-structure');let matches=false;
  try{matches=constraints.length===1&&canonical(constraints[0].expression,namespace)===canonical(EXPRESSION,namespace);}catch{ /* Unknown SQL never satisfies source admission. */ }
  if (!matches || constraints[0].valid !== true || constraints[0].deferrable !== false) throw new Error('POOL_PLACEMENT_CONSTRAINT_UNQUALIFIED');
}
function placement (value) {
  const { RULE, shape } = require('./slice');
  if (!value || typeof value.partitioned !== 'boolean' || ![null, true, false].includes(value.previousPartitioned) || value.rule !== RULE || typeof value.revision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value.revision) || BigInt(value.revision) > 9223372036854775807n) throw new TypeError('POOL_PLACEMENT_SHAPE');
  shape(value.members, 0);
  if (value.previousMembers !== null) shape(value.previousMembers, 0);
  if ((value.previousMembers === null) !== (value.previousPartitioned === null) || !value.partitioned && value.members !== 1 || value.previousPartitioned === false && value.previousMembers !== 1) throw new TypeError('POOL_PLACEMENT_SHAPE');
  return Object.freeze({ partitioned: value.partitioned, members: value.members, revision: value.revision, rule: value.rule, previousMembers: value.previousMembers, previousPartitioned: value.previousPartitioned });
}
function assessPlacement (self, rows, source) {
  const desired = placement(source), { RULE } = require('./slice');
  const refused = reason => Object.freeze({ eligible: false, reason, conflicts: Object.freeze([{reason}]), members: desired.members, revision: desired.revision, desiredMembers: desired.members, switching: false, outside: false, missingOrdinals: [] });
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row.live !== 'boolean' || !Number.isSafeInteger(row.ordinal))) return refused('POOL_PLACEMENT_MEMBERSHIP_SHAPE');
  if (!desired.partitioned) return refused('POOL_MODE_CHANGED');
  const verdict = require('./assess').assess(self, rows, desired);
  if (!verdict.eligible) return Object.freeze({ ...verdict, members: desired.members, switching: false });
  const live = rows.filter(row => row.live), ordinals = new Set(live.map(row => row.ordinal));
  if (live.length !== desired.members || ordinals.size !== desired.members || live.some(row => row.ordinal < 0 || row.ordinal >= desired.members || row.rule !== RULE || row.appliedMembers !== desired.members)) return refused('POOL_PLACEMENT_COHORT_INCOMPLETE');
  return Object.freeze({ ...verdict, members: desired.members, desiredMembers: desired.members, revision: desired.revision, switching: false, outside: false, missingOrdinals: [] });
}
module.exports = { build, assertInstalled, placement, assessPlacement, CONSTRAINT, EXPRESSION, UP };
