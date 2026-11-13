'use strict';
const {validate}=require('./supervisor');
const path=require('node:path');
const NAME=/^[a-z][a-z0-9_]{0,62}$/;
function output(value){
 if(!value||Object.keys(value).sort().join(',')!=='consumer,namespace'||!NAME.test(value.namespace)||value.namespace.startsWith('pg_')||['public','information_schema'].includes(value.namespace)||!/^evaluator-[A-Za-z0-9_-]{1,100}$/.test(value.consumer))throw new TypeError('Explicit evaluator completed-output source required');
 return Object.freeze({...value});
}
function parse(value,source){
 if(!value||Object.keys(value).sort().join(',')!=='binaryEnv,bounds,configFileEnv,receiverPort,slot,streamRole'||
   ![value.binaryEnv,value.configFileEnv].every(key=>typeof key==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/.test(key))||
   !Number.isSafeInteger(value.receiverPort)||value.receiverPort<1024||value.receiverPort>65535||!NAME.test(value.slot)||!NAME.test(value.streamRole))throw new TypeError('Explicit pinned pgstream role configuration required');
 const bounds=validate(value.bounds);
 if(source&&![source[value.binaryEnv],source[value.configFileEnv]].every(file=>typeof file==='string'&&path.isAbsolute(file)))throw new TypeError('Absolute pgstream binary and configuration paths required');
 return Object.freeze({...value,bounds,...(source?{binary:source[value.binaryEnv],configFile:source[value.configFileEnv]}:{})});
}
module.exports={parse,output};
