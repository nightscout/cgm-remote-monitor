'use strict';
// Isolated runtime-grant qualification. No application role integration claim.
const { Client } = require('pg');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const directory = process.env.PGSTREAM_ROLE_EVIDENCE;
const binary = process.env.PGSTREAM_BINARY;
if (!directory || !binary || !process.env.NS_TEST_POSTGRES_ADMIN_URI) throw Error('Explicit fixture environment required');
const adminURL = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI);
if (!adminURL.pathname.includes('test') || !['127.0.0.1', 'localhost'].includes(adminURL.hostname)) throw Error('Loopback disposable test database required');
fs.mkdirSync(directory, {recursive:true});
const admin = new Client({connectionString:adminURL.href});
const roleName = process.env.PGSTREAM_PROBE_ROLE || 'ns_pgstream_runtime';
if (!/^ns_pgstream_[a-z_]+$/.test(roleName)) throw Error('Probe role required');
const runtimeURL = new URL(adminURL); runtimeURL.username=roleName;
const slot = roleName + '_slot';
let child, server; const events=[];
const record = entry => fs.appendFileSync(directory+'/grants.jsonl',JSON.stringify(entry)+'\n');
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(check, label) { const end=Date.now()+10000; while(Date.now()<end){if(await check())return;await delay(25);}throw Error('TIMEOUT '+label); }
async function stop(){if(!child || child.exitCode!==null || child.signalCode!==null)return;const c=child;const exited=new Promise(r=>c.once('exit',r));c.kill('SIGTERM');await Promise.race([exited,delay(2000)]);if(c.exitCode===null&&c.signalCode===null){c.kill('SIGKILL');await exited;}}
async function command(args,label){const fd=fs.openSync(directory+'/'+label+'.log','a');const c=spawn(binary,args,{stdio:['ignore',fd,fd]});const code=await new Promise(r=>c.once('exit',r));fs.closeSync(fd);assert.equal(code,0,label);}
function config(){return `source:\n  postgres:\n    url: "${runtimeURL.href}"\n    mode: replication\n    replication:\n      replication_slot: ${slot}\n      plugin:\n        add_tables: "ns_pgstream_probe.heartbeat"\ntarget:\n  webhooks:\n    subscriptions:\n      store:\n        url: "${runtimeURL.href}"\n        cache:\n          enabled: false\n      server:\n        address: "127.0.0.1:19924"\n    notifier:\n      worker_count: 1\n      strict_mode: true\n      client_timeout: 1000\n      constant:\n        max_retries: 1\n        interval: 50\n`;}
(async()=>{
 await admin.connect();
 if (process.env.PGSTREAM_PROBE_EXISTING !== '1') {
 await admin.query(`CREATE ROLE ${roleName} LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
 await admin.query('CREATE SCHEMA ns_pgstream_probe');
 await admin.query('CREATE TABLE ns_pgstream_probe.heartbeat(id integer PRIMARY KEY, revision bigint NOT NULL)');
 await command(['init','--postgres-url',adminURL.href,'--replication-slot',slot],'dba-init');
 await admin.query('CREATE TABLE pgstream.webhook_subscriptions(url TEXT,schema_name TEXT,table_name TEXT,event_types TEXT[],PRIMARY KEY(url,schema_name,table_name))');
 await admin.query('INSERT INTO pgstream.webhook_subscriptions VALUES($1,$2,$3,$4)', ['http://127.0.0.1:19925/receipt','ns_pgstream_probe','heartbeat',['I','U','D']]);
 }
 await admin.query(`GRANT USAGE ON SCHEMA pgstream TO ${roleName}`);
 await admin.query(`GRANT SELECT ON pgstream.webhook_subscriptions TO ${roleName}`);
 if (process.env.PGSTREAM_PROBE_CREATE === '1') await admin.query(`GRANT CREATE ON SCHEMA pgstream TO ${roleName}`);
 const role=(await admin.query("SELECT rolsuper,rolreplication,rolcreatedb,rolcreaterole,rolinherit,pg_has_role(oid,'pg_read_all_data','MEMBER') AS all_data FROM pg_roles WHERE rolname=$1",[roleName])).rows[0]; record({kind:'identity',...role});
 server=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;events.push(JSON.parse(text));res.writeHead(204).end();});
 await new Promise(r=>server.listen(19925,'127.0.0.1',r));
 fs.writeFileSync(directory+'/runtime.yaml',config(),{mode:0o600});
 const fd=fs.openSync(directory+'/runtime.log','a');child=spawn(binary,['run','-c',directory+'/runtime.yaml','--log-level','debug'],{stdio:['ignore',fd,fd]});
 await until(()=>fs.readFileSync(directory+'/runtime.log','utf8').includes('running webhook notifier')||child.exitCode!==null,'runtime startup');
 const written=(await admin.query('INSERT INTO ns_pgstream_probe.heartbeat VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=ns_pgstream_probe.heartbeat.revision+1 RETURNING revision::text')).rows[0].revision;
 await until(()=>events.some(event=>event.Data?.columns?.some(column=>column.name==='revision' && String(column.value)===written))||child.exitCode!==null,'narrow runtime delivery');
 assert.equal(child.exitCode,null,'runtime must remain live');assert(events.length,'narrow runtime delivery');
 record({kind:'PASS',criterion:'precreated subscriptions, enumerated runtime grants',event:events.find(event=>event.Data?.columns?.some(column=>column.name==='revision' && String(column.value)===written))});
 const runtime=new Client({connectionString:runtimeURL.href});await runtime.connect();
 for(const sql of ['INSERT INTO pgstream.webhook_subscriptions SELECT * FROM pgstream.webhook_subscriptions', 'SELECT * FROM ns_pgstream_probe.heartbeat']){let code;try{await runtime.query(sql);}catch(e){code=e.code;}assert.equal(code,'42501');record({kind:'denied',operation:sql.split(' ')[0],code});}
 await runtime.end();
 await admin.query(`REVOKE SELECT ON pgstream.webhook_subscriptions FROM ${roleName}`);
 const before=(await admin.query('SELECT pg_current_wal_insert_lsn()::text AS marker')).rows[0].marker;
 await admin.query('UPDATE ns_pgstream_probe.heartbeat SET revision=revision+1 WHERE id=1');
 let progress;
 try { await until(async()=>{progress=(await admin.query('SELECT confirmed_flush_lsn::text,confirmed_flush_lsn > $2::pg_lsn AS past_marker FROM pg_replication_slots WHERE slot_name=$1',[slot,before])).rows[0];return progress?.past_marker || child.exitCode!==null;},'required-grant loss response'); } catch(error) { record({kind:'grant-loss-bound-exceeded',boundMs:10000,before,progress,deliveries:events.length,processExited:child.exitCode!==null}); throw error; }
 record({kind:'grant-loss-observation',before,progress,deliveries:events.length,processExited:child.exitCode!==null});
 assert.equal(progress?.past_marker,false,'REQUIRED_GRANT_LOSS_MUST_NOT_ACK_UNDELIVERED_CHANGE');
 await stop();
 record({kind:'PASS',criterion:'runtime cannot mutate subscriptions or read clinical source by SQL'});
})().catch(error=>{record({kind:'FAIL',error:error.stack});process.exitCode=1;}).finally(async()=>{await stop();if(server)await new Promise(r=>server.close(r));await admin.end();});
