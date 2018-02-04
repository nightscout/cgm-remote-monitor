'use strict';

var levels = require('../levels');
var times = require('../times');

var lastEntryValue;
var lastTime;
var lastMinutes;


function init(ctx) {
    var translate = ctx.language.translate;

    var speech = {
        name: 'speech',
        label: 'Speech',
        pluginType: 'pill-status',
        pillFlip: true
    };


    speech.say = function say(sayIt) {

        var msg = new SpeechSynthesisUtterance(sayIt);
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
                    sayIt += ", change " + sbx.roundBGToDisplayFormat(sbx.scaleMgdl(delta))
                }

                var iob = sbx.properties.iob;
                if (iob) {
                    var iobString = sbx.roundInsulinForDisplayFormat(iob.display);

                    if (iobString) {
                        sayIt += ", IOB " + iobString;
                    }
                }
                console.log('saying ' + sayIt);
                var msg = new SpeechSynthesisUtterance(sayIt);
                window.speechSynthesis.speak(msg);

            } else {

                if (timeMinutes > 1 && timeMinutes != lastMinutes) {
                    lastMinutes = timeMinutes;
                    var sayIt = 'Last entry ' + timeMinutes + ' minutes ago';
                    console.log('saying ' + sayIt);

                    var msg = new SpeechSynthesisUtterance(sayIt);
                    window.speechSynthesis.speak(msg);
                }

            }

        }



    };

    return speech;

}

module.exports = init;