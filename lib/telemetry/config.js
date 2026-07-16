'use strict';

const DEFAULT_ENDPOINT = 'https://telemetry.nightscout.foundation/v1/nightscout/checkin';

function normalize (raw) {
  raw = raw || {};
  var mode = (raw.mode || 'off').toLowerCase();
  if (mode !== 'off' && mode !== 'aggregate') {
    mode = 'off';
  }

  var idRotation = (raw.idRotation || 'monthly').toLowerCase();
  if (idRotation !== 'monthly') {
    idRotation = 'monthly';
  }

  return {
    mode,
    endpoint: raw.endpoint || DEFAULT_ENDPOINT,
    preview: raw.preview !== false,
    manualSend: raw.manualSend === true,
    scheduledSend: raw.scheduledSend === true,
    idRotation,
    secret: raw.secret || null,
    storeDir: raw.storeDir || null,
    collection: raw.collection || 'telemetry',
    enabled: mode === 'aggregate'
  };
}

module.exports = {
  DEFAULT_ENDPOINT,
  normalize
};
