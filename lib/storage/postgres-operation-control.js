'use strict';

// Only an actual selected window can admit its exact control read surface.
// Namespace strings or caller-supplied relation lists never grant an exemption.
module.exports = async function controlReads(connection, operationWindow) {
  if (operationWindow === undefined) return Object.freeze([]);
  if (!require('../tenant-lifecycle/operation-window').isWindow(operationWindow)) throw new Error('actual operation window required');
  await operationWindow.ready();
  await require('../tenant-lifecycle/operation-window-readiness').admit(connection, operationWindow.namespace, {identity: operationWindow.identity});
  return Object.freeze(['schema_migrations','tenant_lifecycle_windows','tenant_lifecycle_operations'].map(table => operationWindow.namespace + '.' + table));
};
