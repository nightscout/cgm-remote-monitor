'use strict';
const {createRequire} = require('node:module');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = process.argv[2];
assert(root && require('node:path').isAbsolute(root), 'Provide an absolute checkout path');
assert.equal(typeof global.gc, 'function', 'Run Node with --expose-gc');
assert(!process.argv[3] || ['bounded', 'unbounded'].includes(process.argv[3]), 'Optional mode must be bounded or unbounded');
const req = createRequire(root + '/package.json');
const {MongoClient, ObjectId} = req('mongodb');
(async () => {
  const client = new MongoClient('mongodb://127.0.0.1:27169', {monitorCommands:true});
  const db = client.db('nightscout_read_probe_' + crypto.randomUUID().replaceAll('-', ''));
  const commands = [], batches = [];
  client.on('commandStarted', e => {if (['find','getMore'].includes(e.commandName)) commands.push({name:e.commandName,batchSize:e.command.batchSize ?? null});});
  client.on('commandSucceeded', e => {if (['find','getMore'].includes(e.commandName)) batches.push((e.reply.cursor.firstBatch || e.reply.cursor.nextBatch).length);});
  try {
    await client.connect();
    const docs = Array.from({length:8928}, (_, i) => ({_id:new ObjectId(i.toString(16).padStart(24,'0')), date:1700000000000+i*300000,sgv:80+i%180,type:'sgv',device:'fixture',direction:'Flat', noise:1}));
    await db.collection('entries').insertMany(docs);
    await db.collection('entries').createIndex({date:-1});
    const entries = req('./lib/server/entries')({entries_collection:'entries'}, {store:process.argv[3] ? {collection(name) {const col=db.collection(name); return {find(q) {const cursor=col.find(q); return process.argv[3] === 'bounded' ? cursor.batchSize(1000) : cursor;}};}} : db});
    for (const count of [undefined,1000,1500]) {
      commands.length=0; batches.length=0;
      global.gc(); const before=process.memoryUsage().heapUsed; const start=performance.now();
      const rows = await entries.list({find:{date:{$gte:1700000000000}}, ...(count ? {count} : {})});
      const elapsedMs=performance.now()-start, heapDelta=process.memoryUsage().heapUsed-before;
      assert.equal(rows.length,count||8928);
      rows.forEach((r,i)=> {assert.equal(r.date,docs[8927-i].date); assert.equal(r._id.toHexString(), docs[8927-i]._id.toHexString());});
      console.log(JSON.stringify({driver:req('mongodb/package.json').version,count:rows.length,hash:crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'),commands,batches,elapsedMs,heapDelta}));
    }
  } finally {await db.dropDatabase(); await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
