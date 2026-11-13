'use strict';
// Checker resource bounds, not role configuration or deployment sizing policy.
const fs = require('node:fs');
const MAX_BYTES = 268435456, MAX_NODES = 1000000, MAX_DEPTH = 64, MAX_REPORT_BYTES = 4194304;
const fail = code => Object.assign(new Error(code), { code });
function inspect (value) {
  const stack = [[value, 0]], seen = new Set(); let nodes = 0;
  while (stack.length) {
    const [item, depth, exiting] = stack.pop();
    if (exiting) { seen.delete(item); continue; }
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw fail('PLAN_INPUT_BOUND');
    if (typeof item === 'string') { if (Buffer.byteLength(item) > MAX_BYTES) throw fail('PLAN_INPUT_BOUND'); }
    else if (typeof item === 'number') { if (!Number.isFinite(item)) throw fail('PLAN_INPUT_BOUND'); }
    else if (item && typeof item === 'object') {
      if (seen.has(item) || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item))) throw fail('PLAN_INPUT_NOT_JSON');
      seen.add(item); stack.push([item, depth, true]);
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
        if (!Object.hasOwn(descriptor, 'value')) throw fail('PLAN_INPUT_NOT_JSON');
        stack.push([descriptor.value, depth + 1]);
      }
    } else if (item !== null && typeof item !== 'boolean') throw fail('PLAN_INPUT_NOT_JSON');
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw fail('PLAN_INPUT_BOUND');
}
function read (name) {
  const owned = name !== '-', fd = owned ? fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK) : 0;
  try {
    const stat = fs.fstatSync(fd);
    if (owned && !stat.isFile()) throw fail('PLAN_INPUT_NOT_REGULAR');
    if (stat.isFile() && stat.size > MAX_BYTES) throw fail('PLAN_INPUT_BOUND');
    const chunks = []; let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, MAX_BYTES + 1 - total)), n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break;
      total += n;
      if (total > MAX_BYTES) throw fail('PLAN_INPUT_BOUND');
      chunks.push(chunk.subarray(0, n));
    }
    return Buffer.concat(chunks, total);
  } finally { if (owned) fs.closeSync(fd); }
}
module.exports = { inspect, read, MAX_BYTES, MAX_NODES, MAX_DEPTH, MAX_REPORT_BYTES };
