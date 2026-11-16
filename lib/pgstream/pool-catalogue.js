'use strict';
// One source composition for the complete selected-v2 checkpoint schema.
// Historical v1 adoption is explicit; a fresh v2 catalogue never reinterprets it.
function build(value,{predecessorProfile}={}){
 const profile=require('./pool-intake-profile').validate(value),b=profile.binding;
 const legacy=require('./assignment-candidate').build({membershipNamespace:b.membershipNamespace,lifecycleNamespace:b.lifecycleNamespace});
 const assignment=require('./pool-assignment-candidate').build({base:legacy,membershipNamespace:b.membershipNamespace,lifecycleNamespace:b.lifecycleNamespace,operatorRole:b.operatorRole});
 const intake=require('./pool-intake-candidate').build({base:assignment,intakeProfile:profile});
 const provision=require('./pool-checkpoint-provision-candidate').build({base:intake,intakeProfile:profile});
 const selected=require('./pool-placement-candidate').build({base:provision,intakeProfile:profile});
 if(predecessorProfile===undefined)return selected;
 const origin=require('./pool-intake-adoption').extendCatalogue({base:provision,profile,predecessorProfile});
 return {...selected,predecessorProfile:origin.predecessorProfile,catalogue:{version:1,migrations:[...origin.catalogue.migrations,...selected.catalogue.migrations.slice(provision.catalogue.migrations.length)]}};
}
module.exports={build};
