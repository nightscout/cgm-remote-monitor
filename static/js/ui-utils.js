'use strict';

var openDraw = null;

function rawBGsEnabled() {
  return app.enabledOptions && app.enabledOptions.indexOf('rawbg') > -1;
}

function getBrowserSettings(storage) {
  var translate = Nightscout.language.translate;
  var json = {};

  function scaleBg(bg) {
    if (json.units === 'mmol') {
      return Nightscout.units.mgdlToMMOL(bg);
    } else {
      return bg;
    }
  }

  function appendThresholdValue(threshold) {
    return app.alarm_types.indexOf('simple') === -1 ? '' : ' (' + scaleBg(threshold) + ')';
  }

  try {
    json = {
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
      'timeFormat': storage.get('timeFormat'),
      'showPlugins': storage.get('showPlugins')
    };

    // Default browser units to server units if undefined.
    json.units = setDefault(json.units, app.units);
    if (json.units === 'mmol') {
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
    $('#alarm-urgenthigh-browser').prop('checked', json.alarmUrgentHigh).next().text(translate('Urgent High Alarm') + appendThresholdValue(app.thresholds.bg_high));
    $('#alarm-high-browser').prop('checked', json.alarmHigh).next().text(translate('High Alarm') + appendThresholdValue(app.thresholds.bg_target_top));
    $('#alarm-low-browser').prop('checked', json.alarmLow).next().text(translate('Low Alarm') + appendThresholdValue(app.thresholds.bg_target_bottom));
    $('#alarm-urgentlow-browser').prop('checked', json.alarmUrgentLow).next().text(translate('Urgent Low Alarm') + appendThresholdValue(app.thresholds.bg_low));
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
    if (json.theme === 'colors') {
      $('#theme-colors-browser').prop('checked', true);
    } else {
      $('#theme-default-browser').prop('checked', true);
    }

    json.timeFormat = setDefault(json.timeFormat, app.defaults.timeFormat);

    if (json.timeFormat === '24') {
      $('#24-browser').prop('checked', true);
    } else {
      $('#12-browser').prop('checked', true);
    }

    json.showPlugins = setDefault(json.showPlugins, app.defaults.showPlugins || Nightscout.plugins.enabledPluginNames());
    var showPluginsSettings = $('#show-plugins');
    Nightscout.plugins.eachEnabledPlugin(function each(plugin) {
      if (Nightscout.plugins.specialPlugins.indexOf(plugin.name) > -1) {
        //ignore these, they are always on for now
      } else {
        var id = 'plugin-' + plugin.name;
        var dd = $('<dd><input type="checkbox" id="' + id + '" value="' + plugin.name + '"/><label for="' + id + '">' + translate(plugin.label || plugin.name) + '</label></dd>');
        showPluginsSettings.append(dd);
        dd.find('input').prop('checked', json.showPlugins.indexOf(plugin.name) > -1);
      }
    });


  } catch(err) {
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

function showLocalstorageError() {
  var msg = '<b>Settings are disabled.</b><br /><br />Please enable cookies so you may customize your Nightscout site.';
  $('.browserSettings').html('<legend>Settings</legend>'+msg+'');
  $('#save').hide();
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

