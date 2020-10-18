'use strict';

var _ = require('lodash');

// VERSION 1 - 0.9.0 - 2015-Nov-07 - initial version
var STORAGE_VERSION = 1;
var Storages = require('js-storage');

function init (client, serverSettings, $) {

  serverSettings = serverSettings || { settings: {} };

  var storage = Storages.localStorage;
  var settings = require('../settings')();

  function loadForm () {
    var utils = client.utils;
    var language = require('../language')();
    language.set(settings.language);
    var translate = language.translate;

    function appendThresholdValue (threshold) {
      return settings.alarmTypes.indexOf('simple') === -1 ? '' : ' (' + utils.scaleMgdl(threshold) + ')';
    }

    if (settings.units === 'mmol') {
      $('#mmol-browser').prop('checked', true);
    } else {
      $('#mgdl-browser').prop('checked', true);
    }
    $('#alarm-urgenthigh-browser').prop('checked', settings.alarmUrgentHigh).next().text(translate('Urgent High Alarm') + appendThresholdValue(settings.thresholds.bgHigh));
    $('#alarm-high-browser').prop('checked', settings.alarmHigh).next().text(translate('High Alarm') + appendThresholdValue(settings.thresholds.bgTargetTop));
    $('#alarm-low-browser').prop('checked', settings.alarmLow).next().text(translate('Low Alarm') + appendThresholdValue(settings.thresholds.bgTargetBottom));
    $('#alarm-urgentlow-browser').prop('checked', settings.alarmUrgentLow).next().text(translate('Urgent Low Alarm') + appendThresholdValue(settings.thresholds.bgLow));
    $('#alarm-timeagowarn-browser').prop('checked', settings.alarmTimeagoWarn);
    $('#alarm-timeagowarnmins-browser').val(settings.alarmTimeagoWarnMins);
    $('#alarm-timeagourgent-browser').prop('checked', settings.alarmTimeagoUrgent);
    $('#alarm-timeagourgentmins-browser').val(settings.alarmTimeagoUrgentMins);
    $('#alarm-pumpbatterylow-browser').prop('checked', settings.alarmPumpBatteryLow);

    $('#nightmode-browser').prop('checked', settings.nightMode);
    $('#editmode-browser').prop('checked', settings.editMode);

    if (settings.isEnabled('rawbg')) {
      $('#show-rawbg-option').show();
      $('#show-rawbg-' + settings.showRawbg).prop('checked', true);
    } else {
      $('#show-rawbg-option').hide();
    }

    $('h1.customTitle').text(settings.customTitle);
    $('input#customTitle').prop('value', settings.customTitle);

    if (settings.theme === 'colors') {
      $('#theme-colors-browser').prop('checked', true);
    } else if (settings.theme === 'colorblindfriendly') {
      $('#theme-colorblindfriendly-browser').prop('checked', true);
    } else {
      $('#theme-default-browser').prop('checked', true);
    }

    var langSelect = $('#language');

    _.each(language.languages, function eachLanguage (lang) {
      langSelect.append('<option value="' + lang.code + '">' + lang.language + '</option>');
    });

    langSelect.val(settings.language);

    $('#scaleY').val(settings.scaleY);

    $('#basalrender').val(settings.extendedSettings.basal ? settings.extendedSettings.basal.render : 'none');

    $('#bolusrender').val(settings.extendedSettings.bolus ? settings.extendedSettings.bolus.render : 'all');

    if (settings.timeFormat === 24) {
      $('#24-browser').prop('checked', true);
    } else {
      $('#12-browser').prop('checked', true);
    }

    var showPluginsSettings = $('#show-plugins');
    var hasPluginsToShow = false;

    const pluginPrefs = [];

    client.plugins.eachEnabledPlugin(function each (plugin) {
      if (client.plugins.specialPlugins.indexOf(plugin.name) > -1) {
        //ignore these, they are always on for now
      } else {
        var id = 'plugin-' + plugin.name;
        var dd = $('<dd><input type="checkbox" id="' + id + '" value="' + plugin.name + '"/><label for="' + id + '">' + translate(plugin.label || plugin.name) + '</label></dd>');
        showPluginsSettings.append(dd);
        dd.find('input').prop('checked', settings.showPlugins.indexOf(plugin.name) > -1);
        hasPluginsToShow = true;
      }

      if (plugin.getClientPrefs) {
        const prefs = plugin.getClientPrefs();
        pluginPrefs.push({
          plugin
          , prefs
        })
      }
    });

    showPluginsSettings.toggle(hasPluginsToShow);

    const bs = $('#browserSettings');
    const toggleCheckboxes = [];

    if (pluginPrefs.length > 0) {
      pluginPrefs.forEach(function(e) {
        // Only show settings if plugin is visible
        if (settings.showPlugins.indexOf(e.plugin.name) > -1) {
          const label = e.plugin.label;
          const dl = $('<dl>');
          dl.append(`<dt class="translate">${label}</dt>`);
          e.prefs.forEach(function(p) {
            const id = e.plugin.name + "-" + p.id;
            const label = p.label;
            if (p.type == 'boolean') {
              const html = $(`<dd><input type="checkbox" id="${id}" value="true" /><label for="${id}r" class="translate">${label}</label></dd>`);
              dl.append(html);
              if (storage.get(id) == true) {
                toggleCheckboxes.push(id);
              }
            }
          });
          bs.append(dl);
        }
      });
    }

    toggleCheckboxes.forEach(function(cb) {
      $('#' + cb).prop('checked', true);
    });

    $('#editprofilelink').toggle(settings.isEnabled('iob') || settings.isEnabled('cob') || settings.isEnabled('bwp') || settings.isEnabled('basal'));
    
    //fetches token from url
    var parts = (location.search || '?').substring(1).split('&');
    var token = '';
    parts.forEach(function (val) {
      if (val.startsWith('token=')) {
        token = val.substring('token='.length);
      }
    });

    //if there is a token, append it to each of the links in the hamburger menu
    if (token != '') {
      token = '?token=' + token;
      $('#reportlink').attr('href', 'report' + token);
      $('#editprofilelink').attr('href', 'profile' + token);
      $('#admintoolslink').attr('href', 'admin' + token);
      $('#editfoodlink').attr('href', 'food' + token);
    }
  }

  function wireForm () {
    $('#useDefaults').click(function(event) {
      settings.eachSetting(function clearEachSetting (name) {
        storage.remove(name);
      });
      storage.remove('basalrender');
      storage.remove('bolusrender');
      event.preventDefault();
      client.browserUtils.reload();
    });

    $('#save').click(function(event) {
      function checkedPluginNames () {
        var checkedPlugins = [];
        $('#show-plugins input:checked').each(function eachPluginCheckbox (index, checkbox) {
          checkedPlugins.push($(checkbox).val());
        });
        return checkedPlugins.join(' ');
      }

      client.plugins.eachEnabledPlugin(function each (plugin) {
        if (plugin.getClientPrefs) {
          const prefs = plugin.getClientPrefs();

          prefs.forEach(function(p) {
            const id = plugin.name + "-" + p.id;
            if (p.type == 'boolean') {
              const val = $("#" + id).prop('checked');
              storage.set(id, val);
            }
          });
        }
      });

      function storeInBrowser (data) {
        Object.keys(data).forEach(k => {
          storage.set(k, data[k]);
        });
      }

      storeInBrowser({
        units: $('input:radio[name=units-browser]:checked').val()
        , alarmUrgentHigh: $('#alarm-urgenthigh-browser').prop('checked')
        , alarmHigh: $('#alarm-high-browser').prop('checked')
        , alarmLow: $('#alarm-low-browser').prop('checked')
        , alarmUrgentLow: $('#alarm-urgentlow-browser').prop('checked')
        , alarmTimeagoWarn: $('#alarm-timeagowarn-browser').prop('checked')
        , alarmTimeagoWarnMins: parseInt($('#alarm-timeagowarnmins-browser').val()) || 15
        , alarmTimeagoUrgent: $('#alarm-timeagourgent-browser').prop('checked')
        , alarmTimeagoUrgentMins: parseInt($('#alarm-timeagourgentmins-browser').val()) || 30
        , nightMode: $('#nightmode-browser').prop('checked')
        , editMode: $('#editmode-browser').prop('checked')
        , showRawbg: $('input:radio[name=show-rawbg]:checked').val()
        , customTitle: $('input#customTitle').prop('value')
        , theme: $('input:radio[name=theme-browser]:checked').val()
        , timeFormat: parseInt($('input:radio[name=timeformat-browser]:checked').val())
        , language: $('#language').val()
        , scaleY: $('#scaleY').val()
        , basalrender: $('#basalrender').val()
        , bolusrender: $('#bolusrender').val()
        , showPlugins: checkedPluginNames()
        , storageVersion: STORAGE_VERSION
      });

      event.preventDefault();
      client.browserUtils.reload();
    });
  }

  function showLocalstorageError () {
    var msg = '<b>Settings are disabled.</b><br /><br />Please enable cookies so you may customize your Nightscout site.';
    $('.browserSettings').html('<legend>Settings</legend>' + msg + '');
    $('#save').hide();
  }

  function handleStorageVersions () {
    var previousVersion = parseInt(storage.get('storageVersion'));

    //un-versioned settings
    if (isNaN(previousVersion)) {
      //special showPlugins handling for careportal
      //prevent careportal from being hidden by old stored settings
      if (settings.isEnabled('careportal')) {
        var storedShowPlugins = storage.get('showPlugins');
        if (storedShowPlugins && storedShowPlugins.indexOf('careportal') === -1) {
          settings.showPlugins += ' careportal';
        }
      }
    }
  }

  settings.extendedSettings = serverSettings.extendedSettings || { settings: {} };

  try {
    settings.eachSetting(function setEach (name) {
      var stored = storage.get(name);
      return stored !== undefined && stored !== null ? stored : serverSettings.settings[name];
    });

    if (serverSettings.settings.thresholds) {
      settings.thresholds = serverSettings.settings.thresholds;
    }


    if (serverSettings.settings.enable) {
      settings.enable = serverSettings.settings.enable;
    }

    if (settings.enable.indexOf('ar2') < 0) {
      settings.enable += ' ar2';
    }
    handleStorageVersions();
    if (!settings.extendedSettings.basal) {
      settings.extendedSettings.basal = {};
    }

    var basalStored = storage.get('basalrender');
    settings.extendedSettings.basal.render = basalStored !== null ? basalStored : settings.extendedSettings.basal.render;

    if (!settings.extendedSettings.bolus) {
      settings.extendedSettings.bolus = {};
    }

    var bolusStored = storage.get('bolusrender');
    settings.extendedSettings.bolus.render = bolusStored !== null ? bolusStored : settings.extendedSettings.bolus.render;

  } catch (err) {
    console.error(err);
    showLocalstorageError();
  }

  init.loadAndWireForm = function loadAndWireForm () {
    loadForm();
    wireForm();
  };

  init.loadPluginSettings = function loadPluginSettings (client) {

    client.plugins.eachEnabledPlugin(function each (plugin) {
      if (plugin.getClientPrefs) {
        const prefs = plugin.getClientPrefs();

        if (!settings.extendedSettings[plugin.name]) {
          settings.extendedSettings[plugin.name] = {};
        }

        const settingsBase = settings.extendedSettings[plugin.name];

        prefs.forEach(function(p) {
          const id = plugin.name + "-" + p.id;
          const stored = storage.get(id);
          if (stored !== null) {
            settingsBase[p.id] = stored;
          }
        });
      }
    });

  }

  return settings;
}

module.exports = init;
