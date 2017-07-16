'use strict';

var moment = require('moment-timezone');
var _ = require('lodash');
var parse_duration = require('parse-duration'); // https://www.npmjs.com/package/parse-duration
var times = require('../times');

function init (client, plugins, $) {
  var careportal = { };

  var translate = client.translate;
  var storage = $.localStorage;

  careportal.allEventTypes = plugins.getAllEventTypes(client.sbx);

  careportal.events = _.map(careportal.allEventTypes, function each (event) {
    return _.pick(event, ['val', 'name']);
  });
  
  var eventTime = $('#eventTimeValue');
  var eventDate = $('#eventDateValue');

  function setDateAndTime (time) {
    time = time || moment();
    eventTime.val(time.format('HH:mm'));
    eventDate.val(time.format('YYYY-MM-DD'));
  }

  function mergeDateAndTime ( ) {
    return client.utils.mergeInputTime(eventTime.val(), eventDate.val());
  }

  function updateTime(ele, time) {
    ele.attr('oldminutes', time.minutes());
    ele.attr('oldhours', time.hours());
  }

  function maybePrevent (event) {
    if (event) {
      event.preventDefault();
    }
  }

  var inputMatrix = {};

  _.forEach(careportal.allEventTypes, function each (event) {
    inputMatrix[event.val] = _.pick(event, ['bg', 'insulin', 'carbs', 'prebolus', 'duration', 'percent', 'absolute', 'profile', 'split', 'reasons', 'targets']);
  });

  careportal.filterInputs = function filterInputs ( event ) {
    var eventType = $('#eventType').val();
    
    function displayType (enabled) {
      if (enabled) {
        return '';
      } else {
        return 'none';
      }
    }
    
    function resetIfHidden(visible, id) {
      if (!visible) {
        $(id).val('');
      }
    }

    var reasons = inputMatrix[eventType]['reasons'];
    $('#reasonLabel').css('display',displayType(reasons && reasons.length > 0));
    $('#targets').css('display',displayType(inputMatrix[eventType]['targets']));

    $('#bg').css('display',displayType(inputMatrix[eventType]['bg']));
    $('#insulinGivenLabel').css('display',displayType(inputMatrix[eventType]['insulin']));
    $('#carbsGivenLabel').css('display',displayType(inputMatrix[eventType]['carbs']));
    $('#durationLabel').css('display',displayType(inputMatrix[eventType]['duration']));
    $('#percentLabel').css('display',displayType(inputMatrix[eventType]['percent'] && $('#absolute').val() === ''));
    $('#absoluteLabel').css('display',displayType(inputMatrix[eventType]['absolute'] && $('#percent').val() === ''));
    $('#profileLabel').css('display',displayType(inputMatrix[eventType]['profile']));
    $('#preBolusLabel').css('display',displayType(inputMatrix[eventType]['prebolus']));
    $('#insulinSplitLabel').css('display',displayType(inputMatrix[eventType]['split']));

    $('#reason').empty();
    _.each(reasons, function eachReason (reason) {
      $('#reason').append('<option value="' + reason.name + '">' + translate(reason.name) + '</option>');
    });

    careportal.reasonable();

    resetIfHidden(inputMatrix[eventType]['insulin'], '#insulinGiven');
    resetIfHidden(inputMatrix[eventType]['carbs'], '#carbsGiven');
    resetIfHidden(inputMatrix[eventType]['duration'], '#duration');
    resetIfHidden(inputMatrix[eventType]['absolute'], '#absolute');
    resetIfHidden(inputMatrix[eventType]['percent'], '#percent');
    resetIfHidden(inputMatrix[eventType]['prebolus'], '#preBolus');
    resetIfHidden(inputMatrix[eventType]['split'], '#insulinSplitNow');
    resetIfHidden(inputMatrix[eventType]['split'], '#insulinSplitExt');

    maybePrevent(event);
  };

  careportal.reasonable = function reasonable ( ) {
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

    if (reason && reason.duration) {
      $('#duration').val(reason.duration);
    } else {
      $('#duration').val('');
    }
  };

  careportal.prepareEvents = function prepareEvents ( ) {
    $('#eventType').empty();
    _.each(careportal.events, function eachEvent(event) {
      $('#eventType').append('<option value="' + event.val+ '">' + translate(event.name) + '</option>');
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

  careportal.adjustSplit = function adjustSplit(event) {
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
  
  careportal.resolveEventName = function resolveEventName(value) {
    _.each(careportal.events, function eachEvent(e) {
      if (e.val === value) {
        value = e.name;
      }
    });
    return value;
  };

  careportal.prepare = function prepare ( ) {
    $('#profile').empty();
    client.profilefunctions.listBasalProfiles().forEach(function (p) {
      $('#profile').append('<option val="' + p + '">' + p + '</option>');
    });
    careportal.prepareEvents();
    $('#eventType').val('<none>');
    $('#glucoseValue').val('').attr('placeholder', translate('Value in') + ' ' + client.settings.units);
    $('#meter').prop('checked', true);
    $('#carbsGiven').val('');
    $('#insulinGiven').val('');
    $('#duration').val('');
    $('#percent').val('');
    $('#absolute').val('');
    $('#profile').val(client.profilefunctions.activeProfileToTime());
    $('#preBolus').val(0);
    $('#notes').val('');
    $('#enteredBy').val(storage.get('enteredBy') || '');
    $('#nowtime').prop('checked', true);
    setDateAndTime();
  };

  function gatherData ( ) {
    var data = {
      enteredBy: $('#enteredBy').val()
    , eventType: $('#eventType').val()
    , glucose: $('#glucoseValue').val().replace(',','.')
    , reason: $('#reason').val()
    , targetTop: $('#targetTop').val().replace(',','.')
    , targetBottom: $('#targetBottom').val().replace(',','.')
    , glucoseType: $('#treatment-form').find('input[name=glucoseType]:checked').val()
    , carbs: $('#carbsGiven').val()
    , insulin: $('#insulinGiven').val()
    , duration: times.msecs(parse_duration($('#duration').val())).mins < 1 ? $('#duration').val() : times.msecs(parse_duration($('#duration').val())).mins
    , percent: $('#percent').val()
    , profile: $('#profile').val()
    , preBolus: parseInt($('#preBolus').val())
    , notes: $('#notes').val()
    , units: client.settings.units
    };

    //special handling for absolute to support temp to 0
    var absolute = $('#absolute').val();
    if ('' !== absolute && !isNaN(absolute)) {
      data.absolute = Number(absolute);
    }

    if ($('#othertime').is(':checked')) {
      data.eventTime = mergeDateAndTime().toDate();
    }
    
    if (!inputMatrix[data.eventType].profile) {
      delete data.profile;
    }

    if (data.eventType.indexOf('Temp Basal') > -1) {
      data.eventType = 'Temp Basal';
    }

    if (data.eventType.indexOf('Combo Bolus') > -1) {
      data.splitNow = parseInt($('#insulinSplitNow').val()) || 0;
      data.splitExt = parseInt($('#insulinSplitExt').val()) || 0;
    }

    return data;
  }

  careportal.save = function save (event) {
    var data = gatherData();
    confirmPost(data);
    maybePrevent(event);
  };

  function buildConfirmText(data) {
    var text = [
      translate('Please verify that the data entered is correct') + ': '
      , translate('Event Type') + ': ' + translate(careportal.resolveEventName(data.eventType))
    ];

    function pushIf (check, valueText) {
      if (check) {
        text.push(valueText);
      }
    }

    pushIf(data.glucose, translate('Blood Glucose') + ': ' + data.glucose);
    pushIf(data.glucose, translate('Measurement Method') + ': ' + translate(data.glucoseType));

    pushIf(data.carbs, translate('Carbs Given') + ': ' + data.carbs);
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

  function confirmPost(data) {
    if (window.confirm(buildConfirmText(data))) {
      postTreatment(data);
    }
  }

  function postTreatment(data) {
    if (data.eventType === 'Combo Bolus') {
      data.enteredinsulin = data.insulin;
      data.insulin = data.enteredinsulin * data.splitNow / 100;
      data.relative = data.enteredinsulin * data.splitExt / 100 / data.duration * 60;
    }

    $.ajax({
      method: 'POST',
      url: '/api/v1/treatments/'
    , headers: {
      'api-secret': client.hashauth.hash()
    }
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

