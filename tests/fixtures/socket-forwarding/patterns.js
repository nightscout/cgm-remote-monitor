'use strict';

// Source-pinned envelope/ack patterns, NOT execution of AndroidAPS/Kotlin or
// proof of actual storage deduplication. Domain values are synthetic.
const provenance = require('./androidaps-3.4.2.3.json');
const authorization = () => ({ client: 'Android_synthetic', history: 24, status: true,
  from: 0, secret: 'synthetic-socket-credential' });
const addTreatment = () => ({ collection: 'treatments', data: {
  eventType: 'Note', created_at: '2026-11-06T00:00:00.000Z', notes: 'synthetic-source-pattern'
} });
const addDeviceStatus = () => ({ collection: 'devicestatus', data: {
  device: 'synthetic-AndroidAPS', created_at: '2026-11-06T00:00:00.000Z'
} });
const updateTreatment = id => ({ collection: 'treatments', _id: id, data: { notes: 'synthetic-update' } });
const alarmAck = () => [2, 'synthetic-group', 60000];
function addedId (replyArgs) {
  const response = replyArgs[0];
  if (!Array.isArray(response) || !response.length || typeof response[0]._id !== 'string') {
    throw new Error('NSCLIENT_PATTERN_ADD_ACK_INVALID');
  }
  return response[0]._id;
}
function updated (replyArgs) {
  return !!replyArgs[0] && ['success', 'Missing _id'].includes(replyArgs[0].result);
}
function sequence (treatmentId) {
  // A chosen synthetic scenario, not a claim about Android scheduler ordering.
  const add = addTreatment();
  return [
    { namespace: '/', event: 'authorize', args: [authorization()] },
    { namespace: '/', event: 'dbAdd', args: [add], withholdAcknowledgement: true },
    { namespace: '/', event: 'dbAdd', args: [add], retry: true },
    { namespace: '/', event: 'dbUpdate', args: [updateTreatment(treatmentId)] },
    { namespace: '/', event: 'dbAdd', args: [addDeviceStatus()] },
    { namespace: '/', event: 'ack', args: alarmAck() }
  ];
}
module.exports = { provenance, authorization, addTreatment, addDeviceStatus, updateTreatment, alarmAck, addedId, updated, sequence };
