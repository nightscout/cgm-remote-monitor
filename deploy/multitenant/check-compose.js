#!/usr/bin/env node
'use strict';

// Source-only deployment boundary check. `compose config` does not contact the
// daemon or create a service. Never print its expanded environment or secrets.
const {execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
function check (config) {
  const runtime = ['api', 'realtime', 'evaluator', 'tenant-admin', 'ui', 'nginx'];
  for (const name of runtime) {
    const service = config.services[name];
    assert(service, 'Missing service: ' + name);
    for (const volume of service.volumes || []) {
      assert(!/\/(bootstrap|ops|tls)\/?$/.test(volume.source), name + ' mounts a privileged directory');
      if (volume.target === '/run/ns-config') {
        assert(volume.source.endsWith('/' + name) && volume.read_only, name + ' must mount only its own read-only config');
      }
      assert(!['/var/run/docker.sock', '/run/docker.sock', '/state'].includes(volume.target), name + ' mounts a privileged endpoint');
    }
    assert(!service.privileged && service.network_mode !== 'host', name + ' changes the isolation boundary');
    if (name !== 'nginx') assert(!(service.ports || []).length, name + ' publishes a private listener');
  }
  for (const name of ['ui', 'nginx']) {
    const service = config.services[name];
    assert(!(service.volumes || []).some(v => v.target === '/run/ns-ipc'), name + ' must not mount private IPC');
    assert(!Object.keys(service.environment || {}).some(k => /TOKEN|PASSWORD|PG|DATABASE/.test(k)), name + ' receives private credentials');
  }
  assert(config.networks.backend.internal === true, 'Backend network must be internal');
  assert(config.services.bootstrap.profiles.includes('ops'), 'Bootstrap must remain explicit');
  assert(config.services.demo.profiles.includes('ops'), 'Restore demonstration must remain explicit');
  const ports = config.services.nginx.ports;
  assert(ports.length === 1 && ['127.0.0.1', '169.254.1.1'].includes(ports[0].host_ip), 'Demo ingress must bind the selected local address');
  return true;
}
if (require.main === module) {
  try {
    const bytes = execFileSync('docker', ['compose', '--profile', '*', '-f', 'compose.yaml', 'config', '--format', 'json'], {
      cwd: __dirname, encoding: 'utf8', env: {...process.env,
        NS_DEMO_STATE: process.env.NS_DEMO_STATE || '/tmp/ns-compose-source-check',
        NS_SOURCE_COMMIT: process.env.NS_SOURCE_COMMIT || '0'.repeat(40)}
    });
    const config = JSON.parse(bytes); check(config);
    const broken = structuredClone(config);
    broken.services.ui.volumes.push({type: 'bind', source: '/tmp/state/ops', target: '/state'});
    assert.throws(() => check(broken), /privileged directory/, 'Credential-exposure control must fail');
    const exposed = structuredClone(config);
    exposed.services['tenant-admin'].ports = [{target: 1341, published: '1341', host_ip: '0.0.0.0'}];
    assert.throws(() => check(exposed), /publishes a private listener/, 'Management-exposure control must fail');
    check(config);
    process.stdout.write('Compose boundaries pass; credential and private-listener controls rejected; restored configuration passes. Runtime UNMEASURED.\n');
  } catch (error) {
    // Authored assertion messages name only a service/property, never values.
    process.stderr.write('Compose boundary check failed: ' + (error.code === 'ERR_ASSERTION' ? error.message : error.code || 'configuration expansion') + '\n'); process.exitCode = 1;
  }
}
module.exports = {check};
