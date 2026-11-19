'use strict';

// Whole admitted-deployment composition. Default-off, operator-invoked only.
const { deploymentAdmission } = require('./catalogues');
const upgrades = require('./upgrade');
const { refuse, COMMIT } = require('./common');
const path = require('node:path');

function originalIdentity (options) {
  if (['tenant', 'targetTenant', 'mapTenant', 'clone'].some(key => Object.hasOwn(options, key))) {
    throw refuse('OPERATIONS_REHOME_UNSUPPORTED');
  }
}

function createDeploymentOperations (options = {}) {
  const admission = () => deploymentAdmission(options);
  return Object.freeze({
    admission,
    checkRecord: record => upgrades.assertUpgradeCompatible(record, admission().catalogues),
    upgrade: async (connection, input = {}) => {
      originalIdentity(input);
      if (!input.source || typeof input.source.root !== 'string' || !path.isAbsolute(input.source.root) || !COMMIT.test(input.source.sourceCommit)) {
        throw refuse('UPGRADE_SOURCE_ADMISSION_REQUIRED');
      }
      const source = deploymentAdmission(input.source);
      return upgrades.upgrade(connection, { ...input, catalogues: admission().catalogues, sourceCatalogues: source.catalogues });
    }
  });
}

module.exports = { createDeploymentOperations };
