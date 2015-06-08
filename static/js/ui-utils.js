'use strict';

var openDraw = null;

function rawBGsEnabled() {
    return app.enabledOptions && app.enabledOptions.indexOf('rawbg') > -1;
}

function getBrowserSettings(storage) {
    var json = {};

    function scaleBg(bg) {
        if (json.units == 'mmol') {
            return Nightscout.units.mgdlToMMOL(bg);
        } else {
            return bg;
        }
    }

    function appendThresholdValue(threshold) {
        return app.alarm_types.indexOf('simple') == -1 ? '' : ' (' + scaleBg(threshold) + ')';
    }

    try {
        var json = {
            'units': storage.get('units'),
            'alarmUrgentHigh': storage.get('alarmUrgentHigh'),
            'alarmHigh': storage.get('alarmHigh'),
            'alarmLow': storage.get('alarmLow'),
            'alarmUrgentLow': storage.get('alarmUrgentLow'),
            'alarmTimeAgoWarn': storage.get('alarmTimeAgoWarn'),
            'alarmTimeAgoWarnMins': storage.get('alarmTimeAgoWarnMins'),
            'alarmTimeAgoUrgent': storage.get('alarmTimeAgoUrgent'),
            'alarmTimeAgoUrgentMins': storage.get('alarmTimeAgoUrgentMins'),
            'nightMode': storage.get('nightMode'),
            'showRawbg': storage.get('showRawbg'),
            'customTitle': storage.get('customTitle'),
            'theme': storage.get('theme'),
            'timeFormat': storage.get('timeFormat')
        };

        // Default browser units to server units if undefined.
        json.units = setDefault(json.units, app.units);
        if (json.units == 'mmol') {
            $('#mmol-browser').prop('checked', true);
        } else {
            $('#mgdl-browser').prop('checked', true);
        }

        json.alarmUrgentHigh = setDefault(json.alarmUrgentHigh, app.defaults.alarmUrgentHigh);
        json.alarmHigh = setDefault(json.alarmHigh, app.defaults.alarmHigh);
        json.alarmLow = setDefault(json.alarmLow, app.defaults.alarmLow);
        json.alarmUrgentLow = setDefault(json.alarmUrgentLow, app.defaults.alarmUrgentLow);
        json.alarmTimeAgoWarn = setDefault(json.alarmTimeAgoWarn, app.defaults.alarmTimeAgoWarn);
        json.alarmTimeAgoWarnMins = setDefault(json.alarmTimeAgoWarnMins, app.defaults.alarmTimeAgoWarnMins);
        json.alarmTimeAgoUrgent = setDefault(json.alarmTimeAgoUrgent, app.defaults.alarmTimeAgoUrgent);
        json.alarmTimeAgoUrgentMins = setDefault(json.alarmTimeAgoUrgentMins, app.defaults.alarmTimeAgoUrgentMins);
        $('#alarm-urgenthigh-browser').prop('checked', json.alarmUrgentHigh).next().text('Urgent High Alarm' + appendThresholdValue(app.thresholds.bg_high));
        $('#alarm-high-browser').prop('checked', json.alarmHigh).next().text('High Alarm' + appendThresholdValue(app.thresholds.bg_target_top));
        $('#alarm-low-browser').prop('checked', json.alarmLow).next().text('Low Alarm' + appendThresholdValue(app.thresholds.bg_target_bottom));
        $('#alarm-urgentlow-browser').prop('checked', json.alarmUrgentLow).next().text('Urgent Low Alarm' + appendThresholdValue(app.thresholds.bg_low));
        $('#alarm-timeagowarn-browser').prop('checked', json.alarmTimeAgoWarn);
        $('#alarm-timeagowarnmins-browser').val(json.alarmTimeAgoWarnMins);
        $('#alarm-timeagourgent-browser').prop('checked', json.alarmTimeAgoUrgent);
        $('#alarm-timeagourgentmins-browser').val(json.alarmTimeAgoUrgentMins);

        json.nightMode = setDefault(json.nightMode, app.defaults.nightMode);
        $('#nightmode-browser').prop('checked', json.nightMode);

        if (rawBGsEnabled()) {
            $('#show-rawbg-option').show();
            json.showRawbg = setDefault(json.showRawbg, app.defaults.showRawbg);
            $('#show-rawbg-' + json.showRawbg).prop('checked', true);
        } else {
            json.showRawbg = 'never';
            $('#show-rawbg-option').hide();
        }

        json.customTitle = setDefault(json.customTitle, app.defaults.customTitle);
        $('h1.customTitle').text(json.customTitle);
        $('input#customTitle').prop('value', json.customTitle);

        json.theme = setDefault(json.theme, app.defaults.theme);
        if (json.theme == 'colors') {
            $('#theme-colors-browser').prop('checked', true);
        } else {
            $('#theme-default-browser').prop('checked', true);
        }

        json.timeFormat = setDefault(json.timeFormat, app.defaults.timeFormat);

        if (json.timeFormat == '24') {
            $('#24-browser').prop('checked', true);
        } else {
            $('#12-browser').prop('checked', true);
        }
    }
    catch(err) {
        console.error(err);
        showLocalstorageError();
    }

    return json;
}

