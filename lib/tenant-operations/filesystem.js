'use strict';

// Private filesystem artifact persistence. No retention/deletion/key policy.
const fs = require('node:fs');
const path = require('node:path');
const common = require('./common');
const backups = require('./backup');
const { verifyArtifact } = require('./restore');
const { refuse } = common;
const FILE = /^tables\/[a-z][a-z0-9_]{0,62}\.[a-z][a-z0-9_]{0,62}\.ndjson$/;
const NAME = /^deployment-backup-[0-9TZ-]+-[a-f0-9]{12}$/;

function expectedFiles (artifact) {
  verifyArtifact(artifact);
  const listed = new Set(['manifest.json']);
  for (const catalogue of artifact.manifest.catalogues) {
    for (const table of catalogue.tables) {
      const expected = 'tables/' + common.tableKey(catalogue.kind, table.table) + '.ndjson';
      if (!FILE.test(expected) || table.file !== expected || listed.has(expected)) throw refuse('BACKUP_FILE_PATH_INVALID');
      listed.add(expected);
    }
  }
  return listed;
}

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

async function loadDirectory (io, directory) {
  await privateDirectory(io, directory);
  await privateDirectory(io, path.join(directory, 'tables'));
  const files = { 'manifest.json': await readFile(io, path.join(directory, 'manifest.json')) };
  let manifest;
  try { manifest = JSON.parse(files['manifest.json']).manifest; } catch { throw refuse('RESTORE_ARTIFACT_INVALID'); }
  if (!manifest || !Array.isArray(manifest.catalogues)) throw refuse('RESTORE_ARTIFACT_INVALID');
  for (const catalogue of manifest.catalogues) {
    if (!Array.isArray(catalogue.tables)) throw refuse('RESTORE_ARTIFACT_INVALID');
    for (const table of catalogue.tables) {
      if (typeof table.file !== 'string' || !FILE.test(table.file)) throw refuse('BACKUP_FILE_PATH_INVALID');
      files[table.file] = await readFile(io, path.join(directory, table.file));
    }
  }
  const artifact = backups.deserialize(files);
  expectedFiles(artifact);
  return artifact;
}

async function loadArtifact ({ directory, name, io = fs.promises } = {}) {
  await privateDirectory(io, directory);
  if (typeof name !== 'string' || !NAME.test(name)) throw refuse('BACKUP_ARTIFACT_NAME_INVALID');
  const artifact = await loadDirectory(io, path.join(directory, name));
  if (backups.artifactName(artifact) !== name) throw refuse('BACKUP_ARTIFACT_NAME_MISMATCH');
  return artifact;
}

async function saveArtifact (artifact, { directory, io = fs.promises } = {}) {
  expectedFiles(artifact);
  await privateDirectory(io, directory, true);
  const name = backups.artifactName(artifact);
  if (!NAME.test(name)) throw refuse('BACKUP_ARTIFACT_NAME_INVALID');
  const destination = path.join(directory, name);
  try { await io.lstat(destination); throw refuse('BACKUP_DESTINATION_EXISTS'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let staging = await io.mkdtemp(path.join(directory, '.partial-'));
  try {
    await io.mkdir(path.join(staging, 'tables'), { mode: 0o700 });
    for (const [relative, text] of Object.entries(backups.serialize(artifact))) {
      const handle = await io.open(path.join(staging, relative), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    }
    await syncDirectory(io, path.join(staging, 'tables'));
    await syncDirectory(io, staging);
    const staged = await loadDirectory(io, staging);
    if (staged.digest !== artifact.digest) throw refuse('BACKUP_READBACK_MISMATCH');
    await io.rename(staging, destination);
    staging = null; // Published data is preserved on subsequent sync/read failure.
    await syncDirectory(io, directory);
    const reloaded = await loadArtifact({ directory, name, io });
    if (reloaded.digest !== artifact.digest) throw refuse('BACKUP_READBACK_MISMATCH');
    return reloaded;
  } catch (cause) {
    const error = refuse('BACKUP_DURABILITY_FAILED', name);
    error.cause = cause;
    throw error;
  } finally {
    // Only the exact staging directory created by this invocation is removable.
    // Never remove published artifacts or rotate a retained key/artifact.
    if (staging) await io.rm(staging, { recursive: true, force: true });
  }
}

// Existing upgrade callback seam: no migration up can begin before this resolves.
function createFilesystemBackup ({ directory, io = fs.promises, backup = backups.backup } = {}) {
  return async (connection, options) => saveArtifact(await backup(connection, options), { directory, io });
}

module.exports = { saveArtifact, loadArtifact, createFilesystemBackup, privateDirectory, syncDirectory, readFile };
