'use strict';
// Checker resource bounds, not role configuration or deployment sizing policy.
const fs = require('node:fs');
const MAX_BYTES = 268435456, MAX_NODES = 1000000, MAX_DEPTH = 64, MAX_REPORT_BYTES = 4194304;
const fail = code => Object.assign(new Error(code), { code });
function inspect (value, { maxBytes = MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw fail('PLAN_INPUT_BOUND');
  const stack = [[value, 0]], ancestors = new Set(), strings = new Map();
  let nodes = 1, bytes = 0;
  const charge = count => { if (count > maxBytes - bytes) throw fail('PLAN_INPUT_BOUND'); bytes += count; };
  const stringBytes = text => {
    // UTF-16 length is a lower bound on escaped UTF-8 JSON size. Do not
    // allocate an escaped token or flatten an oversized serialized graph.
    if (text.length + 2 > maxBytes - bytes) throw fail('PLAN_INPUT_BOUND');
    const cached = strings.get(text);
    if (cached !== undefined) { charge(cached); return; }
    let size = 2;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) size += 2;
      else if (c < 32) size += 6;
      else if (c < 128) size++;
      else if (c < 2048) size += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { size += 4; i++; }
      else if (c >= 0xd800 && c <= 0xdfff) size += 6; // Well-formed JSON escapes lone surrogates.
      else size += 3;
      if (size > maxBytes - bytes) throw fail('PLAN_INPUT_BOUND');
    }
    charge(size);
    if (strings.size < 1024) strings.set(text, size);
  };
  while (stack.length) {
    const [item, depth, exiting] = stack.pop();
    if (exiting) { ancestors.delete(item); continue; }
    if (depth > MAX_DEPTH) throw fail('PLAN_INPUT_BOUND');
    if (typeof item === 'string') stringBytes(item);
    else if (typeof item === 'number') { if (!Number.isFinite(item)) throw fail('PLAN_INPUT_NOT_JSON'); charge(String(item).length); }
    else if (item === null) charge(4);
    else if (typeof item === 'boolean') charge(item ? 4 : 5);
    else if (typeof item === 'object') {
      const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
      if (ancestors.has(item) || !(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null) || Object.getOwnPropertySymbols(item).length) throw fail('PLAN_INPUT_NOT_JSON');
      const keys = Object.keys(item);
      // Charge every logical occurrence, including a shared object or string.
      // Avoid bulk descriptor/serialization allocation before the node bound.
      if (keys.length > MAX_NODES - nodes) throw fail('PLAN_INPUT_BOUND');
      nodes += keys.length;
      if (array && (keys.length !== item.length || keys.some((key, i) => key !== String(i))) || Object.getOwnPropertyNames(item).length !== keys.length + (array ? 1 : 0)) throw fail('PLAN_INPUT_NOT_JSON');
      charge(2 + Math.max(0, keys.length - 1));
      ancestors.add(item); stack.push([item, depth, true]);
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!Object.hasOwn(descriptor, 'value')) throw fail('PLAN_INPUT_NOT_JSON');
        if (!array) { stringBytes(key); charge(1); }
        stack.push([descriptor.value, depth + 1]);
      }
    } else throw fail('PLAN_INPUT_NOT_JSON');
  }
  return { bytes, nodes };
}

function read (name) {
  const owned = name !== '-', fd = owned ? fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK) : 0;
  try {
    const stat = fs.fstatSync(fd);
    if (owned && !stat.isFile()) throw fail('PLAN_INPUT_NOT_REGULAR');
    if (stat.isFile() && stat.size > MAX_BYTES) throw fail('PLAN_INPUT_BOUND');
    const chunks = []; let total = 0;
    while (total <= MAX_BYTES) {
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
