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
    if (this.req.headers['x-roster-release-lifetime'] === '1') {
      const listeners = this.listeners('finish').filter(listener => listener.name === 'finished');
      if (listeners.length !== 1) throw new Error('Actual response-lifetime control must match its owned completion callback');
      listeners[0](); // Deliberate early lifetime completion; the actual wire response remains held.
    }
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
process.on('SIGUSR2', () => { for (const { response, args } of held.splice(0)) original.apply(response, args); });
