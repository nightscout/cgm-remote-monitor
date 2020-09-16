"use strict";
var levels = require("../levels");

function init (ctx) {
  var guardianconnect = {
    name: "guardianconnect"
    , label: "GC"
    , pluginType: "pill-status"
    , pillFlip: true
  , };

  guardianconnect.getPrefs = function getPrefs (sbx) {
    return {
      warnPercentageBattery: sbx.extendedSettings.warnPercentageBattery ? sbx.extendedSettings.warnPercentageBattery : 50
      , urgentPercentageBattery: sbx.extendedSettings.urgentPercentageBattery ? sbx.extendedSettings.urgentPercentageBattery : 30
    , };
  };
  guardianconnect.setPreoperties = function setProperties (sbx) {
    sbx.offerProperty("guardianconnect", function setGuardianconnect () {
      return guardianconnect.analyzeData(sbx);
    });
  };
}
