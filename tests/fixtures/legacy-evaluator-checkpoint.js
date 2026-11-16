'use strict';
// Migration input only. Do not resurrect the retired JSONB evaluator runtime to
// produce historical rows: its digest is part of the persisted work-v1 format.
const {createHash}=require('node:crypto');
const {canonical}=require('../../lib/server/serve/evaluator-runtime');
module.exports=(namespace,consumer)=>({consumer:consumer+'-completed',digest:createHash('sha256').update(canonical(['evaluator-work-v1',namespace,consumer])).digest('hex')});
