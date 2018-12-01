'use strict';

var levels = require('../levels');
var times = require('../times');

var lastEntryValue;
var lastTime;
var lastMinutes;
var lastEntryTime;

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
        console.log('saying', sayIt, 'using lang code',  speechLangCode);
        
        var msg = new SpeechSynthesisUtterance(sayIt.toLowerCase());
        if (speechLangCode) msg.lang = speechLangCode;
        window.speechSynthesis.speak(msg);
    }

    speech.visualizeAlarm = function visualizeAlarm(sbx, alarm, alarmMessage) {
      console.log('Speech got an Alarm Message:',alarmMessage);
      speech.say(alarmMessage);
    }

    speech.updateVisualisation = function updateVisualisation(sbx) {

        if (sbx.data.inRetroMode) return;

        var timeNow = sbx.time;
        var entry = sbx.lastSGVEntry();
        
        if (timeNow && entry && entry.mills) {

            var timeSince = timeNow - entry.mills;
            var timeMinutes = Math.round(timeSince / 60000);

            if (lastEntryTime != entry.mills) {

                var lE = sbx.scaleMgdl(lastEntryValue);
                var cE = sbx.scaleMgdl(entry.mgdl);      
                
                var delta = ((cE - lE) %1 === 0) ? cE - lE : Math.round( (cE - lE) * 10) / 10;

                lastEntryValue = entry.mgdl;
                lastEntryTime = entry.mills;

                var sayIt = sbx.roundBGToDisplayFormat(sbx.scaleMgdl(entry.mgdl));
                
                if (!isNaN(delta)) {

                    sayIt += ', ' + translate('change') + ' ' + delta
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

                if (timeMinutes > 5 && timeMinutes != lastMinutes && timeMinutes % 5 == 0) {
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