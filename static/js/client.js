'use strict';

if (this.serverSettings === undefined) {
  console.error('server settings were not loaded, will not call init');
} else {
  if (this.authorized) {
    this.authorized.lat = Date.now();
  }
  window.Nightscout.client.init(this.serverSettings, Nightscout.plugins, this.authorized);
}
