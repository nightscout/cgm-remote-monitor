'use strict';
const source=require('../../lib/pgstream/intake-profile'),domain=require('../../lib/tenant-lifecycle/generation-domain');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
function profile(options={}){return source.create({namespace:'synthetic_work',membershipNamespace:'synthetic_members',lifecycleNamespace:'synthetic_window',role:'synthetic_intake',consumer:'evaluator-domain',revision:'1',members:1,tenants:[A,B],codec:source.CODEC,generationDomain:source.GENERATION_DOMAIN,...options});}
// Catalogue protocol model only: native deparser, locks and CHECK enforcement unmeasured.
function metadata(selected,mutate=()=>{}){return(kind,rows,...rest)=>{if(selected){if(kind==='tenant_lifecycle_windows')rows[0].constraints.push({definition:domain.constraint(),valid:true,deferrable:false});if(kind==='ledger')rows.push(...domain.catalogue(selected).migrations.slice(-1).map(({name,checksum})=>({name,checksum})));}mutate(kind,rows,...rest);};}
module.exports={profile,metadata,A,B};
