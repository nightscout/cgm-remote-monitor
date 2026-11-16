'use strict';
const BOUNDS=['stepMs','recoveryMs','pendingMs'];
function validateBounds(value){
 if(!value||Object.keys(value).sort().join(',')!==[...BOUNDS].sort().join(',')||!BOUNDS.every(key=>Number.isSafeInteger(value[key])&&value[key]>0&&value[key]<=2147483647))throw new TypeError('Explicit delivery step, startup recovery and pending bounds required');
 return Object.freeze({...value});
}
const NAME=/^[a-z][a-z0-9_]{0,62}$/;
function output(value){
 if(!value||Object.keys(value).sort().join(',')!=='consumer,namespace'||!NAME.test(value.namespace)||value.namespace.startsWith('pg_')||['public','information_schema'].includes(value.namespace)||!/^evaluator-[A-Za-z0-9_-]{1,100}$/.test(value.consumer))throw new TypeError('Explicit evaluator completed-output source required');
 return Object.freeze({...value});
}
function parse(value){
 if(!value||Object.keys(value).sort().join(',')!=='bounds,receiver,slot,streamRole'||!NAME.test(value.slot)||!NAME.test(value.streamRole))throw new TypeError('Explicit external pgstream receiver configuration required');
 const bounds=validateBounds(value.bounds),receiver=require('../server/internal-api/transport').options(value.receiver);
 if(!receiver.url||!receiver.bindHost||receiver.trust!=='network'||receiver.timeoutMs>bounds.stepMs)throw new TypeError('Explicit private network receiver required');
 const port=Number(new URL(receiver.url).port);
 if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new TypeError('Explicit receiver port required');
 return Object.freeze({...value,bounds,receiver});
}
module.exports={parse,output,validateBounds};
