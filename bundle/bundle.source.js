(function () {

    window.Nightscout = window.Nightscout || {};

    window.Nightscout = {
        iob: require('../lib/iob')(),
        currentProfile: require('../lib/currentProfile')()
    };

    console.info("Nightscout bundle ready", window.Nightscout);

})();

