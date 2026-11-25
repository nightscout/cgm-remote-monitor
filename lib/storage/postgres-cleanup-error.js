'use strict';

// A rejected operation can still own a physical client/pool after cleanup
// fails. Strict owners must not retry until that cleanup is confirmed.
module.exports = class PostgresCleanupError extends Error {
  constructor (cause, cleanupError) {
    super('PostgreSQL cleanup unconfirmed', { cause });
    this.name = 'PostgresCleanupError';
    this.code = 'POSTGRES_CLEANUP_UNCONFIRMED';
    this.cleanupError = cleanupError;
  }
};
