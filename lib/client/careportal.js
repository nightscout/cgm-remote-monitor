'use strict';

var moment = require('moment-timezone');
var _ = require('lodash');
var parse_duration = require('parse-duration'); // https://www.npmjs.com/package/parse-duration
var times = require('../times');
var consts = require('../constants');
var Storages = require('js-storage');

function init (client, $) {
  var careportal = {};

  var translate = client.translate;
  var storage = Storages.localStorage;
  var units = client.settings.units;

  var eventTime = $('#eventTimeValue');
  var eventDate = $('#eventDateValue');

  function setDateAndTime (time) {
    time = time || moment();
    eventTime.val(time.format('HH:mm'));
    eventDate.val(time.format('YYYY-MM-DD'));
  }

  function mergeDateAndTime () {
    return client.utils.mergeInputTime(eventTime.val(), eventDate.val());
  }

  function updateTime (ele, time) {
    ele.attr('oldminutes', time.minutes());
    ele.attr('oldhours', time.hours());
  }

  function maybePrevent (event) {
    if (event) {
      event.preventDefault();
    }
  }

  var inputMatrix = {};
  var submitHooks = {};

  function refreshEventTypes() {
    careportal.allEventTypes = client.plugins.getAllEventTypes(client.sbx);

    careportal.events = _.map(careportal.allEventTypes, function each (event) {
      return _.pick(event, ['val', 'name']);
    });

    inputMatrix = {};
    submitHooks = {};

    _.forEach(careportal.allEventTypes, function each (event) {
      inputMatrix[event.val] = _.pick(event, ['otp','remoteCarbs', 'remoteAbsorption', 'remoteBolus', 'bg', 'insulin', 'carbs', 'protein', 'fat', 'prebolus', 'duration', 'percent', 'absolute', 'profile', 'split', 'sensor', 'reasons', 'targets']);
      submitHooks[event.val] = event.submitHook;
    });
  }

  refreshEventTypes();

  careportal.filterInputs = function filterInputs (event) {
    var eventType = $('#eventType').val();

    function displayType (enabled) {
      if (enabled) {
        return '';
      } else {
        return 'none';
      }
    }

    function resetIfHidden (visible, id) {
      if (!visible) {
        $(id).val('');
      }
    }

    var reasons = inputMatrix[eventType]['reasons'];
    $('#reasonLabel').css('display', displayType(reasons && reasons.length > 0));
    $('#targets').css('display', displayType(inputMatrix[eventType]['targets']));

    $('#otpLabel').css('display', displayType(inputMatrix[eventType]['otp']));
    $('#remoteCarbsLabel').css('display', displayType(inputMatrix[eventType]['remoteCarbs']));
    $('#remoteAbsorptionLabel').css('display', displayType(inputMatrix[eventType]['remoteAbsorption']));
    $('#remoteBolusLabel').css('display', displayType(inputMatrix[eventType]['remoteBolus']));

    $('#bg').css('display', displayType(inputMatrix[eventType]['bg']));
    $('#insulinGivenLabel').css('display', displayType(inputMatrix[eventType]['insulin']));

    $('#carbsGivenLabel').css('display', displayType(inputMatrix[eventType]['carbs']));
    $('#proteinGivenLabel').css('display', displayType(inputMatrix[eventType]['protein']));
    $('#fatGivenLabel').css('display', displayType(inputMatrix[eventType]['fat']));

    $('#sensorInfo').css('display', displayType(inputMatrix[eventType]['sensor']));

    $('#durationLabel').css('display', displayType(inputMatrix[eventType]['duration']));
    $('#percentLabel').css('display', displayType(inputMatrix[eventType]['percent'] && $('#absolute').val() === ''));
    $('#absoluteLabel').css('display', displayType(inputMatrix[eventType]['absolute'] && $('#percent').val() === ''));
    $('#profileLabel').css('display', displayType(inputMatrix[eventType]['profile']));
    $('#preBolusLabel').css('display', displayType(inputMatrix[eventType]['prebolus']));
    $('#insulinSplitLabel').css('display', displayType(inputMatrix[eventType]['split']));

    $('#reason').empty();
    _.each(reasons, function eachReason (reason) {
      $('#reason').append('<option value="' + reason.name + '">' + translate(reason.displayName || reason.name) + '</option>');
    });

    careportal.reasonable();

    resetIfHidden(inputMatrix[eventType]['otp'], '#otp');
    resetIfHidden(inputMatrix[eventType]['remoteCarbs'], '#remoteCarbs');
    resetIfHidden(inputMatrix[eventType]['remoteAbsorption'], '#remoteAbsorption');
    resetIfHidden(inputMatrix[eventType]['remoteBolus'], '#remoteBolus');

    resetIfHidden(inputMatrix[eventType]['insulin'], '#insulinGiven');
    resetIfHidden(inputMatrix[eventType]['carbs'], '#carbsGiven');
    resetIfHidden(inputMatrix[eventType]['protein'], '#proteinGiven');
    resetIfHidden(inputMatrix[eventType]['fat'], '#fatGiven');
    resetIfHidden(inputMatrix[eventType]['sensor'], '#sensorCode');
    resetIfHidden(inputMatrix[eventType]['sensor'], '#transmitterId');
    resetIfHidden(inputMatrix[eventType]['duration'], '#duration');
    resetIfHidden(inputMatrix[eventType]['absolute'], '#absolute');
    resetIfHidden(inputMatrix[eventType]['percent'], '#percent');
    resetIfHidden(inputMatrix[eventType]['prebolus'], '#preBolus');
    resetIfHidden(inputMatrix[eventType]['split'], '#insulinSplitNow');
    resetIfHidden(inputMatrix[eventType]['split'], '#insulinSplitExt');

    maybePrevent(event);
  };

  careportal.reasonable = function reasonable () {
    var eventType = $('#eventType').val();
    var reasons = inputMatrix[eventType]['reasons'];
    var selected = $('#reason').val();

    var reason = _.find(reasons, function matches (r) {
      return r.name === selected;
    });

    if (reason && reason.targetTop) {
      $('#targetTop').val(reason.targetTop);
    } else {
      $('#targetTop').val('');
    }

    if (reason && reason.targetBottom) {
      $('#targetBottom').val(reason.targetBottom);
    } else {
      $('#targetBottom').val('');
    }

    if (reason) {
      if (reason.duration) {
        $('#duration').val(reason.duration);
      } else {
        $('#duration').val('');
      }
    }
  };

  careportal.prepareEvents = function prepareEvents () {
    $('#eventType').empty();
    _.each(careportal.events, function eachEvent (event) {
      $('#eventType').append('<option value="' + event.val + '">' + translate(event.name) + '</option>');
    });
    $('#eventType').change(careportal.filterInputs);
    $('#reason').change(careportal.reasonable);
    $('#percent').on('input', careportal.filterInputs);
    $('#absolute').on('input', careportal.filterInputs);
    $('#insulinSplitNow').on('input', careportal.adjustSplit);
    $('#insulinSplitExt').on('input', careportal.adjustSplit);
    careportal.filterInputs();
    careportal.adjustSplit();
  };

  careportal.adjustSplit = function adjustSplit (event) {
    if ($(this).attr('id') === 'insulinSplitNow') {
      var nowval = parseInt($('#insulinSplitNow').val()) || 0;
      $('#insulinSplitExt').val(100 - nowval);
      $('#insulinSplitNow').val(nowval);
    } else {
      var extval = parseInt($('#insulinSplitExt').val()) || 0;
      $('#insulinSplitNow').val(100 - extval);
      $('#insulinSplitExt').val(extval);
    }

    maybePrevent(event);
  };

  careportal.resolveEventName = function resolveEventName (value) {
    _.each(careportal.events, function eachEvent (e) {
      if (e.val === value) {
        value = e.name;
      }
    });
    return value;
  };

  careportal.prepare = function prepare () {
    refreshEventTypes();

    $('#profile').empty();
    client.profilefunctions.listBasalProfiles().forEach(function(p) {
      $('#profile').append('<option val="' + p + '">' + p + '</option>');
    });
    careportal.prepareEvents();
    $('#eventType').val('<none>');
    $('#glucoseValue').val('').attr('placeholder', translate('Value in') + ' ' + client.settings.units);
    $('#meter').prop('checked', true);

    $('#otp').val('');
    $('#remoteCarbs').val('');
    $('#remoteAbsorption').val('');
    $('#remoteBolus').val('');

    $('#carbsGiven').val('');
    $('#proteinGiven').val('');
    $('#fatGiven').val('');
    $('#sensorCode').val('');
    $('#transmitterId').val('');
    $('#insulinGiven').val('');
    $('#duration').val('');
    $('#percent').val('');
    $('#absolute').val('');
    $('#profile').val(client.profilefunctions.activeProfileToTime());
    $('#preBolus').val(0);
    $('#notes').val('');
    $('#enteredBy').val(client.authorized ? client.authorized.sub : storage.get('enteredBy') || '');
    $('#nowtime').prop('checked', true);
    setDateAndTime();
  };

  function gatherData () {
    var eventType = $('#eventType').val();
    var selectedReason = $('#reason').val();

    var data = {
      enteredBy: $('#enteredBy').val()
      , eventType: eventType
      , otp: $('#otp').val()
      , remoteCarbs: $('#remoteCarbs').val()
      , remoteAbsorption: $('#remoteAbsorption').val()
      , remoteBolus: $('#remoteBolus').val()
      , glucose: $('#glucoseValue').val().replace(',', '.')
      , reason: selectedReason
      , targetTop: $('#targetTop').val().replace(',', '.')
      , targetBottom: $('#targetBottom').val().replace(',', '.')
      , glucoseType: $('#treatment-form').find('input[name=glucoseType]:checked').val()
      , carbs: $('#carbsGiven').val()
      , protein: $('#proteinGiven').val()
      , fat: $('#fatGiven').val()
      , sensorCode: $('#sensorCode').val()
      , transmitterId: $('#transmitterId').val()
      , insulin: $('#insulinGiven').val()
      , duration: times.msecs(parse_duration($('#duration').val())).mins < 1 ? $('#duration').val() : times.msecs(parse_duration($('#duration').val())).mins
      , percent: $('#percent').val()
      , profile: $('#profile').val()
      , preBolus: $('#preBolus').val()
      , notes: $('#notes').val()
      , units: client.settings.units
    };

    data.preBolus = parseInt(data.preBolus);

    if (isNaN(data.preBolus)) {
      delete data.preBolus;
    }

    var reasons = inputMatrix[eventType]['reasons'];
    var reason = _.find(reasons, function matches (r) {
      return r.name === selectedReason;
    });

    if (reason) {
      data.reasonDisplay = reason.displayName;
    }

    if (units == "mmol") {
      data.targetTop = data.targetTop * consts.MMOL_TO_MGDL;
      data.targetBottom = data.targetBottom * consts.MMOL_TO_MGDL;
    }

    //special handling for absolute to support temp to 0
    var absolute = $('#absolute').val();
    if ('' !== absolute && !isNaN(absolute)) {
      data.absolute = Number(absolute);
    }

    if ($('#othertime').is(':checked')) {
      data.eventTime = mergeDateAndTime().toDate();
    }

    data.created_at = data.eventTime ? data.eventTime.toISOString() : new Date().toISOString();

    if (!inputMatrix[data.eventType].profile) {
      delete data.profile;
    }

    if (data.eventType.indexOf('Temp Basal') > -1) {
      data.eventType = 'Temp Basal';
    }

    if (data.eventType.indexOf('Temporary Target Cancel') > -1) {
      data.duration = 0;
      data.eventType = 'Temporary Target';
      data.targetBottom = "";
      data.targetTop = "";
    }

    if (data.eventType.indexOf('Combo Bolus') > -1) {
      data.splitNow = parseInt($('#insulinSplitNow').val()) || 0;
      data.splitExt = parseInt($('#insulinSplitExt').val()) || 0;
    }

    let d = {};
    Object.keys(data).forEach(function(key) {
      if (data[key] !== "" && data[key] !== null) {
          d[key] = data[key]
        }
    });

    return d;
  }

  careportal.save = function save (event) {
    var data = gatherData();
    confirmPost(data);
    maybePrevent(event);
  };

  function validateData (data) {

    let allOk = true;
    let messages = [];

    console.log('Validating careportal entry: ', data.eventType);

    if (data.duration !== 0 && data.eventType == 'Temporary Target') {
      if (isNaN(data.targetTop) || isNaN(data.targetBottom) || !data.targetBottom || !data.targetTop) {
        console.log('Bottom or Top target missing');
        allOk = false;
        messages.push("Please enter a valid value for both top and bottom target to save a Temporary Target");
      } else {

        let targetTop = parseInt(data.targetTop);
        let targetBottom = parseInt(data.targetBottom);

        let minTarget = 4 * consts.MMOL_TO_MGDL;
        let maxTarget = 18 * consts.MMOL_TO_MGDL;

        if (units == "mmol") {
          targetTop = Math.round(targetTop / consts.MMOL_TO_MGDL * 10) / 10;
          targetBottom = Math.round(targetBottom / consts.MMOL_TO_MGDL * 10) / 10;
          minTarget = Math.round(minTarget / consts.MMOL_TO_MGDL * 10) / 10;
          maxTarget = Math.round(maxTarget / consts.MMOL_TO_MGDL * 10) / 10;
        }

        if (targetTop > maxTarget) {
          allOk = false;
          messages.push("Temporary target high is too high");
        }

        if (targetBottom < minTarget) {
          allOk = false;
          messages.push("Temporary target low is too low");
        }

        if (targetTop < targetBottom || targetBottom > targetTop) {
          allOk = false;
          messages.push("The low target must be lower than the high target and high target must be higher than the low target.");
        }

      }
    }

    // TODO: add check for remote (Bolus, Carbs, Absorption)

    return {
      allOk
      , messages
    };

  }

  function buildConfirmText (data) {
    var text = [
      translate('Please verify that the data entered is correct') + ': '
      , translate('Event Type') + ': ' + translate(careportal.resolveEventName(data.eventType))
    ];

    function pushIf (check, valueText) {
      if (check) {
        text.push(valueText);
      }
    }

    if (data.duration === 0 && data.eventType === 'Temporary Target') {
      text[text.length - 1] += ' ' + translate('Cancel');
    }

    pushIf(data.remoteCarbs, translate('Remote Carbs') + ': ' + data.remoteCarbs);
    pushIf(data.remoteAbsorption, translate('Remote Absorption') + ': ' + data.remoteAbsorption);
    pushIf(data.remoteBolus, translate('Remote Bolus') + ': ' + data.remoteBolus);
    pushIf(data.otp, translate('One Time Pascode') + ': ' + data.otp);

    pushIf(data.glucose, translate('Blood Glucose') + ': ' + data.glucose);
    pushIf(data.glucose, translate('Measurement Method') + ': ' + translate(data.glucoseType));

    pushIf(data.reason, translate('Reason') + ': ' + data.reason);

    var targetTop = data.targetTop;
    var targetBottom = data.targetBottom;

    if (units == "mmol") {
      targetTop = Math.round(data.targetTop / consts.MMOL_TO_MGDL * 10) / 10;
      targetBottom = Math.round(data.targetBottom / consts.MMOL_TO_MGDL * 10) / 10;
    }

    pushIf(data.targetTop, translate('Target Top') + ': ' + targetTop);
    pushIf(data.targetBottom, translate('Target Bottom') + ': ' + targetBottom);

    pushIf(data.carbs, translate('Carbs Given') + ': ' + data.carbs);
    pushIf(data.protein, translate('Protein Given') + ': ' + data.protein);
    pushIf(data.fat, translate('Fat Given') + ': ' + data.fat);
    pushIf(data.sensorCode, translate('Sensor Code') + ': ' + data.sensorCode);
    pushIf(data.transmitterId, translate('Transmitter ID') + ': ' + data.transmitterId);
    pushIf(data.insulin, translate('Insulin Given') + ': ' + data.insulin);
    pushIf(data.eventType === 'Combo Bolus', translate('Combo Bolus') + ': ' + data.splitNow + '% : ' + data.splitExt + '%');
    pushIf(data.duration, translate('Duration') + ': ' + data.duration + ' ' + translate('mins'));
    pushIf(data.percent, translate('Percent') + ': ' + data.percent);
    pushIf('absolute' in data, translate('Basal value') + ': ' + data.absolute);
    pushIf(data.profile, translate('Profile') + ': ' + data.profile);
    pushIf(data.preBolus, translate('Carb Time') + ': ' + data.preBolus + ' ' + translate('mins'));
    pushIf(data.notes, translate('Notes') + ': ' + data.notes);
    pushIf(data.enteredBy, translate('Entered By') + ': ' + data.enteredBy);

    text.push(translate('Event Time') + ': ' + (data.eventTime ? data.eventTime.toLocaleString() : new Date().toLocaleString()));
    return text.join('\n');
  }

  function confirmPost (data) {

    const validation = validateData(data);

    if (!validation.allOk) {

      let messages = "";

      validation.messages.forEach(function(m) {
        messages += translate(m) + "\n";
      });

      window.alert(messages);
    } else {
      if (window.confirm(buildConfirmText(data))) {
        var submitHook = submitHooks[data.eventType];
        if (submitHook) {
          submitHook(client, data, function (error) {
            if (error) {
              console.log("submit error = ", error);
              alert(translate('Error') + ': ' + error);
            } else {
              client.browserUtils.closeDrawer('#treatmentDrawer');
            }
          });
        } else {
          postTreatment(data);
        }
      }
    }
  }

  function postTreatment (data) {
    if (data.eventType === 'Combo Bolus') {
      data.enteredinsulin = data.insulin;
      data.insulin = data.enteredinsulin * data.splitNow / 100;
      data.relative = data.enteredinsulin * data.splitExt / 100 / data.duration * 60;
    }

    $.ajax({
      method: 'POST'
      , url: '/api/v1/treatments/'
      , headers: client.headers()
      , data: data
    }).done(function treatmentSaved (response) {
      console.info('treatment saved', response);
    }).fail(function treatmentSaveFail (response) {
      console.info('treatment saved', response);
      alert(translate('Entering record failed') + '. ' + translate('Status') + ': ' + response.status);
    });

    storage.set('enteredBy', data.enteredBy);

    client.browserUtils.closeDrawer('#treatmentDrawer');
  }

  careportal.dateTimeFocus = function dateTimeFocus (event) {
    $('#othertime').prop('checked', true);
    updateTime($(this), mergeDateAndTime());
    maybePrevent(event);
  };

  careportal.dateTimeChange = function dateTimeChange (event) {
    $('#othertime').prop('checked', true);
    var ele = $(this);
    var merged = mergeDateAndTime();

    if (ele.attr('oldminutes') === '59' && merged.minutes() === 0) {
      merged.add(1, 'hours');
    }
    if (ele.attr('oldminutes') === '0' && merged.minutes() === 59) {
      merged.add(-1, 'hours');
    }

    setDateAndTime(merged);
    updateTime(ele, merged);
    maybePrevent(event);
  };

  careportal.eventTimeTypeChange = function eventTimeTypeChange (event) {
    if ($('#othertime').is(':checked')) {
      eventTime.focus();
    } else {
      setDateAndTime();
    }
    maybePrevent(event);
  };

  careportal.toggleDrawer = function toggleDrawer (event) {
    client.browserUtils.toggleDrawer('#treatmentDrawer', careportal.prepare);
    maybePrevent(event);
  };

  $('#treatmentDrawerToggle').click(careportal.toggleDrawer);
  $('#treatmentDrawer').find('button').click(careportal.save);
  $('#eventTime').find('input:radio').change(careportal.eventTimeTypeChange);

  $('.eventinput').focus(careportal.dateTimeFocus).change(careportal.dateTimeChange);

  return careportal;
}

module.exports = init;
