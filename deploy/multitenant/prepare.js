#!/usr/bin/env node
'use strict';

// Local preparation only: no Docker calls, network changes or database access.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const base = __dirname;
function prepare (args) {
  const options = {bind: '127.0.0.1', port: '18080', state: path.join(base, '.state')};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2);
    if (!['--bind', '--port', '--state'].includes(args[i]) || !args[i + 1]) throw new Error('Invalid preparation arguments');
    options[key] = args[i + 1];
  }
  if (!['127.0.0.1', '169.254.1.1'].includes(options.bind) ||
      !Object.values(os.networkInterfaces()).flat().some(row => row.address === options.bind)) {
    throw new Error('Bind address must already exist: 127.0.0.1 or 169.254.1.1');
  }
  if (!/^[0-9]+$/.test(options.port) || Number(options.port) < 1024 || Number(options.port) > 65535) throw new Error('Invalid unprivileged port');
  const state = path.resolve(options.state);
  if (!/^\/[A-Za-z0-9_./-]+$/.test(state) || state.split('/').includes('..')) throw new Error('State path must be absolute without spaces or shell syntax');
  let ancestor = path.dirname(state);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (fs.realpathSync(ancestor) !== ancestor) throw new Error('State path must not traverse symlink ancestors');
  const sourceRoot = path.resolve(base, '../..');
  if (state.startsWith(sourceRoot + '/') && state !== path.join(base, '.state')) throw new Error('Custom state must be outside the source/build context');
  if (fs.existsSync(state) || fs.existsSync(path.join(base, '.env'))) throw new Error('State or deployment .env already exists; reuse it or choose a clean deployment checkout');
  const source = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: path.join(base, '../..'), encoding: 'utf8'}).trim();
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error('Source commit unavailable');
  fs.mkdirSync(state, {mode: 0o700});
  const write = (file, value) => fs.writeFileSync(file, value, {mode: 0o600, flag: 'wx'});
  for (const name of ['bootstrap', 'tls', 'vault', 'ipc', 'artifacts', 'api', 'realtime', 'evaluator', 'tenant-admin', 'ui', 'ops']) {
    fs.mkdirSync(path.join(state, name), {mode: 0o700});
  }
  write(path.join(state, 'bootstrap/postgres-password'), crypto.randomBytes(32).toString('hex') + '\n');
  const tls = path.join(state, 'tls');
  const openssl = args => execFileSync('openssl', args, {cwd: tls, stdio: ['ignore', 'ignore', 'pipe']});
  openssl(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '30', '-subj', '/CN=Nightscout synthetic Compose CA']);
  openssl(['req', '-newkey', 'rsa:3072', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=vault']);
  write(path.join(tls, 'server.ext'), 'subjectAltName=DNS:vault\nextendedKeyUsage=serverAuth\n');
  openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '30', '-extfile', 'server.ext']);
  for (const name of fs.readdirSync(tls)) fs.chmodSync(path.join(tls, name), name.endsWith('.crt') ? 0o644 : 0o600);
  // The Vault image drops to its own service uid. Only the server key is mounted
  // separately by Compose; CA signing material stays in bootstrap custody.
  fs.chmodSync(path.join(tls, 'server.key'), 0o644);
  write(path.join(state, 'vault/demo.hcl'), 'disable_mlock = true\nui = false\napi_addr = "https://vault:8200"\nstorage "file" { path = "/vault/file" }\nlistener "tcp" {\n  address = "0.0.0.0:8200"\n  tls_cert_file = "/run/ns-tls/server.crt"\n  tls_key_file = "/run/ns-tls/server.key"\n}\n');
  fs.chmodSync(path.join(state, 'vault/demo.hcl'), 0o644);
  write(path.join(base, '.env'), 'NS_DEMO_STATE=' + state + '\nNS_DEMO_BIND=' + options.bind + '\nNS_DEMO_PORT=' + options.port + '\nNS_SOURCE_COMMIT=' + source + '\n');
  process.stdout.write('Prepared private synthetic deployment state. Run the explicit bootstrap before starting roles.\n');
  return {state, source};
}
if (require.main === module) {
  try { prepare(process.argv.slice(2)); } catch (error) {
    process.stderr.write('Preparation refused: ' + (error.status ? 'local TLS generation failed' : error.message) + '\n');
    process.exitCode = 1;
  }
}
module.exports = {prepare};
