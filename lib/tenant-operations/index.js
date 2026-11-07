'use strict';

// Dormant deployment operations: backup, restore, upgrade, rollback. Nothing
// on a serving or startup path imports this; no CLI command is wired.
const common = require('./common');
const { backup, serialize, deserialize, artifactName, summarize, compareSummaries, assertSameSummary } = require('./backup');
const { restore, verifyArtifact } = require('./restore');
const { upgrade, rollback, assertUpgradeCompatible } = require('./upgrade');
const { deploymentAdmission, discoverCatalogues } = require('./catalogues');
const { saveArtifact, loadArtifact, createFilesystemBackup } = require('./filesystem');
const { createDeploymentOperations } = require('./deployment');

module.exports = {
  FORMAT: common.FORMAT, VERSION: common.VERSION, plan: common.plan,
  backup, serialize, deserialize, artifactName, summarize, compareSummaries, assertSameSummary,
  restore, verifyArtifact, upgrade, rollback, assertUpgradeCompatible,
  deploymentAdmission, discoverCatalogues, saveArtifact, loadArtifact, createFilesystemBackup, createDeploymentOperations
};
