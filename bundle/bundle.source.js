(function () {
	
    window.Nightscout = window.Nightscout || {};

    window.Nightscout = {
        iob: require('../lib/iob')(),
        profile: require('../lib/profilefunctions')()
    };

	// Plugins
	
	var inherits = require("inherits");
	var PluginBase = require('../lib/pluginbase'); // Define any shared functionality in this class

    window.NightscoutPlugins = window.NightscoutPlugins || {};

    window.NightscoutPlugins = {
        bwp: require('../lib/boluswizardpreview')(PluginBase)
    };
	// class inheritance to the plugins from the base + map functions over

	for (var p in window.NightscoutPlugins) {
		var plugin = window.NightscoutPlugins[p];
		inherits(plugin, PluginBase);
 
		for (var n in PluginBase.prototype) {
      		var item = PluginBase.prototype[n];                      
	    	plugin[n] = item;
  		}
	}

    console.info("Nightscout bundle ready", window.Nightscout);

})();

