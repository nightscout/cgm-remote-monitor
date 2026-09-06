'use strict';
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const run = promisify(execFile);

describe('Connect MiniMed HTTPS transport', function () {
  this.timeout(40000);
  it('validates certificates, SSO cookies, refresh, session reuse and teardown', async function () {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'owned-minimed-tls-'));
    try {
      for (const name of ['trusted', 'untrusted']) {
        await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
          '-keyout', path.join(directory, name + '.key'), '-out', path.join(directory, name + '.pem'),
          '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], {timeout: 10000});
      }
      const env = {...process.env, OWNED_MINIMED_CERT_DIR: directory, NODE_EXTRA_CA_CERTS: path.join(directory, 'trusted.pem')};
      delete env.NODE_TLS_REJECT_UNAUTHORIZED;
      // Cookie-jar support owns its HTTPS agent. Load the owned CA at process
      // startup instead of disabling validation or overriding that agent.
      await run(process.execPath, ['--test', path.join(__dirname, 'fixtures/connect-minimed-transport.js')],
        {env, timeout: 25000, maxBuffer: 1024 * 1024});
    } finally { await fs.rm(directory, {recursive: true, force: true}); }
  });
});
