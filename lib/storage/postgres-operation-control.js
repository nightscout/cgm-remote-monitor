'use strict';

// Only an actual selected window can admit its exact control read surface.
// Namespace strings or caller-supplied relation lists never grant an exemption.
module.exports = async function controlReads(connection, operationWindow) {
  if (operationWindow === undefined) return Object.freeze([]);
  if (!require('../tenant-lifecycle/operation-window').isWindow(operationWindow)) throw new Error('actual operation window required');
  return operationWindow.readinessControlRelations(connection);
};
