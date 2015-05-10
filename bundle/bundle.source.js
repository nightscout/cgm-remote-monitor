(function () {
	
    window.Nightscout = window.Nightscout || {};

	// Default features

    window.Nightscout = {
        units: require('../lib/units')(),
        profile: require('../lib/profilefunctions')()
    };

	// Plugins
	
	var inherits = require("inherits");
	var PluginBase = require('../lib/pluginbase'); // Define any shared functionality in this class

    window.NightscoutPlugins = window.NightscoutPlugins || {};

    window.NightscoutPlugins = {
        iob: require('../lib/iob')(PluginBase),
        cob: require('../lib/cob')(PluginBase),
        bwp: require('../lib/boluswizardpreview')(PluginBase),
        cage: require('../lib/cannulaage')(PluginBase)
    };
	// class inheritance to the plugins from the base + map functions over

	for (var p in window.NightscoutPlugins) {
		var plugin = window.NightscoutPlugins[p];
		inherits(plugin, PluginBase);
		plugin.name = p;
 
		for (var n in PluginBase.prototype) {
      		var item = PluginBase.prototype[n];                      
	    	plugin[n] = item;
  		}
	}

    console.info("Nightscout bundle ready", window.Nightscout);

})();

