(function () {

  window.Nightscout = window.Nightscout || {};

  window.Nightscout = {
    units: require('../lib/units')(),
    profile: require('../lib/profilefunctions')(),
    plugins: require('../lib/plugins/')()
  };

  window.Nightscout.plugins.register({
    iob: require('../lib/plugins/iob')(),
    cob: require('../lib/plugins/cob')(),
    bwp: require('../lib/plugins/boluswizardpreview')(),
    cage: require('../lib/plugins/cannulaage')()
  });

  console.info("Nightscout bundle ready", window.Nightscout);

})();

