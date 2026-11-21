'use strict';

// Optional trusted diagnostic only; never changes the rows used by a predicate.
module.exports=function metadataObserver({onMetadata,maxRows,maxBytes}={}) {
  if(onMetadata!==undefined&&(typeof onMetadata!=='function'||!Number.isSafeInteger(maxRows)||maxRows<1||
      !Number.isSafeInteger(maxBytes)||maxBytes<1))throw new TypeError('Explicit bounded metadata observer required');
  let rowsSeen=0,bytesSeen=0;
  return async function observe(kind,rows,table) {
    if(!onMetadata)return;
    const record={kind,...(table?{table}:{}),rows:structuredClone(rows),
      policyRoleTypes:rows.map(row=>(row.policies||[]).map(policy=>Array.isArray(policy.roles)?policy.roles.map(value=>typeof value):typeof policy.roles))};
    rowsSeen+=rows.length;bytesSeen+=Buffer.byteLength(JSON.stringify(record));
    if(rowsSeen>maxRows||bytesSeen>maxBytes)throw new Error('NOTIFICATION_DIAGNOSTIC_BOUND');
    await onMetadata(record);
  };
};
