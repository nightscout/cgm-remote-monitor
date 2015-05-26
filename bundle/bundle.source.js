(function () {

  window.Nightscout = window.Nightscout || {};

  window.Nightscout = {
    units: require('../lib/units')(),
    profile: require('../lib/profilefunctions')(),
    plugins: require('../lib/plugins/')()
  };

  console.info('plugins', window.Nightscout.plugins);

  window.Nightscout.plugins.registerDefaults();

  console.info("Nightscout bundle ready", window.Nightscout);

})();

