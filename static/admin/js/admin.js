(function () {
  'use strict';
  //for the tests window isn't the global object
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var admin_plugins = Nightscout.admin_plugins;
  var guiReady = false;

  client.requiredPermission = '*';
  client.init(function loaded () {
    // Authorization also completes after a socket reconnect. Keep existing
    // controls and their handlers instead of appending another copy.
    if (guiReady) return;
    guiReady = true;
    // init HTML code
    admin_plugins.createHTML( client );
  });

})();
