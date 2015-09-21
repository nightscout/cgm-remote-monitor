'use strict';

var moment = require('moment-timezone');

function init (client, $) {
  var careportal = { };

  var translate = client.translate;
  var storage = $.localStorage;

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

  careportal.prepare = function prepare ( ) {
    $('#eventType').val('BG Check');
    $('#glucoseValue').val('').attr('placeholder', translate('Value in') + ' ' + client.settings.units);
    $('#meter').prop('checked', true);
    $('#carbsGiven').val('');
    $('#insulinGiven').val('');
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
    , glucose: $('#glucoseValue').val()
    , glucoseType: $('#treatment-form').find('input[name=glucoseType]:checked').val()
    , carbs: $('#carbsGiven').val()
    , insulin: $('#insulinGiven').val()
    , preBolus: parseInt($('#preBolus').val())
    , notes: $('#notes').val()
    , units: client.settings.units
    };

    if ($('#othertime').is(':checked')) {
      data.eventTime = mergeDateAndTime().toDate();
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
      , translate('Event Type') + ': ' + translate(data.eventType)
    ];

    function pushIf (check, valueText) {
      if (check) {
        text.push(valueText);
      }
    }

    pushIf(data.glucose, translate('Blood Glucose') + ': ' + data.glucose);
    pushIf(data.glucoseType, translate('Measurement Method') + ': ' + translate(data.glucoseType));

    pushIf(data.carbs, translate('Carbs Given') + ': ' + data.carbs);
    pushIf(data.insulin, translate('Insulin Given') + ': ' + data.insulin);
    pushIf(data.preBolus, translate('Carb Time') + ': ' + data.preBolus + ' ' + translate('mins'));
    pushIf(data.notes, translate('Notes') + ': ' + data.notes);
    pushIf(data.enteredBy, translate('Entered By') + ': ' + data.enteredBy);

    text.push(translate('Event Time') + ': ' + (data.eventTime ? data.eventTime.toLocaleString() : new Date().toLocaleString()));
    return text.join('\n');
  }

  function confirmPost(data) {
    if (window.confirm(buildConfirmText(data))) {
      $.ajax({
        method: 'POST',
        url: '/api/v1/treatments/',
        data: data
      }).done(function treatmentSaved (response) {
        console.info('treatment saved', response);
      });

      storage.set('enteredBy', data.enteredBy);

      client.browserUtils.closeDrawer('#treatmentDrawer');
    }
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

    if (ele.attr('oldminutes') === ' 59' && merged.minutes() === 0) {
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

