'use strict';

const { unavailableCause } = require('../../storage/failures');

module.exports = function sendUnavailable (error, res) {
  const cause = unavailableCause(error);
  if (!cause) return false;
  if (cause.code === 'LIFECYCLE_WINDOW_SUSPENDED') res.set('Retry-After', String(cause.retryAfter));
  res.status(503).json({ error: 'STORAGE_UNAVAILABLE' });
  return true;
};
