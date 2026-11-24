'use strict';

const dns = require('node:dns');
const http = require('node:http');
const net = require('node:net');
const transport = require('./transport');
const contract = require('./contracts').completedOutput;

// One evaluator wake batch is in flight at a time. Each ordinal needs one
// connection. Renew the pool on demand, even if its old Pod still accepts TCP.
const REFRESH_MS = 5000;
module.exports = function completedOutput (options) {
  if (!options?.url) return transport.client(options, contract);
  let current, resolving;

  function pool (hostname) {
    let answer;
    // Reconnects in this pool reuse the full address list for dual-stack
    // fallback. If a request expires during DNS, the next pool can share the
    // outstanding system lookup without submitting another one.
    function lookup (name, opts, callback) {
      if (!answer) {
        resolving = resolving ?? new Promise((resolve, reject) =>
          dns.lookup(name, { ...opts, all: true }, (error, rows) => error ? reject(error) : resolve(rows))
        ).finally(() => { resolving = null; });
        answer = resolving;
      }
      answer.then(rows => {
        if (opts.all) callback(null, rows);
        else callback(null, rows[0].address, rows[0].family);
      }, callback);
    }
    return {
      agent: new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1, lookup }),
      expires: net.isIP(hostname) ? Infinity : performance.now() + REFRESH_MS,
      active: 0
    };
  }
  function retire (used) {
    if (current === used) current = null;
    // Let requests that already own this pool complete under their deadlines.
    if (!used.active) used.agent.destroy();
  }
  function request (settings, onResponse) {
    if (current && performance.now() >= current.expires) retire(current);
    if (!current) current = pool(settings.hostname);
    const used = current;
    let answered = false;
    const req = http.request({ ...settings, agent: used.agent }, res => {
      answered = true;
      onResponse(res);
    });
    used.active++;
    req.once('error', () => { if (!answered) retire(used); });
    req.once('close', () => {
      used.active--;
      if (current !== used && !used.active) used.agent.destroy();
    });
    return req;
  }
  return Object.freeze({
    ...transport.client(options, contract, request),
    close () { if (current) retire(current); }
  });
};
