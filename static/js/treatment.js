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

  function buildConfirmText(data) {
    var text = [
      'Please verify that the data entered is correct: '
      , 'Event type: ' + data.eventType
    ];

    if (data.glucose) {
      text.push('Blood glucose: ' + data.glucose);
      text.push('Method: ' + data.glucoseType);
    }

    if (data.carbs) { text.push('Carbs Given: ' + data.carbs); }
    if (data.insulin) { text.push('Insulin Given: ' + data.insulin); }
    if (data.preBolus) { text.push('Insulin Given: ' + data.insulin); }
    if (data.notes) { text.push('Notes: ' + data.notes); }
    if (data.enteredBy) { text.push('Entered By: ' + data.enteredBy); }

    text.push('Event Time: ' + (data.eventTime ? data.eventTime.format('LLL') : moment().format('LLL')));
    return text.join('\n');
  }

  function confirmPost(data) {
    if (window.confirm(buildConfirmText(data))) {
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

  $('#eventTime').find('input:radio').change(function (event) {
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
  })
  .change(function (event) {
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