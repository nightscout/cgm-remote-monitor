'use strict';

var _ = require('lodash');

function init(ctx) {
    var moment = ctx.moment;
    var translate = ctx.language.translate;
    var levels = ctx.levels;
    
    var bage = {
    name: 'bage'
        , label: 'Pump Battery Age'
        , pluginType: 'pill-minor'
    };
    
    bage.getPrefs = function getPrefs(sbx) {
        return {
        info: sbx.extendedSettings.info || 312
            , warn: sbx.extendedSettings.warn || 336
            , urgent: sbx.extendedSettings.urgent || 360
            , display: sbx.extendedSettings.display ? sbx.extendedSettings.display : 'days'
            , enableAlerts: sbx.extendedSettings.enableAlerts || false
        };
    };
    
    bage.setProperties = function setProperties (sbx) {
        sbx.offerProperty('bage', function setProp ( ) {
                          return bage.findLatestTimeChange(sbx);
                          });
    };
    
    bage.checkNotifications = function checkNotifications(sbx) {
        var batteryInfo = sbx.properties.bage;
        
        if (batteryInfo.notification) {
            var notification = _.extend({}, batteryInfo.notification, {
                                        plugin: bage
                                        , debug: {
                                        age: batteryInfo.age
                                        }
                                        });
            sbx.notifications.requestNotify(notification);
        }
    };
    
    bage.findLatestTimeChange = function findLatestTimeChange(sbx) {
        
        var prefs = bage.getPrefs(sbx);
        
        var batteryInfo = {
        found: false
            , age: 0
            , treatmentDate: null
            , checkForAlert: false
        };
        
        var prevDate = 0;
        
        _.each(sbx.data.batteryTreatments, function eachTreatment (treatment) {
               var treatmentDate = treatment.mills;
               if (treatmentDate > prevDate && treatmentDate <= sbx.time) {
               
               prevDate = treatmentDate;
               batteryInfo.treatmentDate = treatmentDate;
               
               var a = moment(sbx.time);
               var b = moment(batteryInfo.treatmentDate);
               var days = a.diff(b,'days');
               var hours = a.diff(b,'hours') - days * 24;
               var age = a.diff(b,'hours');
               
               if (!batteryInfo.found || (age >= 0 && age < batteryInfo.age)) {
               batteryInfo.found = true;
               batteryInfo.age = age;
               batteryInfo.days = days;
               batteryInfo.hours = hours;
               batteryInfo.notes = treatment.notes;
               batteryInfo.minFractions = a.diff(b,'minutes') - age * 60;
               }
               }
               });
        
        
        batteryInfo.level = levels.NONE;
        
        var sound = 'incoming';
        var message;
        var sendNotification = false;
        
        if (batteryInfo.age >= prefs.urgent) {
            sendNotification = batteryInfo.age === prefs.urgent;
            message = translate('Pump Battery change overdue!');
            sound = 'persistent';
            batteryInfo.level = levels.URGENT;
        } else if (batteryInfo.age >= prefs.warn) {
            sendNotification = batteryInfo.age === prefs.warn;
            message = translate('Time to change pump battery');
            batteryInfo.level = levels.WARN;
        } else  if (batteryInfo.age >= prefs.info) {
            sendNotification = batteryInfo.age === prefs.info;
            message = 'Change pump battery soon';
            batteryInfo.level = levels.INFO;
        }
        
        if (prefs.display === 'days' && batteryInfo.found) {
            batteryInfo.display = '';
            if (batteryInfo.age >= 24) {
                batteryInfo.display += batteryInfo.days + 'd';
            }
            batteryInfo.display += batteryInfo.hours + 'h';
        } else {
            batteryInfo.display = batteryInfo.found ? batteryInfo.age + 'h' : 'n/a ';
        }
        
        //allow for 20 minute period after a full hour during which we'll alert the user
        if (prefs.enableAlerts && sendNotification && batteryInfo.minFractions <= 20) {
            batteryInfo.notification = {
            title: translate('Pump battery age %1 hours', { params: [batteryInfo.age] })
                , message: message
                , pushoverSound: sound
                , level: batteryInfo.level
                , group: 'BAGE'
            };
        }
        
        return batteryInfo;
    };
    
    bage.updateVisualisation = function updateVisualisation (sbx) {
        
        var batteryInfo = sbx.properties.bage;
        
        var info = [{ label: translate('Inserted'), value: new Date(batteryInfo.treatmentDate).toLocaleString() }];
        
        if (!_.isEmpty(batteryInfo.notes)) {
            info.push({label: translate('Notes') + ':', value: batteryInfo.notes});
        }
        
        var statusClass = null;
        if (batteryInfo.level === levels.URGENT) {
            statusClass = 'urgent';
        } else if (batteryInfo.level === levels.WARN) {
            statusClass = 'warn';
        }
        
        sbx.pluginBase.updatePillText(bage, {
                                      value: batteryInfo.display
                                      , label: translate('BAGE')
                                      , info: info
                                      , pillClass: statusClass
                                      });
    };
    return bage;
}

module.exports = init;
