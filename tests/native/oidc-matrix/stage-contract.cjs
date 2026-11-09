'use strict';

// A plan is an execution input, never a grant. The lead binds the complete plan,
// source and dependencies before any invocation. Every stage is mandatory.
const fail = code => Object.assign(new Error(code), { code });
const STAGES = Object.freeze([
  { id: 'vault-single', persistence: 'vault', mode: 'single', activeMs: 90000, families: ['vaultSingle'] },
  { id: 'vault-multi', persistence: 'vault', mode: 'multi', activeMs: 90000, families: ['vaultMulti'] },
  { id: 'mongo-sessions', persistence: 'mongo', mode: 'single', activeMs: 90000, families: ['mongoNativeSessions'] },
  { id: 'pg-sessions', persistence: 'postgres', mode: 'multi', activeMs: 90000, families: ['postgresNativeSessions'] },
  { id: 'mongo-http', persistence: 'mongo', mode: 'single', activeMs: 120000,
    families: ['mongoSignedHttps', 'singleBrowserLifecycle', 'defaultOffSingle', 'singleLegacyCompatibility'] },
  { id: 'owner-consumer', persistence: 'postgres', mode: 'multi', activeMs: 120000,
    families: ['ownerCreateRoleIssueRevoke', 'settingsVersionHistoryRollback', 'httpPresentation', 'evaluatorCycle', 'clinicalImmutability', 'tenantBImmutability', 'dataCredentialReplay', 'pinnedClientReplay', 'dataRevocation', 'foreignTenantRefusal'] },
  { id: 'owner-authority', persistence: 'postgres', mode: 'multi', activeMs: 120000,
    families: ['shiroGrammar', 'projectContainment', 'operatorContainment', 'delegationContainment', 'actorRevocation', 'policyWaiter', 'actorWaiter', 'roleWaiter', 'heldThroughCommit', 'auditRefusal', 'commitRefusal'] },
  { id: 'owner-browser', persistence: 'postgres', mode: 'multi', activeMs: 120000,
    families: ['ownerCookieMutations', 'ownerBearerParity', 'ownerCsrfOrigin', 'ownerSensitiveFreshness', 'ownerCurrentAuthority', 'ownerSessionLogout', 'ownerBrowserMutations', 'ownerBrowserTabsBackReload', 'ownerBrowserBearerParity', 'ownerBrowserLogout'] },
  { id: 'owner-compatibility', persistence: 'postgres', mode: 'multi', activeMs: 120000,
    families: ['defaultOffMulti', 'legacyApiSecret', 'legacySubject', 'legacyEightHourExchange', 'anonymousReadClamp', 'planeSeparation'] }
].map(stage => Object.freeze({ ...stage, families: Object.freeze(stage.families) })));
const SIGNING = 'configured-transit';
const EXTERNAL_ACTIVE_MS = 1200000, EXTERNAL_CLEANUP_MS = 120000;

function template () {
  return { version: 1, activeMs: EXTERNAL_ACTIVE_MS, cleanupMs: EXTERNAL_CLEANUP_MS,
    // Each stage has a fixed15s teardown cap inside the lead's absolute end.
    // A failure stops the matrix; the external cleanup end never restarts.
    stages: STAGES.map(stage => ({ id: stage.id, persistence: stage.persistence, mode: stage.mode,
      signing: SIGNING, activeMs: stage.activeMs, cleanupMs: 15000,
      transportMs: stage.id === 'owner-authority' ? 8000 : 5000,
      browser: ['mongo-http', 'owner-browser'].includes(stage.id),
      signerConfigEnv: stage.persistence === 'vault' ? null : stage.mode === 'single' ? 'OWNER_SINGLE_SIGNER_CONFIG' : 'OWNER_MULTI_SIGNER_CONFIG' })) };
}

function admit (execution, env = process.env) {
  if (!execution || execution.version !== 1 || execution.activeMs !== EXTERNAL_ACTIVE_MS ||
      execution.cleanupMs !== EXTERNAL_CLEANUP_MS || !Array.isArray(execution.stages) ||
      execution.stages.length !== STAGES.length) throw fail('OWNER_MATRIX_PLAN_INCOMPLETE');
  for (let index = 0; index < STAGES.length; index++) {
    const wanted = STAGES[index], stage = execution.stages[index];
    if (!stage || stage.id !== wanted.id || stage.persistence !== wanted.persistence || stage.mode !== wanted.mode ||
        stage.signing !== SIGNING || stage.activeMs !== wanted.activeMs || stage.cleanupMs !== 15000 ||
        stage.transportMs !== (wanted.id === 'owner-authority' ? 8000 : 5000) ||
        stage.browser !== ['mongo-http', 'owner-browser'].includes(wanted.id)) throw fail('OWNER_MATRIX_STAGE_BINDING');
    const expectedRef = wanted.persistence === 'vault' ? null : wanted.mode === 'single' ? 'OWNER_SINGLE_SIGNER_CONFIG' : 'OWNER_MULTI_SIGNER_CONFIG';
    if (stage.signerConfigEnv !== expectedRef) throw fail('OWNER_MATRIX_NATIVE_TRANSIT_REQUIRED');
    if (stage.persistence !== 'vault' && (typeof stage.signerConfigEnv !== 'string' ||
        !/^[A-Z][A-Z0-9_]{0,127}$/.test(stage.signerConfigEnv) || typeof env[stage.signerConfigEnv] !== 'string' ||
        !env[stage.signerConfigEnv])) throw fail('OWNER_MATRIX_NATIVE_TRANSIT_REQUIRED');
  }
  if (STAGES.reduce((total, stage) => total + stage.activeMs, 0) > execution.activeMs) throw fail('OWNER_MATRIX_STAGE_BUDGET');
  // A source-bound grant/supervisor supplies wall-clock ends. A boolean cannot
  // turn this plan into an execution authorization.
  return true;
}

function assertStage (stage, result) {
  const definition = STAGES.find(value => value.id === stage.id);
  if (!definition || !result || result.stage !== stage.id || result.persistence !== definition.persistence ||
      result.signing !== SIGNING || result.native !== true || result.completed !== true ||
      !result.families || definition.families.some(name => result.families[name] !== true)) {
    throw fail('OWNER_MATRIX_STAGE_RESULT_INCOMPLETE');
  }
  return true;
}

function complete (results) {
  if (!Array.isArray(results) || results.length !== STAGES.length) throw fail('OWNER_MATRIX_RESULT_INCOMPLETE');
  STAGES.forEach((stage, index) => { if (results[index]?.stage !== stage.id) throw fail('OWNER_MATRIX_RESULT_ORDER'); assertStage(stage, results[index]); });
  return { classification: 'complete-synthetic-owner-signed-oidc-native-matrix', completed: true,
    stages: results.map(value => value.stage), families: Object.fromEntries(results.flatMap(value => Object.entries(value.families))) };
}

module.exports = { STAGES, SIGNING, EXTERNAL_ACTIVE_MS, EXTERNAL_CLEANUP_MS, template, admit, assertStage, complete };
