'use strict';
// Runs ONLY inside the owned, isolated test container. All values are synthetic.
const assert = require('node:assert/strict');
const { MongoClient, ObjectId } = require('/opt/app/node_modules/mongodb');
const mode = process.argv[2];
assert(['baseline', 'candidate'].includes(mode));
const uri = process.env.MONGO_CONNECTION;
assert.equal(uri, 'mongodb://127.0.0.1:27017/test_nsp_t2_3466_20261110');
const client = new MongoClient(uri);
const url = 'http://127.0.0.1:1337/api/v1/entries';
const secret = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
const checks = [];
let token;
const base = Date.UTC(2026, 9, 1);
function sample(n, extra = {}) {
  const date = base + n * 300000;
  return Object.assign({type: 'sgv', sgv: 110, date, dateString: new Date(date).toISOString(), device: 'synthetic-xdrip'}, extra);
}
async function post(body, authorized = true) {
  const res = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json', ...(authorized ? {'api-secret': secret} : {})}, body: JSON.stringify(body)});
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  return {status: res.status, body: parsed};
}
async function ok(body) { const res = await post(body); assert.equal(res.status, 200, JSON.stringify(res)); return res.body; }
async function api3(body, expected) {
  const res = await fetch('http://127.0.0.1:1337/api/v3/entries', {method: 'POST', headers: {'content-type': 'application/json', Authorization: 'Bearer '+token}, body: JSON.stringify(body)});
  const parsed = await res.json(); assert(expected ? res.status === expected : [200,201].includes(res.status), JSON.stringify(parsed)); return parsed;
}
function pass(name) { checks.push(name); }
async function main() {
  for (let n = 0; n < 50; n++) {
    try { if ((await fetch('http://127.0.0.1:1337/api/v1/status.json')).ok) break; } catch (_) {}
    if (n === 49) throw Error('Isolated server failed to boot');
    await new Promise(r => setTimeout(r, 500));
  }
  await client.connect();
  const col = client.db().collection('entries');
  await col.deleteMany({});
  const subject = await fetch('http://127.0.0.1:1337/api/v2/authorization/subjects', {method: 'POST', headers: {'content-type':'application/json','api-secret':secret}, body:JSON.stringify({name:'synthetic-cross-api-test',roles:['admin'],notes:'isolated synthetic fixture'})});
  assert.equal(subject.status,200);
  const subjects = await fetch('http://127.0.0.1:1337/api/v2/authorization/subjects', {headers:{'api-secret':secret}});
  assert.equal(subjects.status,200);
  const auth = (await subjects.json()).find(s=>s.name==='synthetic-cross-api-test');assert(auth && auth.accessToken);
  const jwt = await fetch('http://127.0.0.1:1337/api/v2/authorization/request/'+encodeURIComponent(auth.accessToken));
  assert.equal(jwt.status,200); token=(await jwt.json()).token; assert(token);
  const v3doc = {type:'sgv',date:sample(1).date,sgv:110,device:'synthetic-AAPS',app:'synthetic-AAPS',utcOffset:420,isValid:true,isReadOnly:false};
  await api3(v3doc);
  const existing = await col.findOne({date:sample(1).date,type:'sgv'});
  assert(existing.identifier); assert(!('sysTime' in existing));
  const response = await ok(sample(1,{sgv:120}));
  const overlapping = await col.find({date: existing.date, type: 'sgv'}).toArray();
  assert.equal(overlapping.length, mode === 'baseline' ? 2 : 1);
  pass(mode === 'baseline' ? 'Confirmed duplicate via real API v3 then v1 on unmodified deployed image' : 'Real API v1 backfill updates real API v3 row without duplicate');
  if (mode === 'baseline') { console.log(JSON.stringify({mode, checks, overlap_count: overlapping.length})); return; }
  assert.equal(String(overlapping[0]._id), String(existing._id));
  assert.equal(overlapping[0].identifier, existing.identifier);
  assert.equal(overlapping[0].app, existing.app);
  assert.equal(overlapping[0].srvCreated, existing.srvCreated);
  assert.equal(String(response[0]._id), String(existing._id));
  pass('Preserves stored id, API v3 identifier, app, creation cursor, and response identity');
  assert.deepEqual(overlapping[0],existing);assert.equal(response[0].sgv,existing.sgv);assert.equal(response[0].device,existing.device);
  pass('Existing AAPS record and immutable metadata remain unchanged; response reports stored reading');
  await ok(sample(1));
  assert.equal(await col.countDocuments({date: existing.date}), 1);
  pass('Repeated backfill remains idempotent');
  await api3(v3doc);
  assert.equal(await col.countDocuments({date:existing.date}),1);
  pass('API v3 resend after v1 backfill keeps one record');
  await ok(sample(2)); await ok(sample(2, {sgv: 120}));
  const legacy = await col.find({date: sample(2).date}).toArray();
  assert.equal(legacy.length, 1); assert.equal(legacy[0].sgv, 120);
  pass('Legacy v1 resend still updates one row');
  await col.insertOne({_id: '5f3100000000000000000b01', sysTime: sample(3).dateString, type: 'sgv', sgv: 110});
  const legacyRes = await ok(sample(3, {_id: '5f3100000000000000000b02'}));
  assert.equal(await col.countDocuments({sysTime: sample(3).dateString, type: 'sgv'}), 1);
  assert.equal(legacyRes[0]._id, '5f3100000000000000000b01');
  pass('Legacy sysTime-only row and differing submitted immutable id remain supported');
  await col.insertOne({type: 'mbg', date: sample(4).date, mbg: 110});
  await ok(sample(4)); assert.equal(await col.countDocuments({date: sample(4).date}), 2);
  pass('Does not merge different entry types at same timestamp');
  await ok(sample(5)); await ok(sample(6));
  assert.equal(await col.countDocuments({date: {$in: [sample(5).date, sample(6).date]}}), 2);
  pass('Does not merge different timestamps');
  const tz = sample(7); await col.insertOne({date: tz.date, type: 'sgv', sgv: 110});
  const offset = new Date(tz.date + 3600000).toISOString().replace('Z', '+01:00');
  await ok(sample(7, {dateString: offset}));
  assert.equal(await col.countDocuments({date: tz.date}), 1);
  pass('Timezone-equivalent dateString matches numeric API v3 date');
  await col.insertOne({date: sample(8).date, sysTime: sample(9).dateString, type: 'sgv', sgv: 110});
  await ok(sample(8)); assert.equal(await col.countDocuments({date: sample(8).date}), 2);
  pass('Existing legacy sysTime remains authoritative over conflicting numeric date');
  const a = {_id: new ObjectId(), type: 'sgv', date: sample(10).date, sgv: 110};
  await col.insertOne(a);
  const batch = await ok([sample(10), sample(11)]);
  assert.equal(batch.length, 2); assert.equal(String(batch[0]._id), String(a._id));
  assert.equal(await col.countDocuments({date: {$in: [sample(10).date, sample(11).date]}}), 2);
  assert(batch[1]._id);
  pass('Mixed existing API v3 and new v1 batch returns correct stored ids');
  const freshId = '5f3100000000000000000b12';
  await ok(sample(12, {_id: freshId}));
  assert.equal(String((await col.findOne({date: sample(12).date}))._id), freshId);
  pass('New submitted ObjectId is preserved');
  const before = await col.countDocuments({});
  const bad = await post(sample(13, {type: {$ne: null}}));
  assert(bad.status >= 400); assert.equal(await col.countDocuments({}), before);
  pass('Rejects non-string selector-like type without modifying data');
  const unauthorized = await post(sample(14), false);
  assert([401, 403].includes(unauthorized.status)); assert.equal(await col.countDocuments({}), before);
  pass('Unauthenticated writes remain rejected');
  await ok(sample(15));
  const reverse = await col.findOne({date:sample(15).date});
  const back = {type:'sgv',date:sample(15).date,sgv:110,device:'synthetic-AAPS',app:'synthetic-AAPS',utcOffset:420};
  await api3(back);
  const reverseRows=await col.find({date:sample(15).date}).toArray();
  assert.equal(reverseRows.length,1);assert.equal(String(reverseRows[0]._id),String(reverse._id));
  pass('Reverse v1-to-v3 resend also deduplicates and preserves stored id');
  const adopted=reverseRows[0];assert.equal(adopted.device,back.device);assert.equal(adopted.utcOffset,420);
  await api3(back);assert.equal(await col.countDocuments({date:back.date}),1);
  pass('Legacy identity adoption sets AAPS metadata and subsequent AAPS retries succeed');
  await api3({...back,identifier:adopted.identifier,device:'other-uploader'},400);
  await api3({...back,identifier:adopted.identifier,utcOffset:0},400);
  pass('Identified API v3 entries still reject device or timezone changes');
  const readOnly={...v3doc,date:sample(16).date,isReadOnly:true};
  await api3(readOnly);const beforeReadOnly=await col.findOne({date:readOnly.date});
  await ok(sample(16,{sgv:120}));assert.deepEqual(await col.findOne({date:readOnly.date}),beforeReadOnly);
  pass('Backfill leaves an existing read-only API v3 record intact');
  console.log(JSON.stringify({mode, checks, passed: checks.length}));
}
main().catch(err => { console.error(err.stack); process.exitCode = 1; }).finally(() => client.close());
