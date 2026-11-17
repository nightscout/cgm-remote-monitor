'use strict';
// Fixed trusted delivery bookkeeping. No clinical data or serving operation is
// admitted here: a suspended tenant's progress must not block another tenant.
// Realtime is the sole owner of completed-output delivery progress. The
// evaluator checkpoint's committed delivery_revision is the obligation; these
// columns record what this realtime role attempted and completed.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const validTenant=value=>typeof value==='string'&&UUID.test(value)&&value!=='00000000-0000-0000-0000-000000000000';
const exact=value=>typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
const SHAPES=Object.freeze({claim:'tenant',finish:'due,ok,revision,tenant'});
async function update ({pool,observeBackend,table,consumer,worker,mode,rows,confirm}) {
  const parts=typeof table==='string'?table.split('.'):[];
  if(parts.length!==2||parts[1]!=='tenant_consumer_checkpoint'||!/^[a-z][a-z0-9_]{0,62}$/.test(parts[0])||parts[0].startsWith('pg_')||['public','information_schema'].includes(parts[0])||
    !/^realtime-[A-Za-z0-9_-]{1,112}$/.test(consumer)||!validTenant(worker)||!Object.hasOwn(SHAPES,mode)||
    !Array.isArray(rows)||rows.length<1||rows.length>64||new Set(rows.map(row=>row?.tenant)).size!==rows.length||
    rows.some(row=>!validTenant(row?.tenant)||Object.keys(row).sort().join(',')!==SHAPES[mode]||
      mode==='finish'&&(!exact(row.revision)||typeof row.ok!=='boolean'||!Number.isSafeInteger(row.due)||row.due<0))||
    confirm!==undefined&&typeof confirm!=='function'||typeof pool?.connect!=='function'||typeof observeBackend!=='function')throw new TypeError('Fixed bounded realtime receipt bookkeeping required');
  const relation='"'+parts[0]+'".tenant_consumer_checkpoint';
  // claim: a starting owner adopts its owned rows and makes known retries due.
  // finish: one statement records a whole delivered page. Progress is monotone
  // (GREATEST); a failed attempt keeps output_completed and sets one retry due
  // time; a row held by another owner is refused and fails the page closed.
  const statements={
    claim:`WITH work AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS w(tenant uuid))
      UPDATE ${relation} c SET output_owner=$2::uuid,output_retry_at=NULL FROM work w
      WHERE c.consumer=$1 AND c.tenant_id=w.tenant AND c.output_delivery_version=1 AND (c.output_owner IS DISTINCT FROM $2::uuid OR c.output_retry_at IS NOT NULL)
      RETURNING c.tenant_id::text AS tenant,c.output_completed::text AS completed`,
    finish:`WITH work AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS w(tenant uuid,revision text,due bigint,ok boolean))
      UPDATE ${relation} c SET output_delivery_version=1,output_owner=$2::uuid,
        output_received=GREATEST(c.output_received,w.revision::bigint),
        output_completed=CASE WHEN w.ok THEN GREATEST(c.output_completed,w.revision::bigint) ELSE c.output_completed END,
        output_retry_at=CASE WHEN GREATEST(c.output_received,w.revision::bigint)<=CASE WHEN w.ok THEN GREATEST(c.output_completed,w.revision::bigint) ELSE c.output_completed END THEN NULL
          WHEN w.ok THEN c.output_retry_at ELSE w.due END
      FROM work w WHERE c.consumer=$1 AND c.tenant_id=w.tenant AND c.output_delivery_version IN (0,1) AND (c.output_owner IS NULL OR c.output_owner=$2::uuid)
      RETURNING c.tenant_id::text AS tenant,c.output_completed::text AS completed`
  };
  const client=await pool.connect();let failure;
  try{
    await observeBackend(client);
    await client.query('BEGIN');
    // Two fixed statements per configured namespace, never per tenant or
    // revision. Reuse their parse/plan on each bounded pool connection.
    const result=await client.query({name:'realtime-receipt-v3:'+parts[0]+':'+mode,text:statements[mode]},[consumer,worker,JSON.stringify(rows)]);
    if(mode==='finish'&&result.rows.length!==rows.length)throw new Error('REALTIME_RECEIPT_NOT_PROVISIONED_OR_REPLACED');
    // Current ownership is confirmed while the row locks are held.
    if(confirm)await confirm();
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
