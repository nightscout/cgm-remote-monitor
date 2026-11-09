'use strict';
// Runs ONE matrix stage in its own process. run.cjs spawns this with the
// selected environment and enforces the wall-clock deadline from outside.
//   node stage.cjs <stageId> <configPath> <resultPath>
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const contract = require('./stage-contract.cjs');
const probeChecks = require('./probe-checks.json');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const [stageId, configPath, resultPath] = process.argv.slice(2);

function nativeFamilies (stage, value) {
  if (!value || value.cleanup !== 'closed' || value.persistence !== stage.persistence || value.signing !== contract.SIGNING ||
      !Array.isArray(value.checks) || JSON.stringify(value.checks.map(check => check.name)) !== JSON.stringify(probeChecks[stage.persistence]) ||
      value.checks.some(check => check.pass !== true)) fail('OWNER_MATRIX_NATIVE_PROBE_INCOMPLETE');
  return { [stage.id === 'mongo-sessions' ? 'mongoNativeSessions' : 'postgresNativeSessions']: true };
}

// Public summary of a stage value: check names, cleanup strings, counts. No
// tokens, URLs, connection strings or raw clinical rows are copied.
function summarize (value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  if (Array.isArray(value.checks)) out.checks = value.checks.map(check => ({ name: check.name, pass: check.pass }));
  if (Array.isArray(value.cleanup)) out.cleanup = value.cleanup.map(item => item instanceof Error ? 'ERROR:' + item.message : item);
  if (typeof value.cleanup === 'string') out.cleanup = value.cleanup;
  for (const key of ['verdict', 'mode', 'tenant', 'kind', 'stage', 'persistence', 'accessSigning', 'assertions', 'browser', 'resources'])
    if (value[key] !== undefined) out[key] = value[key];
  if (value.owner) out.owner = value.owner; if (value.ownerBrowser) out.ownerBrowser = value.ownerBrowser;
  return out;
}

async function main () {
  const started = Date.now();
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const req = createRequire(path.join(config.sourceRoot, 'package.json'));
  contract.admit(config.execution, process.env);
  const definition = config.execution.stages.find(stage => stage.id === stageId);
  if (!definition) fail('OWNER_MATRIX_UNKNOWN_STAGE');
  const stage = { ...definition, activeEndsAt: Date.now() + definition.activeMs };
  stage.cleanupEndsAt = stage.activeEndsAt + stage.cleanupMs;
  const tenant = stage.mode === 'single' ? 'single' : config.tenants[0];
  let value, families;
  if (stage.persistence === 'vault') {
    // Bounded consumer: a separate process holding only the sign-only config
    // (never the admin token) issues and verifies through the owned Transit key.
    const consume = async ({ accessSource, tenant: boundTenant, mode }) => {
      const { spawn } = require('node:child_process');
      const env = { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS, ...accessSource };
      const child = spawn(process.execPath, [path.join(__dirname, 'vault-consumer.cjs'), config.sourceRoot, boundTenant, mode], { env, cwd: config.sourceRoot, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      const exit = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
      clearTimeout(timer);
      if (exit.code !== 0) throw new Error('vault consumer child failed: ' + (err.trim() || JSON.stringify(exit)));
      const report = JSON.parse(out.trim().split('\n').pop());
      if (report.issued !== 2 || report.verified !== 2) throw new Error('vault consumer child incomplete');
      process.stdout.write(JSON.stringify({ event: 'owned-consumer-child', ...report }) + '\n');
    };
    value = await req('./tests/human-access-vault-native').run({ nativeStage: stage, consume });
    if (value.verdict !== 'pass' || value.mode !== stage.mode || JSON.stringify(value.checks.map(check => check.name)) !== JSON.stringify(probeChecks.vault) ||
        value.checks.some(check => check.pass !== true) || value.cleanup.some(item => typeof item !== 'string')) fail('OWNER_MATRIX_VAULT_INCOMPLETE');
    families = { [stage.id === 'vault-single' ? 'vaultSingle' : 'vaultMulti']: true };
  } else {
    await require('./transit-profile.cjs').prove({ req, env: process.env, mode: stage.mode, tenant, file: process.env.HUMAN_SESSION_SIGNER_CONFIG });
    if (stage.id.endsWith('-sessions')) {
      value = await req('./tests/human-session-' + (stage.persistence === 'mongo' ? 'mongo' : 'postgres') + '-native').run({ nativeStage: stage });
      families = nativeFamilies(stage, value);
    } else {
      value = await req('./tests/human-session-http-native').run({ nativeStage: stage,
        ...(stage.id === 'mongo-http'
          ? { createSingleExtension: require('./single-compatibility.cjs').makeFactory({ config, env: process.env }) }
          : { createOwnerExtension: require('./owner-extension.cjs').makeFactory({ config, env: process.env }) }) });
      if (value.stage !== stage.id || value.persistence !== stage.persistence || value.accessSigning !== contract.SIGNING || value.verdict !== 'pass') fail('OWNER_MATRIX_HTTP_INCOMPLETE');
      families = { ...value.owner?.families, ...value.ownerBrowser?.families };
      if (stage.id === 'mongo-http') {
        if (value.browser !== 'actual-chromium-cookie-and-bearer-https') fail('OWNER_MATRIX_SINGLE_BROWSER_INCOMPLETE');
        families.mongoSignedHttps = true; families.singleBrowserLifecycle = true;
      }
    }
  }
  if (Date.now() > stage.cleanupEndsAt) fail('OWNER_MATRIX_STAGE_DEADLINE');
  families = Object.fromEntries(contract.STAGES.find(item => item.id === stage.id).families.map(name => [name, families?.[name]]));
  const result = { stage: stage.id, persistence: stage.persistence, signing: contract.SIGNING, native: true, completed: true, families };
  contract.assertStage(stage, result);
  fs.writeFileSync(resultPath, JSON.stringify({ ...result, durationMs: Date.now() - started, detail: summarize(value) }, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ event: 'matrix-stage-complete', ...result }) + '\n');
}

main().then(() => { process.exitCode = 0; }).catch(error => {
  const failures = error.errors || [error];
  process.stderr.write(JSON.stringify({ instrument: 'oidc-matrix-stage', stage: stageId, verdict: 'failed',
    error: error.code || error.name, message: error.message,
    failures: failures.map(item => ({ name: item.name, code: item.code, message: item.message })) }) + '\n');
  fs.writeFileSync(resultPath, JSON.stringify({ stage: stageId, completed: false, error: error.code || error.name, message: error.message,
    failures: failures.map(item => ({ name: item.name, code: item.code, message: item.message })) }, null, 2) + '\n');
  process.exitCode = 1;
}).finally(() => {
  // Stage modules close what they own; a lingering handle must not hide a verdict.
  setTimeout(() => process.exit(process.exitCode || 0), 500).unref();
});
