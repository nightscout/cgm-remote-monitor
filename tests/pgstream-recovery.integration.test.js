'use strict';
// Actual evaluator role and canonical maintained producer, two synthetic tenants.
// Does not exercise selected partition topology, cold API, or restore acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { optInSuite } = require('./support/opt-in');
const stream = require('./fixtures/pgstream-native');
const enabled = process.env.NS_PGSTREAM_RECOVERY_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI;
optInSuite(enabled, 'NS_PGSTREAM_RECOVERY_TEST=1 and owned disposable PostgreSQL plus canonical pgstream fixture inputs')(
  'actual role maintained-stream recovery fault points', function () {
    this.timeout(60000);
    const lab = require('./fixtures/evaluator-preview-registry-lab')();
    let stopped;
    before(() => lab.open());
    after(async () => {
      // Resume only our exact still-current stopped child so normal fixture
      // cleanup can drain it. The supervisor may already have replaced it.
      if (stopped && sameProcess(stopped)) process.kill(stopped.pid, 'SIGCONT');
      await lab.close();
    });
    function identity(pid) {
      const stat = fs.readFileSync('/proc/'+pid+'/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
      return { pid, parent:Number(fields[1]), birth:fields[19], executable:fs.readlinkSync('/proc/'+pid+'/exe') };
    }
    function sameProcess(record) {
      try { return JSON.stringify(identity(record.pid)) === JSON.stringify(record); } catch { return false; }
    }
    function notifier(worker) {
      const selected = stream.capability(process.env);
      const children = fs.readFileSync('/proc/'+worker.child.pid+'/task/'+worker.child.pid+'/children', 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
      const matches = children.map(identity).filter(row => row.executable === selected.binary);
      assert.equal(matches.length, 1, 'ONE_OWNED_MAINTAINED_NOTIFIER');
      const record = matches[0]; assert.equal(record.parent, worker.child.pid);
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync('/proc/'+record.pid+'/exe')).digest('hex'), selected.sha256);
      assert(sameProcess(record), 'NOTIFIER_IDENTITY_BEFORE_SIGNAL'); return record;
    }
    async function wait(check, milliseconds, symptom) {
      const end = performance.now()+milliseconds;
      while (performance.now()<end) {
        const result = await check(); if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(symptom);
    }
    async function write(value, id='synthetic-recovery') {
      const at = Date.now();
      return lab.persistDomains({ entries:[{ _id:id, type:'sgv', sgv:value, date:at-1000, dateString:new Date(at-1000).toISOString(), direction:'Flat' }] });
    }
    function completed(row, stamp) {
      return row && BigInt(require('../lib/pgstream/work-state').map(row.work_completed).clock || '0') >= BigInt(stamp);
    }
    it('commits a clinical write with a stopped notifier, withdraws stale transport and recovers durable output within fixed bounds', async function () {
      await write(110); const config = lab.configure();
      const worker = await lab.worker(config); assert.equal(worker.startup.ready, true);
      const initial = await worker.call('health'); assert.equal(initial.pgstream.healthy, true);
      const before = await lab.previewCompleted();
      const record = notifier(worker); stopped = record;
      const began = performance.now(); process.kill(record.pid, 'SIGSTOP');
      // The storage transaction has no notifier/webhook dependency.
      await write(149);
      const committed = await lab.clock();
      const stamp = committed.stamp;
      assert(stamp !== undefined, 'CANONICAL_COMMITTED_CLOCK_REQUIRED');
      await wait(async () => {
        const health = (await worker.call('health')).pgstream;
        return !health.healthy || health.starts > initial.pgstream.starts;
      }, config.document.pgstream.bounds.stallMs+config.document.pgstream.bounds.heartbeatMs+config.document.pgstream.bounds.stepMs+config.document.pgstream.bounds.stopMs,
      'STOPPED_NOTIFIER_MUST_CHANGE_HEALTH_WITHIN_BOUND');
      const observed = await wait(async () => {
        const health = (await worker.call('health')).pgstream;
        assert.equal(health.terminal, false, health.code || 'NOTIFIER_RECOVERY_TERMINAL');
        const output = await lab.previewCompleted();
        return health.healthy && health.starts > initial.pgstream.starts && completed(output, stamp) && BigInt(output.output_revision)>BigInt(before.output_revision) ? { health, output } : null;
      }, config.document.pgstream.bounds.recoveryMs, 'NOTIFIER_MUST_RECOVER_COMMITTED_OUTPUT');
      assert(!sameProcess(record), 'STOPPED_NOTIFIER_REPLACED'); stopped = null;
      const output = observed.output.projection?.[0]?.output;
      assert(output, 'DURABLE_OUTPUT_REQUIRED');
      assert.equal(output.frame.sgvs.find(row => row._id === 'synthetic-recovery')?.mgdl, 149, 'RECOVERED_OUTPUT_CONTAINS_EXACT_COMMITTED_READING');
      lab.tracePreview('stopped-maintained-notifier-recovered', { elapsedMs:performance.now()-began, bounds:config.document.pgstream.bounds,
        health:observed.health, completed:observed.output.work_completed, outputRevision:observed.output.output_revision });
      await lab.stopWorker(worker);
    });
  });
