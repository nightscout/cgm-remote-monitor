(function () {

    window.Nightscout = window.Nightscout || {};

    window.Nightscout = {
        iob: require('../lib/iob')()
        , units: require('../lib/units')()
    };

    console.info("Nightscout bundle ready", window.Nightscout);

})();

