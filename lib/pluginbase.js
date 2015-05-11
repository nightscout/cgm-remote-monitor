'use strict';

function setEnv(env) {
	this.profile = env.profile;
	this.currentDetails = env.currentDetails;
	this.pluginPills = env.pluginPills;
	this.iob = env.iob;

	// TODO: clean!
	this.env = env;
}

function updateMajorPillText(updatedText, label) {

	var pillName = "span.pill." + this.name;
	
	var pill = this.pluginPills.find(pillName);

	if (!pill || pill.length == 0) {
		pill = $('<span class="pill '+ this.name+ '"><label>'+ label + '</label><em></em></span>');
		 this.pluginPills.append(pill);
	}

	pill.find('em').text(updatedText);
}

function scaleBg(bg) {
        if (browserSettings.units == 'mmol') {
            return Nightscout.units.mgdlToMMOL(bg);
        } else {
            return bg;
        }
}

function PluginBase() {
  return {
    setEnv: setEnv,
    updateMajorPillText: updateMajorPillText
  };
}

PluginBase.prototype.scaleBg = scaleBg;
PluginBase.prototype.setEnv = setEnv;
PluginBase.prototype.updateMajorPillText = updateMajorPillText;

module.exports = PluginBase;
