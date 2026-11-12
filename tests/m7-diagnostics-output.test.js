'use strict';
const assert = require('node:assert/strict'), path = require('node:path'), { spawn } = require('node:child_process');
function child (mode, enabled) {
  const worker = spawn(process.execPath, [path.join(__dirname, 'fixtures/m7-diagnostics-output-child.js'), mode], {
    env: { ...process.env, NS_M7_DIAGNOSTICS: enabled ? '1' : '0', NS_M7_DIAGNOSTICS_INTERVAL_MS: '1000' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; worker.stderr.on('data', bytes => { stderr += bytes; });
  const completion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.kill('SIGKILL'); reject(new Error('diagnostic sink changed process drain')); }, 3000);
    worker.on('error', reject); worker.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }); });
  });
  return { worker, completion, result: () => stderr.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(row => row?.clinicalResult) };
}
describe('bounded diagnostic output failure isolation', function () {
  it('does not keep the process alive with an unref worker or timer', async () => {
    for (const enabled of [false, true]) {
      const selected = child('unref', enabled); selected.worker.stdin.end(); selected.worker.stdout.resume(); const result = await selected.completion;
      assert.equal(result.code, 0); assert.equal(result.signal, null); assert.equal(selected.result().clinicalResult, 'unchanged');
    }
  });
  it('never closes application stdout when the diagnostic worker shuts down', async () => {
    for (const enabled of [false, true]) {
      const selected = child('after-close', enabled); selected.worker.stdin.end(); let stdout = '';
      selected.worker.stdout.on('data', bytes => { stdout += bytes; });
      const result = await selected.completion; assert.equal(result.code, 0, result.stderr); assert(stdout.includes('APPLICATION_STDOUT_UNCHANGED'));
      assert.equal(selected.result().clinicalResult, 'unchanged');
    }
  });
  it('treats real EPIPE as missing telemetry without changing application result or drain', async () => {
    for (const enabled of [false, true]) {
      const selected = child('closed-reader', enabled); selected.worker.stdout.destroy(); selected.worker.stdin.end('go'); const result = await selected.completion;
      assert.equal(result.code, 0, result.stderr); assert.equal(selected.result().clinicalResult, 'unchanged');
      if (enabled) { assert(selected.result().logging.unavailable >= 1); assert(selected.result().logging.dropped >= 1); assert.equal(selected.result().logging.status, 'UNMEASURED'); }
    }
  });
  it('drops snapshots under actual stdout backpressure instead of queuing JSON', async () => {
    for (const enabled of [false, true]) {
      const selected = child('pressure', enabled); selected.worker.stdout.on('data', () => {}); selected.worker.stdout.pause();
      selected.worker.stderr.on('data', () => { if (selected.result()) selected.worker.stdout.resume(); });
      selected.worker.stdin.end('go'); const result = await selected.completion;
      assert.equal(result.code, 0, result.stderr); assert.equal(selected.result().clinicalResult, 'unchanged');
      if (enabled) { assert(selected.result().logging.backpressure >= 20); assert.equal(selected.result().logging.written, 0); }
    }
  });
});
