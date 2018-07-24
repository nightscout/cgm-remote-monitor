'use strict';

var levels = require('../levels');
var times = require('../times');

var lastEntryValue;
var lastTime;
var lastMinutes;


function init(ctx) {
    var translate = ctx.language.translate;
    var speechLangCode = ctx.language.speechCode;

    var speech = {
        name: 'speech',
        label: 'Speech',
        pluginType: 'pill-status',
        pillFlip: true
    };


    speech.say = function say(sayIt) {
        console.log('saying ' + sayIt + ' using lang code' + speechLangCode);
        
        var msg = new SpeechSynthesisUtterance(sayIt.toLowerCase());
        if (speechLangCode) msg.lang = speechLangCode;
        window.speechSynthesis.speak(msg);
    }

    speech.updateVisualisation = function updateVisualisation(sbx) {

        if (sbx.data.inRetroMode) return;

        var timeNow = sbx.time;
        var entry = sbx.lastSGVEntry();

        if (timeNow && entry && entry.mills) {

            var timeSince = timeNow - entry.mills;
            var timeMinutes = Math.round(timeSince / 60000);

            if (lastEntryValue != entry.mgdl) {

                var delta = entry.mgdl - lastEntryValue;
                lastEntryValue = entry.mgdl;

                var sayIt = sbx.roundBGToDisplayFormat(sbx.scaleMgdl(entry.mgdl));
                
                if (!isNaN(delta)) {

                    sayIt += ', ' + translate('change') + ' ' + sbx.roundBGToDisplayFormat(sbx.scaleMgdl(delta))
                }

                var iob = sbx.properties.iob;
                if (iob) {
                    var iobString = sbx.roundInsulinForDisplayFormat(iob.display);

                    if (iobString) {
                        sayIt += ", IOB " + iobString;
                    }
                }
                speech.say(sayIt);

            } else {

                if (timeMinutes > 5 && timeMinutes != lastMinutes) {
                    lastMinutes = timeMinutes;

                    var lastEntryString = translate('Last entry {0} minutes ago');
                    var sayIt = lastEntryString.replace('{0}', timeMinutes);
                    speech.say(sayIt);
                }
            }
        }
    };

    return speech;

}

module.exports = init;