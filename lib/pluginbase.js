'use strict';

function setEnv(env) {
	this.profile = env.profile;
	this.currentDetails = env.currentDetails;
	this.iob = env.iob;

	// TODO: clean!
	this.env = env;
}

function updateMajorPillText(updatedText, label) {

	var pillName = "span.pill." + this.name;
	
	var pill = this.currentDetails.find(pillName);

	if (!pill || pill.length == 0) {
		pill = $('<span class="pill '+ this.name+ '"><label>'+ label + '</label><em></em></span>');
		 this.currentDetails.append(pill);
	}

	pill.find('em').text(updatedText);
}

function PluginBase() {
  return {
    setEnv: setEnv,
    updateMajorPillText: updateMajorPillText
  };
}

PluginBase.prototype.setEnv = setEnv;
PluginBase.prototype.updateMajorPillText = updateMajorPillText;

module.exports = PluginBase;
