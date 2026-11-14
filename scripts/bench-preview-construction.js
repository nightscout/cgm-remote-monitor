'use strict';
// Bounded construction/dispatch microbenchmark, recording protocol only.
// Run each source in a fresh process with --expose-gc --max-old-space-size=256.
// Optional source file replaces preview-domains ONLY; dependencies stay local.
const fs = require('node:fs');
const scope = require('../lib/storage/tenant-scope');
const { fixture } = require('../tests/fixtures/preview-domain-allocation');
const [configuredArg = '1000', touchedArg = configuredArg, selectedArg = '0', sourceFile] = process.argv.slice(2);
const configured = Number(configuredArg), touched = Number(touchedArg), selected = Number(selectedArg);
if (!global.gc || ![configured, touched, selected].every(Number.isSafeInteger) ||
    selected < 0 || selected > touched || touched > configured || configured < 1 || configured > 10000) {
  throw new Error('Use --expose-gc: configured(1..10000) touched(0..configured) selectedV3(0..touched) [sourceFile]');
}
const source = sourceFile ? fs.readFileSync(sourceFile, 'utf8') : undefined;
function memory () {
  global.gc(); global.gc();
  const m = process.memoryUsage();
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  return { heapUsed: m.heapUsed, rss: m.rss, external: m.external,
    anonymousBytes: Number(/^RssAnon:\s+(\d+)/m.exec(status)?.[1] || 0) * 1024 };
}
async function phase (fn) {
  const cpu = process.cpuUsage(), start = process.hrtime.bigint();
  await fn();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  return { elapsedMs, cpuMicros: process.cpuUsage(cpu), memory: memory() };
}
async function main () {
  scope.setTenancyMode('multi');
  const oldLog = console.log, oldInfo = console.info; console.log = console.info = () => {};
  let result;
  try {
    // Warm module/JIT imports on one discarded synthetic tenant before baseline.
    let prime = await fixture({ configured: 1, source });
    await prime.graph.initializeTenant(prime.tenants[0]); await prime.select(prime.tenants[0]); prime = null;
    const before = memory(); let f;
    const configuration = await phase(async () => { f = await fixture({ configured, source }); });
    const construction = await phase(async () => {
      for (const tenant of f.tenants.slice(0, touched)) await f.graph.initializeTenant(tenant);
    });
    const countsAfterWarm = { ...f.counts };
    const selection = await phase(async () => { for (const tenant of f.tenants.slice(0, selected)) await f.select(tenant); });
    const warmDispatch = await phase(async () => {
      for (let i = 0; i < selected * 10; i++) await f.select(f.tenants[i % selected]);
    });
    result = { scope: 'recording-protocol-construction-and-TRACE-dispatch; no HTTP/auth/database throughput claim',
      node: process.version, configured, touched, selectedV3: selected, concurrency: 1, before,
      configuration, construction, countsAfterWarm, selection, warmDispatch, finalCounts: { ...f.counts },
      recordedSqlSubmissions: f.queries.length, recordedSqlStatements: f.queries.length,
      nativeSqlStatements: 'UNMEASURED', requestsWithClinicalOrAuthorityWork: 0 };
  } finally { console.log = oldLog; console.info = oldInfo; }
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
