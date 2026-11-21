'use strict';

const { createHash } = require('node:crypto');
const namespace = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(value) &&
  !value.startsWith('pg_') && !['public', 'information_schema'].includes(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);

function binding(source, target, producer, consumer) {
  if (!namespace(source) || !namespace(target) || source === target ||
      typeof producer !== 'string' || !/^evaluator-[A-Za-z0-9_-]{1,100}$/.test(producer) ||
      typeof consumer !== 'string' || !/^realtime-[A-Za-z0-9_-]{1,112}$/.test(consumer)) {
    throw new TypeError('Explicit producer and realtime checkpoint binding required');
  }
  const name = 'rt_obligation_' + digest([source, target, producer]);
  // Each receipt can subscribe to only one producer, even across namespaces.
  return { name, receiptTrigger: 'rt_subscription_' + digest(consumer), lifetimeTrigger: name + '_lifetime',
    functionName: '"' + target + '".' + name, output: '"' + source + '".tenant_consumer_checkpoint',
    receipt: '"' + target + '".tenant_consumer_checkpoint', producer: producer + '-completed', consumer };
}

// Offline DBA operation. Serving roles receive neither UPDATE(output_target) nor
// function EXECUTE. The definer SQL addresses only these two qualified relations.
async function install(client, { source, target, producer, consumers }) {
  if (!Array.isArray(consumers) || !consumers.length || consumers.length > 4 || new Set(consumers).size !== consumers.length) {
    throw new TypeError('Explicit realtime obligation consumers required');
  }
  const bindings = consumers.map(consumer => binding(source, target, producer, consumer));
  const { name, lifetimeTrigger, functionName: fn, output, receipt, producer: completed } = bindings[0];
  const subscribers = consumers.map(consumer => "'" + consumer + "'").join(',');
  // A settled receipt may retain its pre-upgrade default. Only a newly owed
  // revision or the withdrawal of an existing obligation changes that receipt.
  const needsUpdate = `tenant_id=tenant AND consumer IN (${subscribers}) AND output_target<>revision
            AND (revision>output_completed OR output_target>output_completed)`;
  await client.query('BEGIN');
  try {
    await client.query('LOCK TABLE ' + output + ', ' + receipt + ' IN SHARE ROW EXCLUSIVE MODE');
    await client.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $delivery$
      DECLARE revision bigint; tenant uuid;
      BEGIN
        IF TG_RELID = '${output}'::regclass AND TG_OP<>'DELETE' AND NEW.consumer<>'${completed}' THEN RETURN NULL; END IF;
        IF TG_OP='INSERT' THEN
          -- Serialize two concurrent first inserts when neither tuple exists to lock.
          PERFORM pg_advisory_xact_lock(hashtextextended('${name}' || NEW.tenant_id::text, 0));
        END IF;
        IF TG_RELID = '${receipt}'::regclass THEN
          SELECT delivery_revision INTO revision FROM ${output}
            WHERE tenant_id=NEW.tenant_id AND consumer='${completed}' AND work_version=2 FOR SHARE;
          IF COALESCE(revision,0)>NEW.output_completed OR NEW.output_target>NEW.output_completed THEN
            NEW.output_target := COALESCE(revision,0);
          END IF;
          RETURN NEW;
        END IF;
        IF TG_RELID <> '${output}'::regclass THEN RAISE EXCEPTION 'REALTIME_OBLIGATION_SOURCE'; END IF;
        IF TG_OP='DELETE' THEN
          IF OLD.consumer<>'${completed}' OR OLD.delivery_revision=0 THEN RETURN NULL; END IF;
          revision := 0; tenant := OLD.tenant_id;
        ELSE
          revision := CASE WHEN NEW.work_version=2 THEN NEW.delivery_revision ELSE 0 END;
          IF TG_OP='INSERT' AND revision=0 THEN RETURN NULL; END IF;
          tenant := NEW.tenant_id;
        END IF;
        IF EXISTS (SELECT FROM ${receipt} WHERE ${needsUpdate}) THEN
          UPDATE ${receipt} SET output_target=revision WHERE ${needsUpdate};
        END IF;
        RETURN NULL;
      END $delivery$`);
    await client.query(`REVOKE ALL ON FUNCTION ${fn}() FROM PUBLIC`);
    for (const { receiptTrigger, consumer } of bindings) {
      await client.query(`CREATE TRIGGER ${receiptTrigger} BEFORE INSERT ON ${receipt} FOR EACH ROW
        WHEN (NEW.consumer='${consumer}') EXECUTE FUNCTION ${fn}()`);
    }
    // Even an UPDATE mentioning delivery_revision can leave it unchanged.
    // PostgreSQL tests WHEN before queuing an AFTER trigger for the row.
    await client.query(`CREATE TRIGGER ${name} AFTER UPDATE OF work_version,delivery_revision ON ${output} FOR EACH ROW
      WHEN (NEW.consumer='${completed}' AND (OLD.work_version,OLD.delivery_revision) IS DISTINCT FROM
        (NEW.work_version,NEW.delivery_revision)) EXECUTE FUNCTION ${fn}()`);
    await client.query(`CREATE TRIGGER ${lifetimeTrigger} AFTER INSERT OR DELETE ON ${output}
      FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    await client.query(`UPDATE ${receipt} r SET output_target=e.delivery_revision FROM ${output} e
      WHERE r.tenant_id=e.tenant_id AND r.consumer=ANY($1::text[]) AND e.consumer=$2 AND e.work_version=2
        AND e.delivery_revision>r.output_completed AND r.output_target<>e.delivery_revision`, [consumers, completed]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
module.exports = { binding, install };
