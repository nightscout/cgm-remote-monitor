'use strict';

if (serverSettings === undefined) {
  console.error('server settings were not loaded, will not call init');
} else {
  window.Nightscout.client.init(serverSettings, Nightscout.plugins);
}
