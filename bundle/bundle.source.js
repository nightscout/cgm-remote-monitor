(function () {

  window.Nightscout = window.Nightscout || {};

  window.Nightscout = {
    units: require('../lib/units')(),
    profile: require('../lib/profilefunctions')(),
    plugins: require('../lib/plugins/')().registerClientDefaults()
  };

  console.info('plugins', window.Nightscout.plugins);

  console.info("Nightscout bundle ready", window.Nightscout);

})();

