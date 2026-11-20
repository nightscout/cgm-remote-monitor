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
// The evaluator's clinical bounds. Writer-driven input has no stream source,
// receiver, slot or login (decision writer-driven-transport-direction).
function parse(value){
 if(!value||Object.keys(value).join(',')!=='bounds')throw new TypeError('Explicit evaluator clinical bounds required');
 return Object.freeze({bounds:validateBounds(value.bounds)});
}
module.exports={parse,output,validateBounds};
