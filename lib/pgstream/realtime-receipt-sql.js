'use strict';
// Fixed trusted delivery bookkeeping. No clinical data or serving operation is
// admitted here: a suspended tenant's receipt must not block another tenant.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const validTenant=value=>typeof value==='string'&&UUID.test(value)&&value!=='00000000-0000-0000-0000-000000000000';
const exact=value=>typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
async function update ({pool,observeBackend,table,consumer,worker,mode,rows}) {
  const parts=typeof table==='string'?table.split('.'):[];
  if(parts.length!==2||parts[1]!=='tenant_consumer_checkpoint'||!/^[a-z][a-z0-9_]{0,62}$/.test(parts[0])||parts[0].startsWith('pg_')||['public','information_schema'].includes(parts[0])||
    !/^realtime-[A-Za-z0-9_-]{1,112}$/.test(consumer)||!validTenant(worker)||!['receive','claim','complete','retry'].includes(mode)||
    !Array.isArray(rows)||rows.length<1||rows.length>64||new Set(rows.map(row=>row?.tenant)).size!==rows.length||
    rows.some(row=>!validTenant(row?.tenant)||Object.keys(row).sort().join(',')!==(mode==='claim'?'tenant':mode==='retry'?'due,revision,tenant':'revision,tenant')||
      mode!=='claim'&&!exact(row.revision)||mode==='retry'&&(!Number.isSafeInteger(row.due)||row.due<0))||typeof pool?.connect!=='function'||typeof observeBackend!=='function')throw new TypeError('Fixed bounded realtime receipt bookkeeping required');
  const relation='"'+parts[0]+'".tenant_consumer_checkpoint';
  const assignments={
    receive:'output_delivery_version=1,output_received=GREATEST(c.output_received,w.revision::bigint),output_owner=$2::uuid,output_retry_at=CASE WHEN c.output_received<w.revision::bigint THEN NULL ELSE c.output_retry_at END',
    claim:'output_owner=$2::uuid,output_retry_at=NULL',
    complete:'output_completed=GREATEST(c.output_completed,w.revision::bigint),output_retry_at=CASE WHEN c.output_received=w.revision::bigint THEN NULL ELSE c.output_retry_at END',
    retry:'output_retry_at=w.due'
  };
  const fences={
    receive:'c.output_delivery_version IN (0,1)',
    claim:'c.output_delivery_version=1 AND c.output_received>c.output_completed',
    complete:'c.output_delivery_version=1 AND c.output_owner=$2::uuid AND c.output_received>=w.revision::bigint',
    retry:'c.output_delivery_version=1 AND c.output_owner=$2::uuid AND c.output_received=w.revision::bigint AND c.output_received>c.output_completed'
  };
  const client=await pool.connect();let failure;
  try{
    await observeBackend(client);
    await client.query('BEGIN');
    // Unique revisions take the ordinary UPDATE path. Lock an unchanged row
    // under the same metadata policy before ACK, without rewriting its tuple.
    // A concurrent replacement that cannot be confirmed fails closed for retry.
    const receive=`WITH work AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS w(tenant uuid,revision text,due bigint)),
      changed AS (UPDATE ${relation} c SET ${assignments.receive} FROM work w
        WHERE c.consumer=$1 AND c.tenant_id=w.tenant AND ${fences.receive} AND
          (c.output_delivery_version<>1 OR c.output_owner IS DISTINCT FROM $2::uuid OR c.output_received<w.revision::bigint)
        RETURNING c.tenant_id::text AS tenant,c.output_received::text AS received),
      unchanged AS MATERIALIZED (SELECT c.tenant_id::text AS tenant,c.output_received::text AS received
        FROM ${relation} c JOIN work w ON c.tenant_id=w.tenant WHERE c.consumer=$1
          AND c.output_delivery_version=1 AND c.output_owner=$2::uuid AND c.output_received>=w.revision::bigint
          AND NOT EXISTS (SELECT 1 FROM changed WHERE tenant=c.tenant_id::text)
        ORDER BY c.tenant_id FOR UPDATE OF c)
      SELECT tenant,received FROM changed UNION ALL SELECT tenant,received FROM unchanged`;
    const text=mode==='receive'?receive:`WITH work AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS w(tenant uuid,revision text,due bigint)) UPDATE ${relation} c SET ${assignments[mode]} FROM work w WHERE c.consumer=$1 AND c.tenant_id=w.tenant AND ${fences[mode]} RETURNING c.tenant_id::text AS tenant,c.output_received::text AS received`;
    // Four fixed statements per configured namespace, never per tenant or
    // revision. Reuse their parse/plan on each bounded pool connection.
    const result=await client.query({name:'realtime-receipt-v2:'+parts[0]+':'+mode,text},[consumer,worker,JSON.stringify(rows)]);
    if(['receive','complete'].includes(mode)&&result.rows.length!==rows.length)throw new Error('REALTIME_RECEIPT_NOT_PROVISIONED_OR_REPLACED');
    const committed=await client.query('COMMIT');
    if(committed.command!=='COMMIT')throw new Error('REALTIME_RECEIPT_COMMIT_UNCONFIRMED');
    return result;
  }catch(error){failure=error;throw error;}finally{
    // A failed/unknown COMMIT evicts the client; never queue cleanup behind
    // unknown server work. PostgreSQL rolls an uncommitted session back.
    client.release(failure);
  }
}
module.exports={update};
