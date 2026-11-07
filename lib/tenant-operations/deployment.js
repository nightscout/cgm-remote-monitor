'use strict';

// Whole admitted-deployment composition. Default-off, operator-invoked only.
const { deploymentAdmission } = require('./catalogues');
const { createFilesystemBackup, loadArtifact } = require('./filesystem');
const backups = require('./backup');
const restores = require('./restore');
const upgrades = require('./upgrade');
const { refuse, COMMIT } = require('./common');
const path = require('node:path');

function originalIdentity (options) {
  if (['tenant', 'targetTenant', 'mapTenant', 'clone'].some(key => Object.hasOwn(options, key))) {
    throw refuse('OPERATIONS_REHOME_UNSUPPORTED');
  }
}

function explicitAcl (options) {
  if (options.acl != null && (!Array.isArray(options.acl.grants) || Object.hasOwn(options.acl, 'role'))) {
    throw refuse('OPERATIONS_DEPLOYMENT_ACL_REQUIRED');
  }
}

function createDeploymentOperations ({ directory, namespaces, selection, extensions, root, io } = {}) {
  const admission = () => deploymentAdmission({ namespaces, selection, extensions, root });
  // Re-enumerate on every operation: a newly joined M5 catalogue must refuse
  // until its explicit extension and namespace/table admission are provided.
  const durableBackup = createFilesystemBackup({ directory, io, backup: async (connection, options) => {
    originalIdentity(options);
    const current = admission();
    return backups.backup(connection, { ...options, catalogues: current.catalogues });
  } });
  return Object.freeze({
    admission,
    backup: (connection, options = {}) => durableBackup(connection, options),
    load: name => loadArtifact({ directory, name, io }),
    checkRecord: record => upgrades.assertUpgradeCompatible(record, admission().catalogues),
    restore: async (connection, artifact, options = {}) => {
      originalIdentity(options); explicitAcl(options);
      return restores.restore(connection, artifact, { ...options, catalogues: admission().catalogues });
    },
    upgrade: async (connection, options = {}) => {
      originalIdentity(options);
      if (!options.source || typeof options.source.root !== 'string' || !path.isAbsolute(options.source.root) || !COMMIT.test(options.source.sourceCommit)) {
        throw refuse('UPGRADE_SOURCE_ADMISSION_REQUIRED');
      }
      const source = deploymentAdmission(options.source);
      const persistedSource = createFilesystemBackup({ directory, io, backup: (connection, input) => backups.backup(connection, { ...input, catalogues: source.catalogues }) });
      return upgrades.upgrade(connection, { ...options, catalogues: admission().catalogues, sourceCatalogues: source.catalogues,
        backupSourceCommit: options.source.sourceCommit, backup: persistedSource });
    },
    rollback: async (connection, artifact, options = {}) => {
      originalIdentity(options); explicitAcl(options);
      if (!options.upgradeRecord) throw refuse('ROLLBACK_UPGRADE_RECORD_REQUIRED');
      return upgrades.rollback(connection, { ...options, artifact, catalogues: admission().catalogues });
    }
  });
}

module.exports = { createDeploymentOperations };
