(function () {

    window.Nightscout = window.Nightscout || {};

    window.Nightscout = {
        iob: require('../lib/iob')()
    };

    console.info("Nightscout bundle ready", window.Nightscout);

})();

