'use strict';

var drawerIsOpen = false;
var treatmentDrawerIsOpen = false;
var defaultSettings = {
    'units': 'mg/dl',
    'alarmUrgentHigh': true,
    'alarmHigh': true,
    'alarmLow': true,
    'alarmUrgentLow': true,
    'nightMode': false,
    'theme': 'default',
    'timeFormat': '12'
};

function rawBGsEnabled() {
    return app.enabledOptions && app.enabledOptions.indexOf('rawbg') > -1;
}

function initShowRawBG(currentValue) {

    var initValue = 'never';

    if (currentValue === true) {
        initValue = 'noise';
    } else if (currentValue == 'never' || currentValue == 'always' || currentValue == 'noise') {
        initValue = currentValue;
    } else {
        initValue = app.enabledOptions.indexOf('rawbg-on') > -1 ? 'noise' : 'never';
    }

    return initValue;
}

function getBrowserSettings(storage) {
    var json = {};

    function scaleBg(bg) {
        if (json.units == 'mmol') {
            return (Math.round((bg / 18) * 10) / 10).toFixed(1);
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

        json.alarmUrgentHigh = setDefault(json.alarmUrgentHigh, defaultSettings.alarmUrgentHigh);
        json.alarmHigh = setDefault(json.alarmHigh, defaultSettings.alarmHigh);
        json.alarmLow = setDefault(json.alarmLow, defaultSettings.alarmLow);
        json.alarmUrgentLow = setDefault(json.alarmUrgentLow, defaultSettings.alarmUrgentLow);
        $('#alarm-urgenthigh-browser').prop('checked', json.alarmUrgentHigh).next().text('Urgent High Alarm' + appendThresholdValue(app.thresholds.bg_high));
        $('#alarm-high-browser').prop('checked', json.alarmHigh).next().text('High Alarm' + appendThresholdValue(app.thresholds.bg_target_top));
        $('#alarm-low-browser').prop('checked', json.alarmLow).next().text('Low Alarm' + appendThresholdValue(app.thresholds.bg_target_bottom));
        $('#alarm-urgentlow-browser').prop('checked', json.alarmUrgentLow).next().text('Urgent Low Alarm' + appendThresholdValue(app.thresholds.bg_low));

        json.nightMode = setDefault(json.nightMode, defaultSettings.nightMode);
        $('#nightmode-browser').prop('checked', json.nightMode);

        if (rawBGsEnabled()) {
            $('#show-rawbg-option').show();
            json.showRawbg = initShowRawBG(json.showRawbg);
            $('#show-rawbg-' + json.showRawbg).prop('checked', true);
        } else {
            json.showRawbg = 'never';
            $('#show-rawbg-option').hide();
        }

        if (json.customTitle) {
            $('h1.customTitle').text(json.customTitle);
            $('input#customTitle').prop('value', json.customTitle);
            document.title = 'Nightscout: ' + json.customTitle;
        }

        if (json.theme == 'colors') {
            $('#theme-colors-browser').prop('checked', true);
        } else {
            $('#theme-default-browser').prop('checked', true);
        }

        json.timeFormat = setDefault(json.timeFormat, defaultSettings.timeFormat);

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


function closeDrawer(callback) {
    $('#container').animate({marginLeft: '0px'}, 300, callback);
    $('#chartContainer').animate({marginLeft: '0px'}, 300);
    $('#drawer').animate({right: '-300px'}, 300, function() {
        $('#drawer').css('display', 'none');
    });
    drawerIsOpen = false;
}

function openDrawer()  {
    drawerIsOpen = true;
    $('#container').animate({marginLeft: '-300px'}, 300);
    $('#chartContainer').animate({marginLeft: '-300px'}, 300);
    $('#drawer').css('display', 'block').animate({right: '0'}, 300);
}

function closeTreatmentDrawer(callback) {
    $('#container').animate({marginLeft: '0px'}, 400, callback);
    $('#chartContainer').animate({marginLeft: '0px'}, 400);
    $('#treatmentDrawer').animate({right: '-300px'}, 400, function() {
        $('#treatmentDrawer').css('display', 'none');
    });
    treatmentDrawerIsOpen = false;
}

function openTreatmentDrawer()  {
    treatmentDrawerIsOpen = true;
    $('#container').animate({marginLeft: '-300px'}, 400);
    $('#chartContainer').animate({marginLeft: '-300px'}, 400);
    $('#treatmentDrawer').css('display', 'block').animate({right: '0'}, 400);

    $('#eventType').val('BG Check').focus();
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
    data.enteredBy = document.getElementById('enteredBy').value;
    data.eventType = document.getElementById('eventType').value;
    data.glucose = document.getElementById('glucoseValue').value;
    data.glucoseType = $('#treatment-form input[name=glucoseType]:checked').val();
    data.carbs = document.getElementById('carbsGiven').value;
    data.insulin = document.getElementById('insulinGiven').value;
    data.preBolus = document.getElementById('preBolus').value;
    data.notes = document.getElementById('notes').value;
    data.units = browserSettings.units;

    var eventTimeDisplay = '';
    if ($('#treatment-form input[name=nowOrOther]:checked').val() != 'now') {
        var value = document.getElementById('eventTimeValue').value;
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

        closeTreatmentDrawer();
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
    //close other drawers
    if(treatmentDrawerIsOpen) {
        closeTreatmentDrawer();
        treatmentDrawerIsOpen = false;
    }

    if(drawerIsOpen) {
        closeDrawer();
        drawerIsOpen = false;
    }  else {
        openDrawer();
        drawerIsOpen = true;
    }
    event.preventDefault();
});

$('#treatmentDrawerToggle').click(function(event) {
    //close other drawers
    if(drawerIsOpen) {
        closeDrawer();
        drawerIsOpen = false;
    }

    if(treatmentDrawerIsOpen) {
        closeTreatmentDrawer();
        treatmentDrawerIsOpen = false;
    }  else {
        openTreatmentDrawer();
        treatmentDrawerIsOpen = true;
    }
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

$('input#save').click(function(event) {
    storeInBrowser({
        'units': $('input:radio[name=units-browser]:checked').val(),
        'alarmUrgentHigh': $('#alarm-urgenthigh-browser').prop('checked'),
        'alarmHigh': $('#alarm-high-browser').prop('checked'),
        'alarmLow': $('#alarm-low-browser').prop('checked'),
        'alarmUrgentLow': $('#alarm-urgentlow-browser').prop('checked'),
        'nightMode': $('#nightmode-browser').prop('checked'),
        'showRawbg': $('input:radio[name=show-rawbg]:checked').val(),
        'customTitle': $('input#customTitle').prop('value'),
        'theme': $('input:radio[name=theme-browser]:checked').val(),
        'timeFormat': $('input:radio[name=timeformat-browser]:checked').val()
    });

    event.preventDefault();

    // reload for changes to take effect
    // -- strip '#' so form submission does not fail
    var url = window.location.href;
    url = url.replace(/#$/, '');
    window.location = url;
});


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
    }

    if (querystring.notify) {
        showNotification(querystring.notify, querystring.notifytype);
    }

    if (querystring.drawer) {
        openDrawer();
    }
});
