'use strict';

// Fixed diagnostic vocabulary only. Never persist messages, paths, request data,
// driver detail, connection strings or values supplied by a failed dependency.
const ROLES = Object.freeze(['api', 'evaluator', 'realtime']);
const PHASES = Object.freeze(['CONTROL', 'LOAD_TARGET', 'OPERATION_READINESS', 'API_CATALOGUES', 'API_SERVING', 'LEGACY_AUTHORITY', 'LOCAL_ACCESS',
  'SECRET_PERSISTENCE', 'AUTHORIZATION', 'ROOT_SUBJECT_ADMIN', 'ACTIVITY_READER', 'CLINICAL_READINESS', 'CONSUMER_READINESS', 'TRUSTED_METADATA', 'ACTIVITY_CATALOGUE',
  'TARGET_CHECK', 'DATABASE_IDENTITY', 'PUBLISH_CERTIFICATE', 'REGISTRY_DISCOVERY', 'STREAM_STARTUP', 'STREAM_REPLICATION_CONNECT',
  'STREAM_IDENTIFY_SYSTEM', 'STREAM_REPLICATION_CLOSE', 'STREAM_RECOVERY_SETUP', 'STREAM_OPEN', 'STREAM_READY', 'CLINICAL_RUNTIME', 'DELIVERY_STARTUP', 'REGISTRY_FOLLOW']);
const CODES = new Set(['UNCLASSIFIED', 'CONFIGURATION_REFUSED', 'TYPE_ERROR', 'PLATFORM_VERIFICATION_TARGET', 'PLATFORM_VERIFICATION_ENVIRONMENT',
  'PLATFORM_VERIFICATION_INVALIDATED', 'PLATFORM_VERIFICATION_DATABASE_MISMATCH', 'PLATFORM_SERVING_IDENTITY_UNSAFE', 'PLATFORM_VERIFICATION_CONTROL',
  'NOTIFICATION_SCHEMA_UNSAFE', 'EVALUATOR_CONSUMER_READINESS_REFUSED', 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE', 'LIFECYCLE_WINDOW_ROLE_UNSAFE', 'LIFECYCLE_WINDOW_DATASTORE_CHANGED', 'LIFECYCLE_WINDOW_SCOPE_INVALID',
  'SECRETS_STORE_UNSAFE', 'SECRETS_STORE_UNAVAILABLE', 'SECRETS_LEGACY_AUTHORITY_UNSAFE', 'SECRETS_LEGACY_AUTHORITY_UNAVAILABLE',
  'ACCESS_AUTHORITY_UNSAFE', 'ACCESS_AUTHORITY_UNAVAILABLE', 'TENANT_AUTHORITY_UNSAFE', 'TENANT_AUTHORITY_UNAVAILABLE',
  'SUBJECT_ADMIN_STORE_UNSAFE', 'SUBJECT_ADMIN_STORE_UNAVAILABLE', 'ACTIVITY_STORE_UNSAFE', 'ACTIVITY_STORE_UNAVAILABLE', 'TRUSTED_WORKER_UNAVAILABLE',
  'MIG_STALE', 'MIG_HISTORY', 'MIG_UNKNOWN', 'MIG_CHECKSUM', 'PG_PRIVILEGE_REFUSED', 'PG_RELATION_MISSING', 'PG_COLUMN_MISSING', 'PG_SCHEMA_MISSING',
  'PG_AUTHENTICATION_REFUSED', 'CONNECTION_REFUSED', 'CONNECTION_RESET', 'CONNECTION_TIMEOUT', 'READINESS_IDENTITY_UNSAFE', 'READINESS_PRIVILEGES_UNSAFE',
  'SERVING_IDENTITY_UNSAFE', 'SERVING_SCHEMA_PRIVILEGES_UNSAFE', 'DOMAIN_PRIVILEGES_UNSAFE', 'WRITE_CLOCK_PRIVILEGES_UNSAFE', 'EVALUATOR_IDENTITY_UNSAFE',
  'EVALUATOR_SCOPE_UNSAFE', 'EVALUATOR_TABLE_PRIVILEGES_UNSAFE', 'PGSTREAM_REBOOTSTRAP_REQUIRED', 'PGSTREAM_SOURCE_REFUSED']);
const DRIVER = Object.freeze({ '42501': 'PG_PRIVILEGE_REFUSED', '42P01': 'PG_RELATION_MISSING', '42703': 'PG_COLUMN_MISSING', '3F000': 'PG_SCHEMA_MISSING',
  '28P01': 'PG_AUTHENTICATION_REFUSED', '28000': 'PG_AUTHENTICATION_REFUSED', ECONNREFUSED: 'CONNECTION_REFUSED', ECONNRESET: 'CONNECTION_RESET', ETIMEDOUT: 'CONNECTION_TIMEOUT' });
const MESSAGES = Object.freeze({ NOTIFICATION_SCHEMA_UNSAFE: 'NOTIFICATION_SCHEMA_UNSAFE', 'unsafe readiness identity': 'READINESS_IDENTITY_UNSAFE', 'unsafe readiness privileges': 'READINESS_PRIVILEGES_UNSAFE',
  'unsafe serving identity': 'SERVING_IDENTITY_UNSAFE', 'unsafe serving schema privileges': 'SERVING_SCHEMA_PRIVILEGES_UNSAFE',
  'unsafe domain privileges': 'DOMAIN_PRIVILEGES_UNSAFE', 'unsafe write clock privileges': 'WRITE_CLOCK_PRIVILEGES_UNSAFE',
  'unsafe evaluator identity': 'EVALUATOR_IDENTITY_UNSAFE', 'unsafe evaluator scope': 'EVALUATOR_SCOPE_UNSAFE', 'unsafe evaluator table privileges': 'EVALUATOR_TABLE_PRIVILEGES_UNSAFE' });
function read (error) {
  const value = error?.verificationDiagnostic;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'causeCode,checkPhase,targetRole' ||
      !(value.targetRole === null || ROLES.includes(value.targetRole)) || !PHASES.includes(value.checkPhase) || !CODES.has(value.causeCode)) return null;
  return Object.freeze({ targetRole: value.targetRole, checkPhase: value.checkPhase, causeCode: value.causeCode });
}
function classify (error, role, phase) {
  const targetRole = ROLES.includes(role) ? role : null, checkPhase = PHASES.includes(phase) ? phase : 'CONTROL';
  const existing = read(error);
  if (existing && existing.targetRole === targetRole) return existing;
  const mapped = Object.hasOwn(DRIVER, error?.code) ? DRIVER[error.code] : Object.hasOwn(MESSAGES, error?.message) ? MESSAGES[error.message] : null;
  const causeCode = CODES.has(error?.code) ? error.code : mapped ||
    (error instanceof require('./preview-config-error').PreviewConfigError ? 'CONFIGURATION_REFUSED' : error instanceof TypeError ? 'TYPE_ERROR' : 'UNCLASSIFIED');
  return Object.freeze({ targetRole, checkPhase, causeCode });
}
function annotate (error, role, phase) {
  // A fresh public-safe error, so neither a frozen driver error nor its detail
  // must be mutated or propagated across the admin operation boundary.
  return Object.assign(new Error('PLATFORM_VERIFICATION_FAILED'), { code: 'PLATFORM_VERIFICATION_FAILED', verificationDiagnostic: classify(error, role, phase) });
}
module.exports = { ROLES, PHASES, read, classify, annotate };
