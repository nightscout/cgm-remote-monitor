'use strict';

var openDraw = null;

function rawBGsEnabled() {
  return serverSettings.enabledOptions && serverSettings.enabledOptions.indexOf('rawbg') > -1;
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
  $('html, body').animate({ scrollTop: 0 });
  $(id).animate({right: '-300px'}, 300, function () {
    $(id).css('display', 'none');
    if (callback) { callback(); }
  });
}

function toggleDrawer(id, openCallback, closeCallback) {

  function openDrawer(id, callback) {
    function closeOpenDraw(callback) {
      if (openDraw) {
        closeDrawer(openDraw, callback);
      } else {
        callback();
      }
    }

    closeOpenDraw(function () {
      openDraw = id;
      $(id).css('display', 'block').animate({right: '0'}, 300, function () {
        if (callback) { callback(); }
      });
    });

  }

  if (openDraw === id) {
    closeDrawer(id, closeCallback);
  } else {
    openDrawer(id, openCallback);
  }

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


var querystring = getQueryParms();

$('#drawerToggle').click(function(event) {
  toggleDrawer('#drawer');
  event.preventDefault();
});

$('#notification').click(function(event) {
  closeNotification();
  event.preventDefault();
});

$('#save').click(function(event) {
  function checkedPluginNames() {
    var checkedPlugins = [];
    $('#show-plugins input:checked').each(function eachPluginCheckbox(index, checkbox) {
      checkedPlugins.push($(checkbox).val());
    });
    return checkedPlugins.join(' ');
  }

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
    'timeFormat': $('input:radio[name=timeformat-browser]:checked').val(),
    'showPlugins': checkedPluginNames()
  });

  event.preventDefault();
  reload();
});


$('#useDefaults').click(function(event) {
  //remove all known settings, since there might be something else is in localstorage
  var settings = ['units', 'alarmUrgentHigh', 'alarmHigh', 'alarmLow', 'alarmUrgentLow', 'alarmTimeAgoWarn', 'alarmTimeAgoWarnMins', 'alarmTimeAgoUrgent', 'alarmTimeAgoUrgentMins', 'nightMode', 'showRawbg', 'customTitle', 'theme', 'timeFormat', 'showPlugins'];
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

