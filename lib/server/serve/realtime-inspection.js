'use strict';
// Cached bounded private observation. UDS permissions / selected HTTP network
// trust remain the transport authority; service headers are NOT authentication.
module.exports = function inspection ({ processIncarnation, placement, owner, quiescing }) {
  return function create (token) {
    return { async inspectRealtime (request) {
      if (request.transport !== token) throw Object.assign(Error('Realtime inspection transport refused'), {code: 'REALTIME_INSPECTION_REFUSED'});
      return {kind: 'realtime', observation: 'cached-not-lock-proof', processIncarnation,
        phase: quiescing() ? 'quiescing' : 'booted', placement: placement.cached(), ownerAvailable: owner()};
    } };
  };
};
