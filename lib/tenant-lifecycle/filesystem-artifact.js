'use strict';

// Private files are published together after verification and fsync.
const fs = require('node:fs');
const path = require('node:path');
const artifacts = require('./artifact');
const copyTable = require('./copy-table');
const { createHash } = require('node:crypto');
const { refuse } = artifacts;

async function privateDirectory (io, directory, create = false) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw refuse('BACKUP_DIRECTORY_INVALID');
  if (create) {
    try {
      await io.mkdir(directory, { mode: 0o700 });
      await syncDirectory(io, path.dirname(directory));
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = await io.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
    throw refuse('BACKUP_DIRECTORY_NOT_PRIVATE');
  }
}

async function syncDirectory (io, directory) {
  const handle = await io.open(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function readFile (io, file) {
  const handle = await io.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw refuse('BACKUP_FILE_NOT_PRIVATE');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

const DIGEST = /^[a-f0-9]{64}$/;
const nameOf = digest => 'tenant-artifact-' + digest;

const identifier = /^[a-z][a-z0-9_]{0,62}$/;

function tableFiles (manifest) {
  return manifest.catalogues.flatMap(({ kind, tables }) => tables.map(entry => {
    if (typeof kind !== 'string' || typeof entry.table !== 'string' || !identifier.test(kind) || !identifier.test(entry.table)) throw refuse('LIFECYCLE_ARTIFACT_PATH_REFUSED');
    return { key: artifacts.tableKey(kind, entry.table), entry };
  }));
}

async function readArtifact (io, location, digest) {
  let manifest;
  try { manifest = JSON.parse(await readFile(io, path.join(location, 'manifest.json'))); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A retained deletion or key-destruction request can still name a v1 export.
    const legacy = JSON.parse(await readFile(io, path.join(location, 'artifact.json')));
    artifacts.validateArtifact(legacy);
    if (legacy.version !== 1 || legacy.digest !== digest) throw refuse('LIFECYCLE_ARTIFACT_DIGEST');
    return legacy;
  }
  if (manifest.format !== artifacts.FORMAT || manifest.version !== artifacts.VERSION ||
      artifacts.manifestDigest(manifest) !== digest) throw refuse('LIFECYCLE_ARTIFACT_DIGEST');
  const artifact = { format: manifest.format, version: manifest.version, manifest, digest, copies: {}, tables: {} };
  for (const { key, entry } of tableFiles(manifest)) {
    const data = await readFile(io, path.join(location, key + '.csv'));
    if (createHash('sha256').update(data).digest('hex') !== entry.sha256) throw refuse('LIFECYCLE_ARTIFACT_TABLE_DIGEST', key);
    artifact.copies[key] = data;
    artifact.tables[key] = copyTable.rows(data, entry.columns);
  }
  artifacts.validateArtifact(artifact);
  return artifact;
}

async function loadTenantArtifact ({ directory, digest, io = fs.promises } = {}) {
  if (typeof digest !== 'string' || !DIGEST.test(digest)) throw refuse('LIFECYCLE_ARTIFACT_DIGEST');
  await privateDirectory(io, directory);
  const location = path.join(directory, nameOf(digest));
  await privateDirectory(io, location);
  return readArtifact(io, location, digest);
}

async function writeFile (io, file, content) {
  const handle = await io.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}

async function saveTenantArtifact (artifact, { directory, io = fs.promises } = {}) {
  artifacts.validateArtifact(artifact);
  if (artifact.format !== artifacts.FORMAT) throw refuse('LIFECYCLE_ARTIFACT_FORMAT');
  await privateDirectory(io, directory, true);
  const destination = path.join(directory, nameOf(artifact.digest));
  try { await io.lstat(destination); throw refuse('LIFECYCLE_ARTIFACT_EXISTS'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let staging = await io.mkdtemp(path.join(directory, '.tenant-partial-'));
  try {
    for (const { key } of tableFiles(artifact.manifest)) {
      await writeFile(io, path.join(staging, key + '.csv'), artifact.copies[key]);
    }
    await writeFile(io, path.join(staging, 'manifest.json'), JSON.stringify(artifact.manifest) + '\n');
    await readArtifact(io, staging, artifact.digest);
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

// Removes the one export artifact the recorded digest names. The path is built
// only from the configured directory and the validated 64-hex digest, never from
// request input; the entry must be a real directory (a symlink or file with that
// name is refused, never followed). Returns 'removed' or 'absent'.
async function removeTenantArtifact ({ directory, digest, io = fs.promises } = {}) {
  if (typeof digest !== 'string' || !DIGEST.test(digest)) throw refuse('LIFECYCLE_ARTIFACT_DIGEST');
  await privateDirectory(io, directory);
  const location = path.join(directory, nameOf(digest));
  if (path.dirname(location) !== path.normalize(directory).replace(/\/+$/, '') || path.basename(location) !== nameOf(digest)) throw refuse('LIFECYCLE_ARTIFACT_PATH_REFUSED');
  let stat;
  try { stat = await io.lstat(location); } catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw refuse('LIFECYCLE_ARTIFACT_PATH_REFUSED');
  await io.rm(location, { recursive: true, force: false });
  await syncDirectory(io, directory);
  try { await io.lstat(location); } catch (error) {
    if (error.code === 'ENOENT') return 'removed';
    throw error;
  }
  throw refuse('LIFECYCLE_ARTIFACT_REMOVE_FAILED');
}

function createFilesystemArtifactRemover ({ directory, io = fs.promises } = {}) {
  return ({ digest }) => removeTenantArtifact({ directory, digest, io });
}

function createFilesystemArtifactVerifier ({ directory, io = fs.promises } = {}) {
  return async ({ tenant, artifact }) => {
    const loaded = await loadTenantArtifact({ directory, digest: artifact.digest, io });
    if (loaded.manifest.tenant !== tenant || artifact.manifest.tenant !== tenant) throw refuse('LIFECYCLE_TENANT_MISMATCH');
    return { tenant, digest: loaded.digest, verified: true };
  };
}
module.exports = { saveTenantArtifact, loadTenantArtifact, removeTenantArtifact, createFilesystemArtifactVerifier, createFilesystemArtifactRemover };