function setDefault(variable, defaultValue) {
    if (typeof(variable) === 'object') {
        return defaultValue;
    }
    return variable;
}

function storeInBrowser(data) {

    for (var k in data) {
        if (data.hasOwnProperty(k)) {
            browserStorage.set(k, data[k]);
        }
    }

}

function getQueryParms() {
    var params = {};
    if (location.search) {
        location.search.substr(1).split('&').forEach(function(item) {
            params[item.split('=')[0]] = item.split('=')[1].replace(/[_\+]/g, ' ');
        });
    }
    return params;
}

function isTouch() {
    try { document.createEvent('TouchEvent'); return true; }
    catch (e) { return false; }
}

function closeDrawer(id, callback) {
    openDraw = null;
    $("html, body").animate({ scrollTop: 0 });
    $(id).animate({right: '-300px'}, 300, function () {
        $(id).css('display', 'none');
        if (callback) callback();
    });
}

function toggleDrawer(id, openCallback, closeCallback) {

    function openDrawer(id, callback) {
        function closeOpenDraw(callback) {
            if (openDraw) {
                closeDrawer(openDraw, callback);
            } else {
                callback()
            }
        }

        closeOpenDraw(function () {
            openDraw = id;
            $(id).css('display', 'block').animate({right: '0'}, 300, function () {
                if (callback) callback();
            });
        });

    }

    if (openDraw == id) {
        closeDrawer(id, closeCallback);
    } else {
        openDrawer(id, openCallback);
    }

}

function initTreatmentDrawer()  {
    $('#eventType').val('BG Check');
    $('#glucoseValue').val('').attr('placeholder', 'Value in ' + browserSettings.units);
    $('#meter').prop('checked', true);
    $('#carbsGiven').val('');
    $('#insulinGiven').val('');
    $('#preBolus').val(0);
    $('#notes').val('');
    $('#enteredBy').val(browserStorage.get('enteredBy') || '');
    $('#nowtime').prop('checked', true);
    $('#eventTimeValue').val(currentTime());
}

function currentTime() {
    var now = new Date();
    var hours = now.getHours();
    var minutes = now.getMinutes();

    if (hours<10) hours = '0' + hours;
    if (minutes<10) minutes = '0' + minutes;

    return ''+ hours + ':' + minutes;
}

function formatTime(date) {
    var hours = date.getHours();
    var minutes = date.getMinutes();
    var ampm = hours >= 12 ? 'pm' : 'am';
    hours = hours % 12;
    hours = hours ? hours : 12; // the hour '0' should be '12'
    minutes = minutes < 10 ? '0' + minutes : minutes;
    return hours + ':' + minutes + ' ' + ampm;
}

function closeNotification() {
    var notify = $('#notification');
    notify.hide();
    notify.find('span').html('');
}

function showNotification(note, type)  {
    var notify = $('#notification');
    notify.hide();

    // Notification types: 'info', 'warn', 'success', 'urgent'.
    // - default: 'urgent'
    notify.removeClass('info warn urgent');
    notify.addClass(type ? type : 'urgent');

    notify.find('span').html(note);
    notify.css('left', 'calc(50% - ' + (notify.width() / 2) + 'px)');
    notify.show();
}

function showLocalstorageError() {
    var msg = '<b>Settings are disabled.</b><br /><br />Please enable cookies so you may customize your Nightscout site.'
    $('.browserSettings').html('<legend>Settings</legend>'+msg+'');
    $('#save').hide();
}


function treatmentSubmit(event) {

    var data = {};
    data.enteredBy = $('#enteredBy').val();
    data.eventType = $('#eventType').val();
    data.glucose = $('#glucoseValue').val();
    data.glucoseType = $('#treatment-form input[name=glucoseType]:checked').val();
    data.carbs = $('#carbsGiven').val();
    data.insulin = $('#insulinGiven').val();
    data.preBolus = $('#preBolus').val();
    data.notes = $('#notes').val();
    data.units = browserSettings.units;

    var errors = [];
    if (isNaN(data.glucose)) {
        errors.push('Blood glucose must be a number');
    }

    if (isNaN(data.carbs)) {
        errors.push('Carbs must be a number');
    }

    if (isNaN(data.insulin)) {
        errors.push('Insulin must be a number');
    }

    if (errors.length > 0) {
        window.alert(errors.join('\n'));
    } else {
        var eventTimeDisplay = '';
        if ($('#treatment-form input[name=nowOrOther]:checked').val() != 'now') {
            var value = $('#eventTimeValue').val();
            var eventTimeParts = value.split(':');
            data.eventTime = new Date();
            data.eventTime.setHours(eventTimeParts[0]);
            data.eventTime.setMinutes(eventTimeParts[1]);
            data.eventTime.setSeconds(0);
            data.eventTime.setMilliseconds(0);
            eventTimeDisplay = formatTime(data.eventTime);
        }

        var dataJson = JSON.stringify(data, null, ' ');

        var ok = window.confirm(
                'Please verify that the data entered is correct: ' +
                '\nEvent type: ' + data.eventType +
                '\nBlood glucose: ' + data.glucose +
                '\nMethod: ' + data.glucoseType +
                '\nCarbs Given: ' + data.carbs +
                '\nInsulin Given: ' + data.insulin +
                '\nPre Bolus: ' + data.preBolus +
                '\nNotes: ' + data.notes +
                '\nEntered By: ' + data.enteredBy +
                '\nEvent Time: ' + eventTimeDisplay);

        if (ok) {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/v1/treatments/', true);
            xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
            xhr.send(dataJson);

            browserStorage.set('enteredBy', data.enteredBy);

            closeDrawer('#treatmentDrawer');
        }
    }

    if (event) {
        event.preventDefault();
    }
}


