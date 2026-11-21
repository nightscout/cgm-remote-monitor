'use strict';

// Current configured replay contracts, not archived checkpoint descriptors. All
// rows start empty; the selected typed row gets a fresh bootstrap from the pool
// provisioning port under the same physical maintenance DATA transaction.
const profiles = require('../pgstream/pool-intake-profile');
const replayFactory = require('../storage/postgres-durable-replay');
const { refuse } = require('./artifact');
const genuine = new WeakSet();
function describe ({ intakeProfile, nativeSelection, predecessorProfile, replays, namespaces, catalogues }) {
  const profile = nativeSelection ? require('./native-selection').validate(nativeSelection) : profiles.validate(intakeProfile);
  if (!Array.isArray(replays) || !replays.length || replays.length > 8 || !Array.isArray(catalogues)) throw refuse('LIFECYCLE_RECOMMISSION_REPLAY_REQUIRED');
  const sources = new Set(catalogues.filter(entry => entry.tables.includes('tenant_consumer_checkpoint')).map(entry => namespaces[entry.kind]));
  const seen = new Set();
  const rows = replays.map(input => {
    if (!input || Object.keys(input).sort().join(',') !== 'checkpointTable,clockTable,consumer,domains,maxRows,pageSize,projectionVersion') throw refuse('LIFECYCLE_RECOMMISSION_REPLAY_INVALID');
    // Construct the actual production replay contract without reading data or
    // recomputing a parallel digest. These methods cannot run during describe.
    const unavailable = () => { throw refuse('LIFECYCLE_RECOMMISSION_REPLAY_UNEXPECTED_IO'); };
    const replay = replayFactory({ ...input, connection: { query: unavailable, snapshotTransaction: unavailable } });
    const namespace = input.checkpointTable.split('.')[0], key = input.checkpointTable + ':' + input.consumer;
    if (!sources.has(namespace) || input.checkpointTable !== namespace + '.tenant_consumer_checkpoint' ||
        input.consumer.endsWith('-completed') || seen.has(key) || input.clockTable !== namespaces.clock + '.tenant_write_clock') throw refuse('LIFECYCLE_RECOMMISSION_REPLAY_INVALID');
    for (const [kind, table] of Object.entries(input.domains)) if (!catalogues.some(entry => entry.kind === kind && entry.tables.includes(kind) && table === namespaces[kind] + '.' + kind)) throw refuse('LIFECYCLE_RECOMMISSION_REPLAY_INVALID');
    seen.add(key); return Object.freeze({ namespace, consumer: input.consumer, digest: replay.digest });
  });
  if (!rows.some(row => row.namespace === profile.binding.namespace && row.consumer === profile.binding.consumer) ||
      [...sources].some(namespace => !rows.some(row => row.namespace === namespace))) throw refuse('LIFECYCLE_RECOMMISSION_REPLAY_REQUIRED');
  const result = Object.freeze({ profile, nativeSelection, predecessorProfile: predecessorProfile === undefined ? undefined : require('../pgstream/intake-profile').validate(predecessorProfile), rows: Object.freeze(rows) }); genuine.add(result); return result;
}
async function provision (query, descriptor, { tenant, generation, connection, maintenanceClaim, artifactDigest }) {
  if (!genuine.has(descriptor) || typeof query !== 'function') throw refuse('LIFECYCLE_RECOMMISSION_REPLAY_INVALID');
  if(descriptor.nativeSelection){
    await require('./maintenance-window').assertHeld(maintenanceClaim,{connection,tenant,artifactDigest});
    query=connection.query.bind(connection);
    const b=descriptor.profile.binding,rows=(await query('SELECT generation::text AS generation FROM "'+b.lifecycleNamespace+'".tenant_lifecycle_windows WHERE tenant_id=$1 AND phase=\'suspended\'',[tenant])).rows;
    if(rows.length!==1||rows[0].generation!==generation)throw refuse('LIFECYCLE_NATIVE_GENERATION_CHANGED');
  }
  for (const row of descriptor.rows) {
    const inserted = await query('INSERT /* recommission-current-replay */ INTO "' + row.namespace +
      '".tenant_consumer_checkpoint (tenant_id,consumer,contract_digest,checkpoint,projection) VALUES ($1,$2,$3,0,NULL)', [tenant, row.consumer, row.digest]);
    if (inserted.rowCount !== 1) throw refuse('LIFECYCLE_RECOMMISSION_REPLAY_CHANGED');
  }
  if (descriptor.nativeSelection) {
    const b=descriptor.profile.binding,empty=Array(6).fill(null),observed=[...empty],at=Date.now();observed[4]=require('../pgstream/intake-profile').lifecycleStamp(generation,'suspended');observed[5]='1';
    const result=await query(`INSERT /* native-recommission-bootstrap */ INTO "${b.namespace}".tenant_consumer_checkpoint (tenant_id,consumer,contract_digest,checkpoint,projection,work_version,work_observed,work_completed,work_observed_at,work_pending_at,work_enabled,work_activity_enabled,work_lifecycle_enabled) VALUES($1,$2,$3,0,$7::jsonb,2,$4,$5,$6,$8,false,false,false)`,[tenant,b.consumer+'-completed',descriptor.profile.contractDigest,observed,empty,observed.map(x=>x===null?null:String(at)),JSON.stringify([{kind:'evaluator-work-v2',output:null}]),at]);
    if(result.rowCount!==1)throw refuse('LIFECYCLE_RECOMMISSION_REPLAY_CHANGED');
    return;
  }
  return require('../pgstream/pool-checkpoint-provision').provisionCheckpoint(query, descriptor.profile, { tenant, generation, enabled: false }, { predecessorProfile: descriptor.predecessorProfile });
}
module.exports = { describe, provision };
