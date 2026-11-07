'use strict';

const { randomUUID } = require('node:crypto');
const scope = require('../storage/tenant-scope');
const artifacts = require('./artifact');
const { validateCatalogue } = require('../migrations/catalogue');
const candidate = require('./postgres-candidate.json');
const { assertRelationInventory } = require('../storage/postgres-relation-inventory');
const TABLE = 'tenant_lifecycle_ceremony';
const REQUESTS = 'tenant_lifecycle_requests';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTOR = /^[A-Za-z0-9_-]{1,128}$/;
const qualified = (namespace, table) => '"' + namespace + '"."' + table + '"';
const { refuse } = artifacts;

module.exports = function createCeremony ({ authorize, verifyDurableArtifact, executionWindow,
  namespaceOf, timestamp, verifyRows, eraseRows } = {}) {
  function optionsValid (options, needsRequest = true, needsArtifact = false) {
    if (!options || typeof options.tenant !== 'string' || !UUID.test(options.tenant)) throw refuse('LIFECYCLE_TENANT_INVALID');
    namespaceOf({ ledger: options.ledgerNamespace }, 'ledger');
    if (needsRequest && (typeof options.requestId !== 'string' || !UUID.test(options.requestId))) throw refuse('LIFECYCLE_REQUEST_INVALID');
    if (needsArtifact) {
      artifacts.validateArtifact(options.artifact);
      if (options.artifact.manifest.tenant !== options.tenant) throw refuse('LIFECYCLE_TENANT_MISMATCH');
    }
  }
  async function ready (connection, options) {
    const rows = await connection.query('SELECT name, checksum FROM ' + qualified(options.ledgerNamespace, 'schema_migrations') + ' ORDER BY name COLLATE "C"');
    if (!artifacts.ledgerEqual(rows.rows, validateCatalogue(candidate))) throw refuse('LIFECYCLE_CEREMONY_SCHEMA_REQUIRED');
    await assertRelationInventory(connection, { namespace: options.ledgerNamespace, tables: [REQUESTS, TABLE], fail: (reason, name) => refuse('LIFECYCLE_RELATION_' + reason, 'lifecycle.' + name) });
  }
  async function authority (connection, options, action) {
    if (typeof authorize !== 'function') throw refuse('LIFECYCLE_AUTHORITY_REQUIRED');
    const actor = await authorize({ connection, tenant: options.tenant, requestId: options.requestId, action });
    if (!actor || actor.allowed !== true || actor.current !== true || actor.tenant !== options.tenant ||
        !['owner', 'operator'].includes(actor.plane) || typeof actor.principal !== 'string' || typeof actor.consumer !== 'string' || !ACTOR.test(actor.principal) || !ACTOR.test(actor.consumer)) throw refuse('LIFECYCLE_AUTHORITY_REFUSED');
    if (['confirm', 'claim', 'execute'].includes(action) && actor.plane !== 'operator') throw refuse('LIFECYCLE_OPERATOR_REQUIRED');
    return actor;
  }
  async function durable (connection, options, action) {
    if (typeof verifyDurableArtifact !== 'function') throw refuse('LIFECYCLE_DURABLE_ARTIFACT_REQUIRED');
    const proof = await verifyDurableArtifact({ connection, tenant: options.tenant, requestId: options.requestId, artifact: options.artifact, action });
    if (!proof || proof.verified !== true || proof.tenant !== options.tenant || proof.digest !== options.artifact.digest) throw refuse('LIFECYCLE_DURABLE_ARTIFACT_REFUSED');
  }
  async function window (connection, options) {
    if (typeof executionWindow !== 'function') throw refuse('LIFECYCLE_EXECUTION_WINDOW_REQUIRED');
    const proof = await executionWindow({ connection, tenant: options.tenant, requestId: options.requestId });
    if (!proof || proof.current !== true || proof.quiesced !== true || proof.tenant !== options.tenant) throw refuse('LIFECYCLE_EXECUTION_WINDOW_REFUSED');
  }
  const transaction = (connection, options, fn) => {
    if (!connection || typeof connection.transaction !== 'function' || typeof connection.query !== 'function') throw refuse('LIFECYCLE_TRANSACTION_REQUIRED');
    return scope.withTenant(options.tenant, () => connection.transaction(async () => {
      await ready(connection, options);
      return fn();
    }));
  };
  async function insertState (connection, options, actor = null) {
    const inserted = await connection.query('INSERT INTO ' + qualified(options.ledgerNamespace, TABLE) +
      ' (request_id, tenant_id, phase, requested_by, requested_consumer) VALUES ($1, $2, $3, $4, $5)',
    [options.requestId, options.tenant, 'requested', actor ? actor.principal : null, actor ? actor.consumer : null]);
    if (inserted.rowCount !== 1) throw refuse('LIFECYCLE_CEREMONY_NOT_RECORDED');
    return { phase: 'requested' };
  }
  async function locked (connection, options, actor) {
    const request = await connection.query('SELECT request_id, tenant_id, artifact_digest, phase, requested_at FROM ' + qualified(options.ledgerNamespace, REQUESTS) +
      ' WHERE request_id = $1 AND tenant_id = $2 FOR UPDATE', [options.requestId, options.tenant]);
    if (request.rows.length !== 1) throw refuse('LIFECYCLE_REQUEST_MISSING');
    if (request.rows[0].phase === 'executed') throw refuse('LIFECYCLE_REQUEST_ALREADY_EXECUTED');
    if (options.artifact && request.rows[0].artifact_digest !== options.artifact.digest) throw refuse('LIFECYCLE_REQUEST_DIGEST_MISMATCH');
    // The parent request lock serializes cancellation/claim even for legacy rows
    // that lack a ceremony record. Legacy requests are never auto-confirmed.
    const state = await connection.query('SELECT phase, claim_id, started_at, confirmed_at FROM ' + qualified(options.ledgerNamespace, TABLE) +
      ' WHERE request_id = $1 AND tenant_id = $2 FOR UPDATE', [options.requestId, options.tenant]);
    return state.rows[0] || insertState(connection, options, actor);
  }
  async function update (connection, options, assignments, values, allowed) {
    const result = await connection.query('UPDATE ' + qualified(options.ledgerNamespace, TABLE) + ' SET ' + assignments +
      ' WHERE request_id = $1 AND tenant_id = $2 AND phase = ANY($3::text[])', [options.requestId, options.tenant, allowed, ...values]);
    if (result.rowCount !== 1) throw refuse('LIFECYCLE_CEREMONY_CONFLICT');
  }
  async function requestDeletion (connection, options = {}) {
    optionsValid(options, false, true);
    const current = { ...options, requestId: randomUUID() };
    return transaction(connection, current, async () => {
      const actor = await authority(connection, current, 'request');
      const requestedAt = timestamp(current.now);
      const result = await connection.query('INSERT INTO ' + qualified(current.ledgerNamespace, REQUESTS) +
        ' (request_id, tenant_id, artifact_digest, phase, requested_at) VALUES ($1, $2, $3, $4, $5)',
      [current.requestId, current.tenant, current.artifact.digest, 'requested', requestedAt]);
      if (result.rowCount !== 1) throw refuse('LIFECYCLE_REQUEST_NOT_RECORDED');
      await insertState(connection, current, actor);
      return { requestId: current.requestId, tenant: current.tenant, artifactDigest: current.artifact.digest, requestedAt };
    });
  }
  async function confirmDeletion (connection, options = {}) {
    optionsValid(options, true, true);
    return transaction(connection, options, async () => {
      await authority(connection, options, 'confirm');
      const state = await locked(connection, options);
      if (state.phase === 'cancelled') throw refuse('LIFECYCLE_REQUEST_CANCELLED');
      if (!['requested', 'confirmed'].includes(state.phase)) throw refuse('LIFECYCLE_EXECUTION_STARTED');
      await durable(connection, options, 'confirm');
      const actor = await authority(connection, options, 'confirm');
      if (state.phase === 'confirmed') return { requestId: options.requestId, confirmedAt: Number(state.confirmed_at) };
      const confirmedAt = timestamp(options.now);
      await update(connection, options, 'phase = $4, confirmed_by = $5, confirmed_consumer = $6, confirmed_at = $7',
        ['confirmed', actor.principal, actor.consumer, confirmedAt], ['requested']);
      return { requestId: options.requestId, confirmedAt };
    });
  }
  async function cancelDeletion (connection, options = {}) {
    optionsValid(options);
    return transaction(connection, options, async () => {
      await authority(connection, options, 'cancel');
      const state = await locked(connection, options);
      if (state.phase === 'cancelled') return { requestId: options.requestId, cancelled: true };
      if (!['requested', 'confirmed'].includes(state.phase)) throw refuse('LIFECYCLE_EXECUTION_STARTED');
      const actor = await authority(connection, options, 'cancel');
      const cancelledAt = timestamp(options.now);
      await update(connection, options, 'phase = $4, cancelled_by = $5, cancelled_consumer = $6, cancelled_at = $7',
        ['cancelled', actor.principal, actor.consumer, cancelledAt], ['requested', 'confirmed']);
      return { requestId: options.requestId, cancelled: true, cancelledAt };
    });
  }
  async function claimDeletion (connection, options = {}) {
    optionsValid(options, true, true);
    return transaction(connection, options, async () => {
      await authority(connection, options, 'claim');
      const state = await locked(connection, options);
      if (state.phase === 'cancelled') throw refuse('LIFECYCLE_REQUEST_CANCELLED');
      if (!['confirmed', 'executing'].includes(state.phase)) throw refuse('LIFECYCLE_CONFIRMATION_REQUIRED');
      await durable(connection, options, 'claim');
      await window(connection, options);
      await verifyRows(connection, options);
      const actor = await authority(connection, options, 'claim');
      if (state.phase === 'executing') return { requestId: options.requestId, claimId: state.claim_id, startedAt: Number(state.started_at), resumed: true };
      const startedAt = timestamp(options.now), claimId = randomUUID();
      if (startedAt < Number(state.confirmed_at)) throw refuse('LIFECYCLE_CLOCK_REWOUND');
      await update(connection, options, 'phase = $4, claim_id = $5, started_by = $6, started_consumer = $7, started_at = $8',
        ['executing', claimId, actor.principal, actor.consumer, startedAt], ['confirmed']);
      return { requestId: options.requestId, claimId, startedAt, resumed: false };
    });
  }
  async function executeDeletion (connection, options = {}) {
    optionsValid(options, true, true);
    // This successful COMMIT is the irreversible cancellation boundary. A failed
    // destructive transaction does not roll back or reopen the start claim.
    const claim = options.claimId ? { claimId: options.claimId } : await claimDeletion(connection, options);
    if (typeof claim.claimId !== 'string' || !UUID.test(claim.claimId)) throw refuse('LIFECYCLE_CLAIM_INVALID');
    return transaction(connection, options, async () => {
      // Same global order as confirm/cancel/claim: current authority fence,
      // parent request, then ceremony. Later checks retain this same-tx fence.
      await authority(connection, options, 'execute');
      const state = await locked(connection, options);
      if (state.phase === 'cancelled') throw refuse('LIFECYCLE_REQUEST_CANCELLED');
      if (state.phase !== 'executing' || state.claim_id !== claim.claimId) throw refuse('LIFECYCLE_CLAIM_INVALID');
      await authority(connection, options, 'execute');
      await durable(connection, options, 'execute');
      await window(connection, options);
      const plan = await verifyRows(connection, options);
      // Adapter must read/lock current authority in this same transaction. No
      // prior confirmation, request or claim result authorizes these effects.
      const actor = await authority(connection, options, 'execute');
      const executedAt = timestamp(options.now);
      if (executedAt < Number(state.started_at)) throw refuse('LIFECYCLE_CLOCK_REWOUND');
      const result = await eraseRows(connection, { ...options, now: () => executedAt }, plan);
      await update(connection, options, 'phase = $4, executed_by = $5, executed_consumer = $6, executed_at = $7',
        ['executed', actor.principal, actor.consumer, executedAt], ['executing']);
      return { ...result, claimId: claim.claimId };
    });
  }
  return { requestDeletion, confirmDeletion, cancelDeletion, claimDeletion, executeDeletion };
};
