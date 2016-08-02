'use strict';

if (serverSettings === undefined) {
  console.error('server settings were not loaded, will not call init');
} else {
  if (authorized) {
    authorized.lat = Date.now();
  }
  window.Nightscout.client.init(serverSettings, Nightscout.plugins, authorized);
}
