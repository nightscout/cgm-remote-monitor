'use strict';

(function () {
  function initTreatmentDrawer() {
    $('#eventType').val('BG Check');
    $('#glucoseValue').val('').attr('placeholder', 'Value in ' + browserSettings.units);
    $('#meter').prop('checked', true);
    $('#carbsGiven').val('');
    $('#insulinGiven').val('');
    $('#preBolus').val(0);
    $('#notes').val('');
    $('#enteredBy').val(browserStorage.get('enteredBy') || '');
    $('#nowtime').prop('checked', true);
    $('#eventTimeValue').val(moment().format('HH:mm'));
    $('#eventDateValue').val(moment().format('YYYY-MM-D'));
  }

  function checkForErrors(data) {
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
    return errors;
  }

  function prepareData() {
    var data = {
      enteredBy: $('#enteredBy').val()
    , eventType: $('#eventType').val()
    , glucose: $('#glucoseValue').val()
    , glucoseType: $('#treatment-form').find('input[name=glucoseType]:checked').val()
    , carbs: $('#carbsGiven').val()
    , insulin: $('#insulinGiven').val()
    , preBolus: parseInt($('#preBolus').val())
    , notes: $('#notes').val()
    , units: browserSettings.units
    };

    if ($('#othertime').is(':checked')) {
      data.eventTime = Nightscout.utils.mergeInputTime($('#eventTimeValue').val(), $('#eventDateValue').val());
    }

    return data;
  }

  function treatmentSubmit(event) {

    var data = prepareData();
    var errors = checkForErrors(data);

    if (errors.length > 0) {
      window.alert(errors.join('\n'));
    } else {
      confirmPost(data);
    }

    if (event) {
      event.preventDefault();
    }
  }

  function confirmPost(data) {
    var confirmtext =
      'Please verify that the data entered is correct: ' +
      '\nEvent type: ' + data.eventType;
    confirmtext += data.glucose ? '\nBlood glucose: ' + data.glucose + '\nMethod: ' + data.glucoseType : '';
    confirmtext += data.carbs ? '\nCarbs Given: ' + data.carbs : '';
    confirmtext += data.insulin ? '\nInsulin Given: ' + data.insulin : '';
    confirmtext += data.preBolus ? '\nPre Bolus: ' + data.preBolus : '';
    confirmtext += data.notes ? '\nNotes: ' + data.notes : '';
    confirmtext += data.enteredBy ? '\nEntered By: ' + data.enteredBy : '';
    confirmtext += data.eventTime ? '\nEvent Time: ' + data.eventTime.format('LLL') : '';

    if (window.confirm(confirmtext)) {
      var dataJson = JSON.stringify(data, null, ' ');
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/v1/treatments/', true);
      xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
      xhr.send(dataJson);

      browserStorage.set('enteredBy', data.enteredBy);

      closeDrawer('#treatmentDrawer');
    }
  }

  $('#treatmentDrawerToggle').click(function (event) {
    toggleDrawer('#treatmentDrawer', initTreatmentDrawer);
    event.preventDefault();
  });

  $('#treatmentDrawer').find('button').click(treatmentSubmit);

  $('#eventTime input:radio').change(function (event) {
    if ($('#othertime').is(':checked')) {
      $('#eventTimeValue').focus();
    }
    event.preventDefault();
  });

  $('.eventinput').focus(function (event) {
    $('#othertime').prop('checked', true);
    var moment = Nightscout.utils.mergeInputTime($('#eventTimeValue').val(), $('#eventDateValue').val());
    $(this).attr('oldminutes', moment.minutes());
    $(this).attr('oldhours', moment.hours());
    event.preventDefault();
  });

  $('.eventinput').change(function (event) {
    $('#othertime').prop('checked', true);
    var moment = Nightscout.utils.mergeInputTime($('#eventTimeValue').val(), $('#eventDateValue').val());
    if ($(this).attr('oldminutes') === ' 59' && moment.minutes() === 0) {
      moment.add(1, 'hours');
    }
    if ($(this).attr('oldminutes') === '0' && moment.minutes() === 59) {
      moment.add(-1, 'hours');
    }
    $('#eventTimeValue').val(moment.format('HH:mm'));
    $('#eventDateValue').val(moment.format('YYYY-MM-D'));
    $(this).attr('oldminutes', moment.minutes());
    $(this).attr('oldhours', moment.hours());
    event.preventDefault();
  });
})();