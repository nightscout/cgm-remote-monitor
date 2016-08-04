(function () {
  'use strict';
  //for the tests window isn't the global object
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var admin_plugins = Nightscout.admin_plugins;

  if (serverSettings === undefined) {
    console.error('server settings were not loaded, will not call init');
  } else {
    if (authorized) {
      authorized.lat = Date.now();
    }
    client.init(serverSettings, Nightscout.plugins, authorized);
  }
  
  // init HTML code
  admin_plugins.createHTML( client );

})();
