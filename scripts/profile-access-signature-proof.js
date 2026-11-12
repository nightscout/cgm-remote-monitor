#!/usr/bin/env node
'use strict';
// Synthetic verifier-only instrument. No external provider, DB, socket or
// deployment-capacity claim; working-set bursts model consecutive consumers
// routed to this one worker, not proof sharing across separate processes.
const crypto = require('node:crypto'), { performance } = require('node:perf_hooks'), fs = require('node:fs');
const source = process.argv[2], selected = process.argv.indexOf('--working-set');
const workingSet = selected < 0 ? 0 : Number(process.argv[selected + 1]), spread = process.argv.includes('--spread-bursts');
if (![0, 1000, 3000].includes(workingSet)) throw new TypeError('Explicit synthetic working set 1000 or 3000 required');
const unique = process.argv.includes('--unique') || workingSet > 0, pair = crypto.generateKeyPairSync('ed25519');
const original = crypto.verify; let checks = 0, resolutions = 0;
crypto.verify = (...args) => { checks++; return original(...args); };
const tokens = require(source), tenant = '11111111-1111-4111-8111-111111111111', kid = 'synthetic', keys = new Map([[tenant, pair.publicKey]]);
const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'ns-access+jwt', kid })).toString('base64url');
function tokenFor (tenantId, session, privateKey = pair.privateKey) {
  const payload = Buffer.from(JSON.stringify({ iss: 'synthetic', aud: 'synthetic', tid: tenantId, purpose: 'data', sub: 'subject', sid: session, cv: 1, iat: 100, nbf: 100, exp: 700 })).toString('base64url');
  const input = header + '.' + payload;
  return input + '.' + crypto.sign(null, Buffer.from(input), privateKey).toString('base64url');
}
const token = tokenFor(tenant, 'warm'), samples = workingSet ? Array.from({ length: workingSet }, (_, i) => {
  const key = crypto.generateKeyPairSync('ed25519'), id = '33333333-3333-4333-8333-' + String(i).padStart(12, '0'); keys.set(id, key.publicKey);
  return { tenant: id, token: tokenFor(id, 'session_' + i, key.privateKey) };
}) : unique ? Array.from({ length: 1000 }, (_, i) => ({ tenant, token: tokenFor(tenant, 'session_' + i) })) : null;
const verify = tokens.createVerifier({ issuer: 'synthetic', audience: 'synthetic', purpose: 'data', maxLifetimeSeconds: 600, now: () => 100,
  resolveKey: (requested, selected) => { resolutions++; return { tenant: requested, kid: selected, issuer: 'synthetic', purpose: 'data', publicKey: keys.get(requested) }; } });
for (let i = 0; i < 100; i++) verify(token, tenant);
checks = 0; resolutions = 0; if (global.gc) global.gc();
const iterations = workingSet ? workingSet * 4 : unique ? 1000 : 10000;
const start = performance.now(), cpu = process.cpuUsage(), before = process.memoryUsage().heapUsed;
for (let i = 0; i < iterations; i++) {
  const sample = samples && samples[(workingSet && !spread ? Math.floor(i / 2) : i) % samples.length];
  verify(sample ? sample.token : token, sample ? sample.tenant : tenant);
}
const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu); if (global.gc) global.gc();
process.stdout.write(JSON.stringify({ unique, workingSet, consumersPerCredential: workingSet ? 2 : null, burstLayout: workingSet ? spread ? 'interleaved-round-robin' : 'consecutive-pairs' : null,
  iterations, cryptoVerifyCalls: checks, proofHitRate: 1 - checks / iterations, currentKeyResolutions: resolutions, elapsedMs, cpuUserMicros: used.user, cpuSystemMicros: used.system,
  retainedHeapDelta: process.memoryUsage().heapUsed - before, gcAvailable: !!global.gc,
  instrumentSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
  scope: 'synthetic local Ed25519 verifier; fresh key resolution and claims; one worker; host not isolated; no DB/socket/capacity or heap improvement claim' }) + '\n');
