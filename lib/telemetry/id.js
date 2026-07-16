'use strict';

const crypto = require('crypto');

function monthLabel (date) {
  date = date || new Date();
  return date.toISOString().slice(0, 7);
}

function monthlyInstallationId (secret, date) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('telemetry installation secret is required');
  }
  var digest = crypto
    .createHmac('sha256', secret)
    .update(monthLabel(date))
    .digest('base64url');
  return 'monthly_' + digest;
}

module.exports = {
  monthLabel,
  monthlyInstallationId
};
