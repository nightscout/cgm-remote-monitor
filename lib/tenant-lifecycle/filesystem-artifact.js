'use strict';

// Same private POSIX durability boundary as deployment artifacts, preserving the
// complete R69 tenant artifact (including key-reference metadata) in its format.
const fs = require('node:fs');
const path = require('node:path');
const artifacts = require('./artifact');
const { privateDirectory, syncDirectory, readFile } = require('../tenant-operations/filesystem');
const { refuse } = artifacts;
const DIGEST = /^[a-f0-9]{64}$/;
const nameOf = digest => 'tenant-artifact-' + digest;

async function loadTenantArtifact ({ directory, digest, io = fs.promises } = {}) {
  if (typeof digest !== 'string' || !DIGEST.test(digest)) throw refuse('LIFECYCLE_ARTIFACT_DIGEST');
  await privateDirectory(io, directory);
  const location = path.join(directory, nameOf(digest));
  await privateDirectory(io, location);
  const artifact = JSON.parse(await readFile(io, path.join(location, 'artifact.json')));
  artifacts.validateArtifact(artifact);
  if (artifact.digest !== digest) throw refuse('LIFECYCLE_ARTIFACT_DIGEST');
  return artifact;
}

async function saveTenantArtifact (artifact, { directory, io = fs.promises } = {}) {
  artifacts.validateArtifact(artifact);
  await privateDirectory(io, directory, true);
  const destination = path.join(directory, nameOf(artifact.digest));
  try { await io.lstat(destination); throw refuse('LIFECYCLE_ARTIFACT_EXISTS'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let staging = await io.mkdtemp(path.join(directory, '.tenant-partial-'));
  try {
    const handle = await io.open(path.join(staging, 'artifact.json'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(artifact) + '\n', 'utf8'); await handle.sync(); } finally { await handle.close(); }
    const staged = JSON.parse(await readFile(io, path.join(staging, 'artifact.json')));
    artifacts.validateArtifact(staged);
    if (staged.digest !== artifact.digest) throw refuse('LIFECYCLE_ARTIFACT_DIGEST');
    await syncDirectory(io, staging);
    await io.rename(staging, destination);
    staging = null;
    await syncDirectory(io, directory);
    return await loadTenantArtifact({ directory, digest: artifact.digest, io });
  } catch (cause) {
    const error = refuse('LIFECYCLE_ARTIFACT_DURABILITY_FAILED');
    error.cause = cause;
    throw error;
  } finally {
    if (staging) await io.rm(staging, { recursive: true, force: true });
  }
}

function createFilesystemArtifactVerifier ({ directory, io = fs.promises } = {}) {
  return async ({ tenant, artifact }) => {
    const loaded = await loadTenantArtifact({ directory, digest: artifact.digest, io });
    if (loaded.manifest.tenant !== tenant || artifact.manifest.tenant !== tenant) throw refuse('LIFECYCLE_TENANT_MISMATCH');
    return { tenant, digest: loaded.digest, verified: true };
  };
}
module.exports = { saveTenantArtifact, loadTenantArtifact, createFilesystemArtifactVerifier };
