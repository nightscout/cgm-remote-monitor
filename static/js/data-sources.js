(function () {
  'use strict';
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  // Keep the same owner authentication as the previous admin-hosted connector.
  client.requiredPermission = '*';
  client.init(function loaded() {
    Nightscout.dataSources.mount(client, '#data-sources-list');
    $('#data-sources-loading').hide();
  });
})();
