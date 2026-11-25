'use strict';
// Reviewed SQL of the forward migration that retires realtime's delivery
// receipt (decision D23: realtime is a reader). Delivery is level-triggered
// (lib/server/realtime/runtime.js), so nothing is owed or acknowledged in the
// database: the obligation triggers on the evaluator's and realtime's
// checkpoint tables, their function, the owed index and the receipt columns
// are removed, and with the columns the realtime role's UPDATE grants.
//
// Safe on a populated database. Every statement is a catalogue change: no
// table is rewritten and no index is built. Each takes a brief ACCESS
// EXCLUSIVE lock on a checkpoint table; lock_timeout makes a lock that cannot
// be had in 5 s fail the migration (it is run again) instead of queueing
// behind a long transaction and stalling the evaluator's writes. The triggers
// go first: the function reads the columns, so it must not outlive them.
// The obligation was installed by a deployment's DBA step under a name derived
// from its namespaces; it is found here by that name pattern in this schema.
const KIND = 'realtime-receipt-removal-v1', NAME = '0004_realtime_receipt_removed', DOMAINS = Object.freeze(['realtime']);
const COLUMNS = Object.freeze(['output_target', 'output_received', 'output_completed', 'output_owner', 'output_retry_at', 'output_delivery_version']);
function build ({ namespace, domain = 'realtime' }) {
  if (typeof namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || namespace.startsWith('pg_') || ['public', 'information_schema'].includes(namespace) || !DOMAINS.includes(domain)) throw new TypeError('REALTIME_RECEIPT_REMOVAL_BINDING');
  const table = '"' + namespace + '".tenant_consumer_checkpoint';
  return [
    "SET LOCAL lock_timeout = '5s'",
    "DO $receipt$ DECLARE obligation record; BEGIN FOR obligation IN SELECT format('%I.%I()', n.nspname, p.proname) AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '" + namespace + "' AND p.proname ~ '^rt_obligation_[0-9a-f]{32}$' AND p.prorettype = 'trigger'::regtype LOOP EXECUTE 'DROP FUNCTION ' || obligation.signature || ' CASCADE'; END LOOP; END $receipt$",
    'ALTER TABLE ' + table + ' DROP COLUMN output_pending_tenant',
    'ALTER TABLE ' + table + ' ' + COLUMNS.map(column => 'DROP COLUMN ' + column).join(', ')
  ];
}
module.exports = { build, KIND, NAME, DOMAINS, COLUMNS };
