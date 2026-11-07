#!/usr/bin/env node
'use strict';

// Build a committed source identity, never arbitrary working files carrying a
// clean commit label. Git archive also excludes ignored runtime credentials.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const INPUTS = ['package.json', 'package-lock.json', '.babelrc', 'bundle', 'webpack', 'bin', 'lib', 'static', 'views', 'translations', 'migrations', 'scripts/diagnose-data.js', 'deploy/multitenant', 'server.js'];
function assertCleanSource (root, expected) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  if (!/^[a-f0-9]{40}$/.test(head) || expected && expected !== head) throw new Error('BUILD_SOURCE_COMMIT_CHANGED');
  try { execFileSync('git', ['diff', '--quiet', 'HEAD', '--', ...INPUTS], {cwd: root, stdio: 'pipe'}); }
  catch { throw new Error('BUILD_INPUTS_DIRTY'); }
  return head;
}
function build () {
  const source = assertCleanSource(ROOT);
  const config = JSON.parse(execFileSync('docker', ['compose', '--env-file', '.env', '-f', 'compose.yaml', 'config', '--format', 'json'], {cwd: __dirname, encoding: 'utf8'}));
  if (config.services.api.build.args.NS_SOURCE_COMMIT !== source) throw new Error('PREPARED_SOURCE_COMMIT_CHANGED');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-compose-build-'));
  try {
    const context = path.join(temporary, 'context'); fs.mkdirSync(context);
    const archive = path.join(temporary, 'source.tar');
    execFileSync('git', ['archive', '--format=tar', '--output', archive, source], {cwd: ROOT});
    execFileSync('tar', ['-xf', archive, '-C', context]);
    execFileSync('docker', ['build', '--pull=false', '--build-arg', 'NS_SOURCE_COMMIT=' + source,
      '--label', 'org.opencontainers.image.revision=' + source, '-t', config.services.api.image,
      '-f', 'deploy/multitenant/Dockerfile', '.'], {cwd: context, stdio: 'inherit', timeout: 1200000});
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
}
if (require.main === module) {
  try { build(); } catch (error) {
    process.stderr.write((/^[A-Z_]+$/.test(error.message) ? error.message : 'COMPOSE_IMAGE_BUILD_FAILED') + '\n');
    process.exitCode = 1;
  }
}
module.exports = {assertCleanSource};
