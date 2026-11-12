'use strict';
// Owned diagnostic output only. Never wraps/closes the application's stdout.
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
parentPort.on('message', bytes => {
  let okay = false;
  try {
    if (bytes instanceof ArrayBuffer && bytes.byteLength <= 8192) {
      const buffer = Buffer.from(bytes);
      okay = fs.writeSync(1, buffer, 0, buffer.length) === buffer.length;
    }
  } catch { /* EPIPE/backpressure/partial output is missing telemetry. */ }
  parentPort.postMessage(okay);
});
