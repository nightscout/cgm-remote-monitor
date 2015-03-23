(function () {

    window.Nightscout = window.Nightscout || {};

    window.Nightscout = {
        iob: require('../lib/iob')()
        , units: require('../lib/units')()
        , currentProfile: require('../lib/currentProfile')()
    };

    console.info("Nightscout bundle ready", window.Nightscout);

})();

