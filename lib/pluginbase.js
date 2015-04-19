'use strict';

function setEnv(env) {
	this.profile = env.profile;
	this.currentDetails = env.currentDetails;
	this.env = env;
}

function PluginBase() {
  return {
    setEnv: setEnv
  };
}

PluginBase.prototype.setEnv = setEnv;

module.exports = PluginBase;
