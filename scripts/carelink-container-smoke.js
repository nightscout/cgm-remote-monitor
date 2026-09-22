'use strict';

// Explicit, account-free smoke against the supplied localhost-only Compose
// deployment. Opens the public login screen, checks frames, then cancels it.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const crash = process.argv.includes('--crash');
const base = 'http://127.0.0.1:1337/api/v1/connect/carelink';
const headers = { 'api-secret': crypto.createHash('sha1').update(process.env.API_SECRET || 'carelink-local-testing-only').digest('hex'),
  'content-type': 'application/json' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(path, options = {}) {
  const response = await fetch(base + path, { headers, ...options, signal: AbortSignal.timeout(30000) });
  const data = response.status === 204 ? null : await response.json();
  assert.ok(response.ok, 'Local API failed: ' + response.status + ' ' + (data?.error || ''));
  return data;
}
(async () => {
  // Compose reports "started" before Nightscout has finished its boot sequence.
  let anonymous;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { anonymous = await fetch(base, { signal: AbortSignal.timeout(2000) }); break; }
    catch (error) { if (attempt === 29) throw error; await delay(1000); }
  }
  assert.equal(anonymous.status, 401);
  const status = await call('');
  assert.ok(status.available, 'Browser broker is unavailable');
  assert.equal(status.configured, false, 'Use an unconfigured disposable test instance');
  const countries = await call('/countries');
  assert.ok(countries.some(c => c.code === 'GB'));
  const s = await call('/sessions', { method: 'POST', body: JSON.stringify({ country: 'GB', width: 800, height: 800 }) });
  try {
    let ready;
    for (let n = 0; n < 30; n++) {
      const state = await call('/sessions/' + s.id);
      if (state.state === 'waiting') { ready = true; break; }
      assert.notEqual(state.state, 'failed', 'Browser startup failed: ' + state.error);
      await delay(1000);
    }
    assert.ok(ready, 'Browser startup timed out');
    let seq = 0, bytes;
    for (let n = 0; n < 5; n++) {
      const frame = await call('/sessions/' + s.id + '/frame?after=' + seq);
      seq = frame.seq;
      if (frame.image) {
        bytes = Buffer.from(frame.image, 'base64');
        if (bytes.length > 10000) break; // wait beyond an initial blank/loading frame
      }
      await delay(250);
    }
    assert.ok(bytes && bytes.length > 1000, 'No browser frame received');
    assert.equal(bytes.readUInt16BE(0), 0xffd8, 'Frame must be JPEG');
    console.log('PASS: private API, country discovery, browser startup and JPEG frame delivery (' + bytes.length + ' bytes).');
    const diagnostics = await call('/sessions/' + s.id);
    if (diagnostics.blockedHosts?.length) console.log('Blocked third-party hosts:', diagnostics.blockedHosts.join(', '));
    if (crash) {
      execFileSync('docker', ['exec', '--workdir', '/tmp', 'nightscout-carelink-native-nightscout-1', 'node', '-e',
        "const fs=require('fs');const ids=fs.readdirSync('/proc').filter(p=>/^[0-9]+$/.test(p)).filter(p=>{try{return fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0').includes('/opt/carelink/browser/worker.js')}catch(_){return false}});if(ids.length!==1)process.exit(1);process.kill(Number(ids[0]),'SIGKILL');"], { stdio: 'pipe' });
      let failed;
      for (let i = 0; i < 10; i++) {
        const result = await call('/sessions/' + s.id);
        if (result.state === 'failed') { failed = true; break; }
        await delay(500);
      }
      assert.ok(failed, 'Worker crash was not reported');
      await delay(1000);
      execFileSync('docker', ['exec', '--workdir', '/tmp', 'nightscout-carelink-native-nightscout-1', 'node', '-e',
        "const fs=require('fs');if(fs.readdirSync('/tmp').some(n=>n.startsWith('nightscout-carelink-')))process.exit(1);const leaked=fs.readdirSync('/proc').filter(p=>/^[0-9]+$/.test(p)).some(p=>{try{return /^(chromium|Xvfb)$/.test(fs.readFileSync('/proc/'+p+'/comm','utf8').trim())}catch(_){return false}});if(leaked)process.exit(1);"], { stdio: 'pipe' });
      console.log('PASS: forced worker crash reported; browser processes and temporary profiles removed.');
    }
  } finally {
    await call('/sessions/' + s.id, { method: 'DELETE' });
    const cancelled = await call('/sessions/' + s.id);
    assert.equal(cancelled.state, crash ? 'failed' : 'cancelled');
    console.log('PASS: session closed. No Medtronic account was used.');
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
