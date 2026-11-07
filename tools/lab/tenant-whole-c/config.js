'use strict';
/* eslint-disable security/detect-non-literal-fs-filename -- Explicit private parent configs/immutable source archive metadata. */
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const OLD = 'a7f5cbf71ab9016855976fae74730727d0a78024';
function parse (value, env = process.env, sourceRoot = path.resolve(__dirname, '../../..')) {
  const keys = ['version','sourceHead','oldHead','oldRoot','captureDirectory','prefix','adminEnv','expectedEndpoint','grant','acl','outageContract','parentResource','actualRoleManifestPath','actualRoleManifestSha256'];
  assert.ok(Object.keys(value).every(key => keys.includes(key) || ['controlName','guardCandidatePath','allocatorResearch'].includes(key)));
  assert.equal(value.version, 1);
  assert.match(value.sourceHead, /^[a-f0-9]{40}$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(sourceRoot, 'whole-c-source.json'), 'utf8')).head, value.sourceHead);
  assert.equal(value.oldHead, OLD);
  assert.ok(path.isAbsolute(value.oldRoot));
  assert.equal(JSON.parse(fs.readFileSync(path.join(value.oldRoot, 'whole-c-source.json'), 'utf8')).head, OLD);
  assert.ok(path.isAbsolute(value.captureDirectory));
  const directory = fs.lstatSync(value.captureDirectory);
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === process.getuid() && (directory.mode & 0o777) === 0o700);
  assert.match(value.prefix, /^wc_[a-f0-9]{12}$/);
  assert.match(value.adminEnv, /^[A-Z][A-Z0-9_]{1,127}$/);
  const url = new URL(env[value.adminEnv]);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === '127.0.0.1' && url.username && url.password);
  assert.deepEqual({ host: url.hostname, port: Number(url.port), database: decodeURIComponent(url.pathname.slice(1)) }, value.expectedEndpoint);
  assert.match(value.expectedEndpoint.database, /test/i);
  assert.ok(Number.isSafeInteger(value.expectedEndpoint.port) && value.expectedEndpoint.port > 0 && value.expectedEndpoint.port <= 65535 && !url.search && !url.hash);
  assert.ok(typeof value.grant === 'string' && value.grant.length > 0);
  assert.equal(value.outageContract.status, 'approved-by-root');
  assert.ok(value.outageContract.reference);
  assert.ok(value.parentResource.containerId && value.parentResource.image && value.parentResource.owner && value.parentResource.database === value.expectedEndpoint.database);
  assert.ok(Array.isArray(value.acl) && value.acl.length > 0);
  const kinds = require('../../../lib/tenant-lifecycle').admittedCatalogue().map(entry => entry.kind).concat(['lifecycle','alarm_suppression','notification_outbox','evaluator_checkpoint']);
  assert.ok(value.acl.every(grant => kinds.includes(grant.kind)), 'WHOLE_C_UNMAPPED_ACL_KIND');
  const classes = [...new Set(value.acl.map(grant => grant.role))];
  assert.deepEqual(classes.slice().sort(), ['api', 'readiness', 'alarm', 'realtime', 'evaluator', 'suppression', 'outbox'].sort(), 'WHOLE_C_EXACT_ROLE_CLASSES');
  assert.ok(classes.every(name => /^[a-z][a-z0-9_]{0,24}$/.test(name)));
  assert.ok(!classes.includes('lifecycle_operator') && !classes.includes('lifecycle_owner'));
  assert.ok(value.actualRoleManifestSha256 && /^[a-f0-9]{64}$/.test(value.actualRoleManifestSha256));
  assert.equal(path.dirname(value.actualRoleManifestPath), value.captureDirectory);
  const roleManifest = fs.readFileSync(value.actualRoleManifestPath);
  assert.equal(crypto.createHash('sha256').update(roleManifest).digest('hex'), value.actualRoleManifestSha256);
  assert.deepEqual(JSON.parse(roleManifest).grants, value.acl);
  if (value.guardCandidatePath) {
    assert.equal(value.controlName, 'profile-populated-guard');
    assert.equal(value.guardCandidatePath, path.join(value.captureDirectory, 'profile-guard-mutant.json'));
  }
  if (value.allocatorResearch !== undefined) assert.equal(value.allocatorResearch, 'private-cache-counterexample-v1');
  return { ...value, connectionString: url.toString(), classes: [...classes, 'lifecycle_operator', 'lifecycle_owner'] };
}
module.exports = { parse, OLD };
