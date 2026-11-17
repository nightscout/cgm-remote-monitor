'use strict';
const source={system_id:'12345678901234567890',timeline:1,database:'synthetic',slot:'synthetic_main'};
const boundary={source_identity:source,generation:'1',snapshot_position:'0/10',accepted_position:null};
const row=(id,value=100,action='I',tenant='11111111-1111-4111-8111-111111111111')=>({action,xid:42,lsn:'0/20',schema:'synthetic_entries',table:'entries',columns:action==='D'?null:[{name:'tenant_id',value:tenant},{name:'id_kind',value:'string'},{name:'_id',value:id},{name:'doc',type:'jsonb',value:{_id:id,date:1,sgv:value,extension:{kept:true}}},{name:'insertion_ordinal',value:1},{name:'storage_bytes',value:100}],identity:action==='I'?null:[{name:'tenant_id',value:tenant},{name:'id_kind',value:'string'},{name:'_id',value:id},{name:'doc',type:'jsonb',value:{_id:id,date:1,sgv:100}}]});
function envelope(rows,position='0/30'){
 return {Transaction:[{action:'B',xid:42,lsn:position,nextlsn:position,transaction_index:0,source_identity:source},...rows.map((data,i)=>({...data,transaction_index:i+1})),{action:'C',xid:42,lsn:position,nextlsn:position,transaction_index:rows.length+1,transaction_count:rows.length,source_identity:source}]};
}
const coverage=position=>({source_identity:source,generation:'1',position});
module.exports={source,boundary,row,envelope,coverage};
