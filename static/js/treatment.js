'use strict';

(function () {
  var translate = Nightscout.language.translate;
  
  function initTreatmentDrawer() {
    $('#eventType').val('BG Check');
    $('#glucoseValue').val('').attr('placeholder', translate('Value in') + ' ' + browserSettings.units);
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

    confirmPost(data);

    if (event) {
      event.preventDefault();
    }
  }

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

    text.push(translate('Event Time') + ': ' + (data.eventTime ? data.eventTime.toDate().toLocaleString() : new Date().toLocaleString()));
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
    } else {
      $('#eventTimeValue').val(moment().format('HH:mm'));
      $('#eventDateValue').val(moment().format('YYYY-MM-D'));
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