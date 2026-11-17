'use strict';

// Owned-process controls. Actual handlers complete before responses are held
// or lost. They are never loaded by a serving deployment.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const directory = process.env.NS_API_ROSTER_CONTROL_DIR;
if (!directory || !path.isAbsolute(directory)) throw new Error('Explicit owned replica control directory required');
const invalidate = require('../../lib/server/internal-api/contracts').lifecycleParticipant.operations.invalidateTenant.path;
const original = http.ServerResponse.prototype.end, held = [];
http.ServerResponse.prototype.end = function (...args) {
  if (this.req.headers['x-roster-hold'] === 'postcommit' && this.req.method === 'POST' && this.statusCode === 201) {
    held.push({ response: this, args });
    fs.writeFileSync(path.join(directory, 'held-' + process.env.NS_API_ROSTER_ID), 'postcommit', { mode: 0o600 });
    return this;
  }
  const marker = path.join(directory, 'drop-invalidation-' + process.env.NS_API_ROSTER_ID);
  if (this.req.url === invalidate && this.statusCode === 200 && fs.existsSync(marker)) {
    fs.unlinkSync(marker);
    fs.writeFileSync(path.join(directory, 'lost-invalidation-' + process.env.NS_API_ROSTER_ID), 'handler-completed', { mode: 0o600 });
    this.destroy(); return this;
  }
  return original.apply(this, args);
};
// Only the suite controller can create this file. Pause after the database
// accepted a synthetic INSERT, while the real API transaction is still open.
const { Client } = require('pg');
const query = Client.prototype.query;
const arm = path.join(directory, 'arm-write-' + process.env.NS_API_ROSTER_ID);
let resumeWrite;
Client.prototype.query = function (...args) {
  const result = query.apply(this, args);
  const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
  if (!sql || !/^INSERT INTO "?preview_data"?\."?entries"?\s/i.test(sql) || !fs.existsSync(arm)) return result;
  fs.unlinkSync(arm);
  return result.then(async value => {
    if (value.rowCount !== 1) throw new Error('Expected one uncommitted synthetic entry');
    const waiting = new Promise(resolve => { resumeWrite = resolve; });
    fs.writeFileSync(path.join(directory, 'held-write-' + process.env.NS_API_ROSTER_ID), 'inserted', { mode: 0o600 });
    await waiting;
    return value;
  });
};
process.on('SIGUSR2', () => {
  if (resumeWrite) { resumeWrite(); resumeWrite = undefined; }
  for (const { response, args } of held.splice(0)) original.apply(response, args);
});
