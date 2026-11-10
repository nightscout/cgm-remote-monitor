'use strict';
// Explicit fixture-only service; transport controls do not substitute product authority.
const object = {type:'object'};
const service = {id:'synthetic-transport', version:1, operations:{echo:{path:'/authorize', request:object, response:object}}};
const headers = selected => ({'content-type':'application/json', 'x-nightscout-internal-service':selected.id, 'x-nightscout-internal-version':String(selected.version)});
module.exports = {service,headers};