var querystring = getQueryParms();

function Dropdown(el) {
    this.ddmenuitem = 0;

    this.$el = $(el);
    var that = this;

    $(document).click(function() { that.close(); });
}
Dropdown.prototype.close = function () {
    if (this.ddmenuitem) {
        this.ddmenuitem.css('visibility', 'hidden');
        this.ddmenuitem = 0;
    }
};
Dropdown.prototype.open = function (e) {
    this.close();
    this.ddmenuitem = $(this.$el).css('visibility', 'visible');
    e.stopPropagation();
};


$('#drawerToggle').click(function(event) {
    toggleDrawer('#drawer');
    event.preventDefault();
});

$('#treatmentDrawerToggle').click(function(event) {
    toggleDrawer('#treatmentDrawer', initTreatmentDrawer);
    event.preventDefault();
});

$('#treatmentDrawer').find('button').click(treatmentSubmit);

$('#eventTime input:radio').change(function (){
    if ($('#othertime').attr('checked')) {
        $('#eventTimeValue').focus();
    }
});

$('#eventTimeValue').focus(function () {
    $('#othertime').attr('checked', 'checked');
});

$('#notification').click(function(event) {
    closeNotification();
    event.preventDefault();
});

$('#save').click(function(event) {
    storeInBrowser({
        'units': $('input:radio[name=units-browser]:checked').val(),
        'alarmUrgentHigh': $('#alarm-urgenthigh-browser').prop('checked'),
        'alarmHigh': $('#alarm-high-browser').prop('checked'),
        'alarmLow': $('#alarm-low-browser').prop('checked'),
        'alarmUrgentLow': $('#alarm-urgentlow-browser').prop('checked'),
        'alarmTimeAgoWarn': $('#alarm-timeagowarn-browser').prop('checked'),
        'alarmTimeAgoWarnMins': parseInt($('#alarm-timeagowarnmins-browser').val()) || 15,
        'alarmTimeAgoUrgent': $('#alarm-timeagourgent-browser').prop('checked'),
        'alarmTimeAgoUrgentMins': parseInt($('#alarm-timeagourgentmins-browser').val()) || 30,
        'nightMode': $('#nightmode-browser').prop('checked'),
        'showRawbg': $('input:radio[name=show-rawbg]:checked').val(),
        'customTitle': $('input#customTitle').prop('value'),
        'theme': $('input:radio[name=theme-browser]:checked').val(),
        'timeFormat': $('input:radio[name=timeformat-browser]:checked').val()
    });

    event.preventDefault();
    reload();
});


$('#useDefaults').click(function(event) {
    //remove all known settings, since there might be something else is in localstorage
    var settings = ['units', 'alarmUrgentHigh', 'alarmHigh', 'alarmLow', 'alarmUrgentLow', 'alarmTimeAgoWarn', 'alarmTimeAgoWarnMins', 'alarmTimeAgoUrgent', 'alarmTimeAgoUrgentMins', 'nightMode', 'showRawbg', 'customTitle', 'theme', 'timeFormat'];
    settings.forEach(function(setting) {
        browserStorage.remove(setting);
    });
    event.preventDefault();
    reload();
});

function reload() {
    // reload for changes to take effect
    // -- strip '#' so form submission does not fail
    var url = window.location.href;
    url = url.replace(/#$/, '');
    window.location = url;
}

$(function() {
    // Tooltips can remain in the way on touch screens.
    var notTouchScreen = (!isTouch());
    if (notTouchScreen) {
        $('.tip').tipsy();
    } else {
        // Drawer info tips should be displayed on touchscreens.
        $('#drawer').find('.tip').tipsy();
    }
    $.fn.tipsy.defaults = {
        fade: true,
        gravity: 'n',
        opacity: 0.75
    };

    if (querystring.notify) {
        showNotification(querystring.notify, querystring.notifytype);
    }

    if (querystring.drawer) {
        openDrawer('#drawer');
    }
});
