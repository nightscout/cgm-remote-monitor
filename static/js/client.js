// don't 'use strict' since serverSettings might not get set if status.js fails

if (serverSettings === undefined) {
  console.error('server settings were not loaded, will not call init');
} else {
  window.Nightscout.client.init(serverSettings, Nightscout.plugins);
}
