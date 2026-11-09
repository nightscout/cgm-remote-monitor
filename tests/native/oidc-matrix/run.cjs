'use strict';
// Harness driver (called by run.sh after the containers are healthy).
// Records the executed source commit, provisions the disposable services,
// runs the nine stages sequentially in child processes with the contract's
// per-stage deadlines, optionally runs authored mutant controls (red, then
// restored green), redacts every log and writes summary.json. No grant,
// reservation, lead identity, attestation hash or freshness window exists.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const contract = require('./stage-contract.cjs');
const template = require('./config-template.cjs');
const HERE = __dirname, ROOT = path.resolve(HERE, '../../..');
const HARNESS_REL = path.relative(ROOT, HERE) + '/';
const TENANTS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const PG_ROLES = { app: 'HUMAN_SESSION_PG_APP_URL', owner: 'OWNER_WRITE_PG', legacy: 'OWNER_READ_PG', settings: 'OWNER_SETTINGS_PG',
  secrets: 'OWNER_SECRETS_PG', reader: 'OWNER_DISPLAY_PG', clinical: 'OWNER_CLINICAL_PG' };
const CONTROL_GROUPS = {
  single: { stage: 'mongo-http', pick (id) { const m = require('./single-compatibility-controls.cjs'); const c = m.controls.find(x => x.id === id); if (!c) return null;
    return { file: c.path, apply: src => m.applyToSource(src, c), expected: c.expected, family: c.family }; } },
  consumer: { stage: 'owner-consumer', pick (id) { const m = require('./consumer-journey-controls.cjs'); const c = m.controls.find(x => x.id === id); if (!c) return null;
    return { file: c.path, apply: src => m.applyToSource(src, c), expected: c.expected, family: c.family }; } },
  authority: { stage: 'owner-authority', pick (id) { const m = require('./authority-races-controls.cjs'); const c = m.mutations.find(x => x.name === id); if (!c) return null;
    return { file: c.file, apply: src => m.materialize(src, id).mutant, expected: c.oracle }; } },
  browser: { stage: 'owner-browser', pick (id) { const m = require('./owner-browser-journey-controls.cjs'); const d = m.native[id]; if (!d) return null;
    return { file: d.file, apply: src => m.materialize(d, src).source, expected: d.symptom }; } }
};
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
for (const key of ['out', 'state', 'project', 'pg-port', 'mongo-port', 'vault-port']) if (!args[key]) throw new Error('missing --' + key);
const OUT = path.resolve(args.out), STATE = path.resolve(args.state);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const q = value => '"' + value.replaceAll('"', '""') + '"';
const git = argv => execFileSync('git', ['-C', ROOT, ...argv], { encoding: 'utf8' }).trim();
const compose = argv => execFileSync('docker', ['compose', '-p', args.project, '-f', path.join(HERE, 'compose.yaml'), ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const secrets = new Set();
const secret = bytes => { const value = crypto.randomBytes(bytes).toString('hex'); secrets.add(value); return value; };
const commands = [];
const note = (text) => { const line = new Date().toISOString() + ' ' + text; commands.push(line); fs.appendFileSync(path.join(OUT, 'commands.log'), line + '\n'); process.stderr.write(line + '\n'); };

function redact (text) {
  let out = String(text);
  for (const value of secrets) if (value && value.length >= 8) out = out.split(value).join('[REDACTED]');
  return out.replace(/hvs\.[A-Za-z0-9_-]{20,}/g, '[REDACTED-VAULT-TOKEN]').replace(/hvb\.[A-Za-z0-9_-]{20,}/g, '[REDACTED-VAULT-TOKEN]')
    .replace(/(postgres(?:ql)?:\/\/)[^@\s"']+@/g, '$1[REDACTED]@').replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED-JWT]')
    .replace(/([?&](?:token|api-secret|api_secret|secret)=)[^&\s"']+/gi, '$1[REDACTED]').replace(/("(?:password|client_token|root_token|accessor|api-secret|authorization)"\s*:\s*")[^"]+"/gi, '$1[REDACTED]"');
}

async function vault (origin, token, endpoint, { method = 'GET', body } = {}) {
  const response = await fetch(origin + '/v1/' + endpoint, { method, redirect: 'manual', signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Vault-Token': token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  if (!response.ok) throw new Error('Vault ' + method + ' ' + endpoint + ' -> ' + response.status);
  return text ? JSON.parse(text) : {};
}

function serviceFacts () {
  const facts = {};
  for (const service of ['postgres', 'mongo', 'vault']) {
    const id = compose(['ps', '-q', service]).trim();
    const container = JSON.parse(execFileSync('docker', ['inspect', id], { encoding: 'utf8' }))[0];
    const image = JSON.parse(execFileSync('docker', ['image', 'inspect', container.Image], { encoding: 'utf8' }))[0];
    const version = service === 'postgres' ? compose(['exec', '-T', 'postgres', 'postgres', '--version']).trim()
      : service === 'mongo' ? compose(['exec', '-T', 'mongo', 'mongod', '--version']).split('\n')[0].trim()
        : compose(['exec', '-T', 'vault', 'vault', 'version']).trim();
    facts[service] = { container: id, imageId: container.Image, repoDigests: image.RepoDigests, version };
  }
  return facts;
}

async function main () {
  const startedAt = new Date().toISOString(), t0 = Date.now();
  fs.mkdirSync(path.join(OUT, 'stages'), { recursive: true });
  // 1. Source anchoring: the commit executed and a clean tree (apart from this harness directory while it is unstaged).
  const sourceCommit = git(['rev-parse', 'HEAD']), sourceBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const porcelain = git(['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean);
  const dirty = porcelain.filter(line => !line.slice(3).startsWith(HARNESS_REL));
  if (dirty.length) throw new Error('HARNESS_SOURCE_TREE_DIRTY: ' + dirty.join(' | '));
  note('source ' + sourceCommit + ' (' + sourceBranch + ') porcelain=' + porcelain.length + ' (all under ' + HARNESS_REL + ')');
  const req = createRequire(path.join(ROOT, 'package.json'));
  const oref0Root = path.resolve(ROOT, '../../oref0');
  const oref0Commit = execFileSync('git', ['-C', oref0Root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (oref0Commit !== template.OREF_COMMIT) throw new Error('OREF0_PIN_MISMATCH ' + oref0Commit);
  const services = serviceFacts();
  note('services ' + JSON.stringify(Object.fromEntries(Object.entries(services).map(([k, v]) => [k, v.version]))));
  // 2. Vault: init, unseal, Transit mount, nonexportable Ed25519 signers, owner AES keys, scoped tokens.
  const vaultOrigin = 'https://127.0.0.1:' + args['vault-port'];
  const init = await vault(vaultOrigin, null, 'sys/init', { method: 'POST', body: { secret_shares: 1, secret_threshold: 1 } });
  secrets.add(init.root_token); secrets.add(init.keys_base64[0]);
  const unsealed = await vault(vaultOrigin, null, 'sys/unseal', { method: 'POST', body: { key: init.keys_base64[0] } });
  if (unsealed.sealed) throw new Error('VAULT_UNSEAL_FAILED');
  const root = init.root_token;
  await vault(vaultOrigin, root, 'sys/mounts/transit', { method: 'POST', body: { type: 'transit' } });
  const signerKeys = {};
  for (const name of ['hs-single-data', 'hs-single-management', 'hs-multi-data', 'hs-multi-management']) {
    await vault(vaultOrigin, root, 'transit/keys/' + name, { method: 'POST', body: { type: 'ed25519', derived: false, exportable: false, allow_plaintext_backup: false } });
    const info = (await vault(vaultOrigin, root, 'transit/keys/' + name)).data;
    if (info.type !== 'ed25519' || info.exportable !== false || info.allow_plaintext_backup !== false) throw new Error('VAULT_KEY_PROFILE ' + name);
    signerKeys[name] = info.keys['1'].public_key;
  }
  for (const i of [0, 1]) for (const kind of ['encrypt', 'sign']) {
    await vault(vaultOrigin, root, 'transit/keys/owner-' + kind + '-' + i, { method: 'POST', body: { type: 'aes256-gcm96', exportable: false } });
  }
  const policy = async (name, rules) => vault(vaultOrigin, root, 'sys/policies/acl/' + name, { method: 'PUT', body: { policy: rules.join('\n') } });
  const token = async (name) => { const r = await vault(vaultOrigin, root, 'auth/token/create', { method: 'POST', body: { policies: [name], no_default_policy: true, ttl: '3h', renewable: false } }); secrets.add(r.auth.client_token); return r.auth.client_token; };
  await policy('oidc-matrix-sign', ['path "transit/sign/hs-*" { capabilities = ["update"] }']);
  const signToken = await token('oidc-matrix-sign');
  const ownerTokens = [];
  for (const i of [0, 1]) {
    await policy('oidc-matrix-owner-' + i, [...['encrypt', 'decrypt', 'rewrap'].map(op => `path "transit/${op}/owner-encrypt-${i}" { capabilities = ["update"] }`),
      ...['hmac', 'verify'].map(op => `path "transit/${op}/owner-sign-${i}" { capabilities = ["update"] }`)]);
    ownerTokens.push(await token('oidc-matrix-owner-' + i));
  }
  const signerConfig = (mode, tenant) => ({ version: 1, issuer: 'synthetic-native-human-access-' + mode,
    audiences: { data: 'synthetic-native-data-' + mode, management: 'synthetic-native-management-' + mode },
    vault: { addressEnv: 'HUMAN_VAULT_URL', tokenEnv: 'HUMAN_VAULT_SIGN_TOKEN', mount: 'transit' },
    keys: ['data', 'management'].map(purpose => ({ tenant, purpose, kid: mode + '-' + purpose, publicKey: signerKeys['hs-' + mode + '-' + purpose],
      current: true, signingKey: 'hs-' + mode + '-' + purpose, signingVersion: 1 })) });
  const signerFiles = {};
  for (const [mode, tenant] of [['single', 'single'], ['multi', TENANTS[0]]]) {
    signerFiles[mode] = path.join(STATE, 'signer-' + mode + '.json');
    fs.writeFileSync(signerFiles[mode], JSON.stringify(signerConfig(mode, tenant)), { mode: 0o600 });
  }
  // Headless owner management trust anchors (public keys only; no stage signs with them).
  const managementPublicKeys = TENANTS.map(() => Buffer.from(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'));
  note('vault provisioned: transit mount, 4 ed25519 signer keys, 4 aes256-gcm96 owner keys, 3 scoped tokens');
  // 3. PostgreSQL identities (admin = container superuser; seven NOSUPERUSER NOBYPASSRLS roles).
  const pgPassword = fs.readFileSync(path.join(STATE, 'pg-password'), 'utf8').trim(); secrets.add(pgPassword);
  const pgBase = (user, password, db) => { const url = new URL('postgres://127.0.0.1:' + args['pg-port'] + '/' + db); url.username = user; url.password = password; return url.toString(); };
  const { Client, Pool } = req('pg');
  const admin = new Client({ connectionString: pgBase('postgres', pgPassword, 'postgres'), connectionTimeoutMillis: 5000 });
  await admin.connect();
  const roles = {};
  for (const name of Object.keys(PG_ROLES)) {
    const password = secret(24);
    await admin.query('CREATE ROLE ' + q('om_' + name) + " LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '" + password + "'");
    roles[name] = { user: 'om_' + name, password };
  }
  const roleState = (await admin.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname LIKE 'om_%' ORDER BY rolname")).rows;
  note('postgres roles ' + JSON.stringify(roleState));
  // 4. Client tools and fixed inputs.
  const tools = Object.fromEntries(['bash', 'curl', 'jq', 'dirname', 'basename', 'cat'].map(name => {
    const file = path.join(STATE, 'tools', name); return [name, { path: file, sha256: sha256(fs.readFileSync(file)) }]; }));
  const fixed = {
    HUMAN_SESSION_NATIVE_RESERVED: '1', HUMAN_HTTPS_RESERVED: '1', HUMAN_VAULT_RESERVED: '1',
    HUMAN_VAULT_URL: vaultOrigin, HUMAN_VAULT_ADMIN_TOKEN: root, HUMAN_VAULT_SIGN_TOKEN: signToken,
    OWNER_TOKEN_A: ownerTokens[0], OWNER_TOKEN_B: ownerTokens[1],
    OWNER_SINGLE_SIGNER_CONFIG: signerFiles.single, OWNER_MULTI_SIGNER_CONFIG: signerFiles.multi,
    HUMAN_HTTPS_KEY: path.join(STATE, 'tls/fixture.key'), HUMAN_HTTPS_CERT: path.join(STATE, 'tls/fixture.crt'),
    HUMAN_BROWSER_EXECUTABLE: '/usr/bin/google-chrome',
    OWNER_PRIVATE_OPERATOR_TOKEN: secret(24), OWNER_SINGLE_API_SECRET: secret(24), OWNER_SINGLE_JWT_KEY: secret(24)
  };
  const { MongoClient } = req('mongodb');
  const mongoAdmin = new MongoClient('mongodb://127.0.0.1:' + args['mongo-port'] + '/admin?directConnection=true', { serverSelectionTimeoutMS: 5000 });
  await mongoAdmin.connect();
  const mongoBuild = await mongoAdmin.db('admin').command({ buildInfo: 1 });
  services.mongo.serverVersion = mongoBuild.version;
  services.postgres.serverVersion = (await admin.query('SHOW server_version')).rows[0].server_version;
  services.vault.serverVersion = (await vault(vaultOrigin, root, 'sys/health')).version;
  const baselineMounts = new Set(Object.keys((await vault(vaultOrigin, root, 'sys/mounts')).data));
  note('vault baseline mounts ' + JSON.stringify([...baselineMounts].sort()));

  // 5. One attempt = one stage on one source root with a fresh nonce/database; leftovers are measured afterwards.
  let attemptIndex = 0;
  async function attempt ({ stageId, sourceRoot, label }) {
    const n = ++attemptIndex, nonce = crypto.randomBytes(8).toString('hex'), db = 'owner_oidc_' + nonce;
    const name = String(n).padStart(2, '0') + '-' + label;
    await admin.query('CREATE DATABASE ' + q(db));
    const env = { ...fixed,
      HUMAN_SESSION_PG_ADMIN_URL: pgBase('postgres', pgPassword, db),
      HUMAN_SESSION_MONGO_URL: 'mongodb://127.0.0.1:' + args['mongo-port'] + '/' + db + '?directConnection=true', HUMAN_SESSION_MONGO_DB: db };
    for (const [role, variable] of Object.entries(PG_ROLES)) env[variable] = pgBase(roles[role].user, roles[role].password, db);
    const config = template({ nonce, tenants: TENANTS, publicKeys: managementPublicKeys, sourceRoot, sourceCommit, vaultAddress: vaultOrigin, oref0Root, tools });
    const configPath = path.join(STATE, 'config-' + name + '.json');
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const definition = config.execution.stages.find(stage => stage.id === stageId);
    const selected = { HUMAN_SESSION_SIGNER_CONFIG: env[definition.signerConfigEnv] || signerFiles.multi, HUMAN_HTTP_SIGNER_CONFIG: env[definition.signerConfigEnv] || signerFiles.multi,
      HUMAN_HTTP_STORE: definition.persistence, HUMAN_BROWSER_RESERVED: definition.browser ? '1' : '0', HUMAN_VAULT_TENANT: definition.mode === 'single' ? 'single' : TENANTS[0] };
    const childEnv = { ...process.env, ...env, ...selected };
    // Parent-side admission mirrors the retired driver's preflight minus grant/reservation/pin checks.
    require('node:tls').createSecureContext({ key: fs.readFileSync(env.HUMAN_HTTPS_KEY), cert: fs.readFileSync(env.HUMAN_HTTPS_CERT) });
    const sourceReq = createRequire(path.join(sourceRoot, 'package.json'));
    const planned = { ...env, HUMAN_HTTP_SIGNER_CONFIG: env.OWNER_MULTI_SIGNER_CONFIG };
    for (const mode of ['single', 'multi']) require('./transit-profile.cjs').admit({ req: sourceReq, env: planned, mode, tenant: mode === 'single' ? 'single' : TENANTS[0], file: env[mode === 'single' ? 'OWNER_SINGLE_SIGNER_CONFIG' : 'OWNER_MULTI_SIGNER_CONFIG'] });
    require('./owner-extension.cjs').makeFactory({ config, env: planned }).admit();
    require('./single-compatibility.cjs').makeFactory({ config, env: planned }).admit();
    const resultPath = path.join(STATE, 'result-' + name + '.json');
    const rawOut = path.join(STATE, name + '.stdout.log'), rawErr = path.join(STATE, name + '.stderr.log');
    const deadlineMs = definition.activeMs + definition.cleanupMs + 20000;
    const command = ['node', path.join(HERE, 'stage.cjs'), stageId, configPath, resultPath];
    note('attempt ' + name + ' stage=' + stageId + ' nonce=' + nonce + ' sourceRoot=' + sourceRoot + ' deadlineMs=' + deadlineMs + ' + ' + command.join(' '));
    const started = Date.now();
    const exit = await new Promise(resolve => {
      const child = spawn(command[0], command.slice(1), { env: childEnv, cwd: sourceRoot, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(fs.createWriteStream(rawOut)); child.stderr.pipe(fs.createWriteStream(rawErr));
      let killed = false;
      const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, deadlineMs);
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, killed }); });
    });
    const durationMs = Date.now() - started;
    let result = null;
    try { result = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch { result = null; }
    for (const [raw, kind] of [[rawOut, 'stdout'], [rawErr, 'stderr']]) {
      fs.writeFileSync(path.join(OUT, 'stages', name + '.' + kind + '.log'), redact(fs.readFileSync(raw, 'utf8'))); fs.rmSync(raw);
    }
    // Leftover measurement: owned schemas, collections and Vault mounts must be gone.
    const leftovers = {};
    const dbAdmin = new Pool({ connectionString: env.HUMAN_SESSION_PG_ADMIN_URL, max: 1, connectionTimeoutMillis: 5000 });
    try {
      leftovers.pgSchemas = (await dbAdmin.query("SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','public','pg_toast') AND nspname NOT LIKE 'pg_temp%' AND nspname NOT LIKE 'pg_toast_temp%' ORDER BY nspname")).rows.map(row => row.nspname);
      leftovers.pgBackends = Number((await dbAdmin.query('SELECT count(*) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [db])).rows[0].count);
    } finally { await dbAdmin.end(); }
    leftovers.mongoCollections = (await mongoAdmin.db(db).listCollections({}, { nameOnly: true }).toArray()).map(item => item.name);
    leftovers.vaultMounts = Object.keys((await vault(vaultOrigin, root, 'sys/mounts')).data).filter(name => !baselineMounts.has(name));
    await admin.query('DROP DATABASE ' + q(db) + ' WITH (FORCE)');
    await mongoAdmin.db(db).dropDatabase();
    const clean = leftovers.pgSchemas.length === 0 && leftovers.mongoCollections.length === 0 && leftovers.vaultMounts.length === 0;
    const verdict = exit.code === 0 && !exit.killed && result?.completed === true && clean ? 'PASS' : 'FAIL';
    const record = { attempt: name, id: stageId, verdict, durationMs, exit, families: result?.families || null,
      error: result?.completed ? null : (exit.killed ? 'HARNESS_STAGE_DEADLINE' : result?.error || 'NO_RESULT'),
      message: result?.completed ? null : result?.message || null, failures: result?.failures || undefined,
      detail: result?.detail, leftovers, logs: ['stages/' + name + '.stdout.log', 'stages/' + name + '.stderr.log'] };
    note('attempt ' + name + ' ' + verdict + ' in ' + durationMs + 'ms' + (record.error ? ' error=' + record.error + ' ' + (record.message || '') : '') + ' leftovers=' + JSON.stringify(leftovers));
    return record;
  }

  const summary = { version: 1, harness: HARNESS_REL, startedAt, sourceCommit, sourceBranch, sourceRoot: ROOT,
    porcelain: porcelain.map(redact), oref0Commit, node: process.version, browser: execFileSync(fixed.HUMAN_BROWSER_EXECUTABLE, ['--version'], { encoding: 'utf8' }).trim(),
    composeProject: args.project, images: services, ports: { postgres: Number(args['pg-port']), mongo: Number(args['mongo-port']), vault: Number(args['vault-port']) },
    postgresRoles: roleState, tools: Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, v.sha256])), tenants: TENANTS,
    stages: [], controls: [] };
  try {
    if (args.control) {
      for (const spec of args.control.split(',')) {
        const [group, id] = spec.split(':');
        const picked = CONTROL_GROUPS[group]?.pick(id);
        if (!picked) throw new Error('UNKNOWN_CONTROL ' + spec);
        const mutantRoot = path.join(STATE, 'mutant-' + group + '-' + id);
        fs.mkdirSync(mutantRoot);
        const tar = path.join(STATE, 'source.tar');
        if (!fs.existsSync(tar)) { fs.writeFileSync(tar, execFileSync('git', ['-C', ROOT, 'archive', '--format=tar', 'HEAD'], { maxBuffer: 1024 * 1024 * 512 })); }
        execFileSync('tar', ['-xf', tar, '-C', mutantRoot]);
        fs.symlinkSync(fs.realpathSync(path.join(ROOT, 'node_modules')), path.join(mutantRoot, 'node_modules'));
        const target = path.join(mutantRoot, picked.file), original = fs.readFileSync(target, 'utf8'), mutant = picked.apply(original);
        fs.writeFileSync(target, mutant);
        note('control ' + spec + ': mutated ' + picked.file + ' original=' + sha256(original) + ' mutant=' + sha256(mutant));
        const red = await attempt({ stageId: CONTROL_GROUPS[group].stage, sourceRoot: mutantRoot, label: 'control-' + group + '-' + id + '-red' });
        const restored = await attempt({ stageId: CONTROL_GROUPS[group].stage, sourceRoot: ROOT, label: 'control-' + group + '-' + id + '-restored' });
        summary.controls.push({ id, group, stage: CONTROL_GROUPS[group].stage, file: picked.file, originalSha256: sha256(original), mutantSha256: sha256(mutant),
          expected: picked.expected, red, restored, ok: red.verdict === 'FAIL' && restored.verdict === 'PASS' });
        fs.rmSync(mutantRoot, { recursive: true, force: true });
      }
    } else {
      const only = args.only ? args.only.split(',') : null;
      for (const stage of contract.STAGES) {
        if (only && !only.includes(stage.id)) continue;
        const record = await attempt({ stageId: stage.id, sourceRoot: ROOT, label: stage.id });
        summary.stages.push(record);
        if (record.verdict !== 'PASS') { note('first failure stops the matrix'); break; }
      }
      summary.complete = !only && summary.stages.length === contract.STAGES.length && summary.stages.every(stage => stage.verdict === 'PASS');
    }
  } finally {
    await admin.end().catch(() => {}); await mongoAdmin.close().catch(() => {});
    summary.finishedAt = new Date().toISOString(); summary.durationMs = Date.now() - t0;
    const file = path.join(OUT, args.control ? 'controls.json' : args.only ? 'partial.json' : 'summary.json');
    fs.writeFileSync(file, redact(JSON.stringify(summary, null, 2)) + '\n');
    // run.sh redacts the captured service logs with the same secret set after the containers stop.
    fs.writeFileSync(path.join(STATE, 'redact.json'), JSON.stringify([...secrets]), { mode: 0o600 });
    note('wrote ' + file);
  }
  const ok = args.control ? summary.controls.length > 0 && summary.controls.every(control => control.ok) : summary.stages.length > 0 && summary.stages.every(stage => stage.verdict === 'PASS');
  process.exitCode = ok ? 0 : 1;
}
main().catch(error => { note('HARNESS FAILED ' + redact(error.stack || error.message)); process.exitCode = 1; });
