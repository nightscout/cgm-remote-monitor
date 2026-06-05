'use strict';

var times = require('../times');
var consts = require('../constants');
var Storages = require('js-storage');
var parseDuration = require('../client-core/careportal/duration');

// Pure logic extracted in Track 2 / Phase 5a (see lib/client-core/careportal/).
// The adapter still owns DOM I/O (jQuery, ajax, alerts); these modules own
// shape transforms, validation, and confirm-text construction.
var coreValidate = require('../client-core/careportal/validate');
var coreResolveEventName = require('../client-core/careportal/resolve-event-name');
var coreBuildConfirmText = require('../client-core/careportal/confirm-text');
var coreNormalizeTreatment = require('../client-core/careportal/normalize-treatment');
var coreEventTypes = require('../client-core/careportal/event-types');



/**
 * @typedef {Object} Reason
 * @property {string} name - The name of the reason
 * @property {number} [targetTop] - Optional target top value
 * @property {number} [targetBottom] - Optional target bottom value
 * @property {number} [duration] - Optional duration value
 */

/**
 * @typedef {Object} EventMatrix
 * @property {Reason[]} [reasons] - Array of possible reasons for this event type
 */

/** @type {Object.<string, EventMatrix>} */
var inputMatrix = {};

function init (client, $) {
  var careportal = {};

  var translate = client.translate;
  var storage = Storages.localStorage;
  var units = client.settings.units;

  var eventTime = $('#eventTimeValue');
  var eventDate = $('#eventDateValue');

  function setDateAndTime (time) {
    time = time || client.ctx.moment();
    eventDate.val(time.format('YYYY-MM-DD'));
    eventTime.val(time.format('HH:mm'));
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

  var submitHooks = {};

  function refreshEventTypes() {
    careportal.allEventTypes = client.plugins.getAllEventTypes(client.sbx);

    // Pure shape transforms moved to lib/client-core/careportal/event-types
    // (Track 2 / Phase 5a). Adapter still owns the plugin lookup.
    careportal.events = coreEventTypes.buildEvents(careportal.allEventTypes);
    inputMatrix = coreEventTypes.buildInputMatrix(careportal.allEventTypes);
    submitHooks = coreEventTypes.buildSubmitHooks(careportal.allEventTypes);
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

    // validate the eventType input - should never hit this but bail if we do
    if (!Object.prototype.hasOwnProperty.call(inputMatrix, eventType)) {
      maybePrevent(event);
      return;
    }

    /* eslint-disable security/detect-object-injection */ // verified false positive by check above
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

    // Only add reason options if we have valid reasons
    if (reasons && Array.isArray(reasons) && reasons.length > 0) {
      reasons.forEach(function eachReason (reason) {
        if (reason && reason.name) {
          $('#reason').append('<option value="' + reason.name + '">' + translate(reason.displayName || reason.name) + '</option>');
        }
      });
    }
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
    /* eslint-enable security/detect-object-injection */ // verified false positive

    maybePrevent(event);
  };
  careportal.reasonable = function reasonable () {
    var eventType = $('#eventType').val();
    var reasons = [];

    // validate the eventType input before getting the reasons list
    if (Object.prototype.hasOwnProperty.call(inputMatrix, eventType) &&
        inputMatrix[eventType] &&
        Array.isArray(inputMatrix[eventType]['reasons'])) {
      reasons = inputMatrix[eventType]['reasons'];
    }

    var selected = $('#reason').val();

    // Skip if we have no valid reasons array
    if (!Array.isArray(reasons)) return;

    var reason = reasons.length > 0 ? reasons.find(r => r && r.name === selected) : null;

    // Reset fields if no valid reason is found
    if (!reason) {
      $('#targetTop').val('');
      $('#targetBottom').val('');
      $('#duration').val('');
      return;
    }

    // Only set values if they exist on the reason object
    if (reason.targetTop) {
      $('#targetTop').val(reason.targetTop);
    } else {
      $('#targetTop').val('');
    }

    if (reason.targetBottom) {
      $('#targetBottom').val(reason.targetBottom);
    } else {
      $('#targetBottom').val('');
    }

    if (reason.duration) {
      $('#duration').val(reason.duration);
    } else {
      $('#duration').val('');
    }
  };

  careportal.prepareEvents = function prepareEvents () {
    $('#eventType').empty();
    careportal.events?.forEach(function eachEvent (event) {
      $('#eventType').append('<option value="' + event.val + '">' + translate(event.name) + '</option>');
    });
    $('#eventType').change(careportal.filterInputs);
    $('#reason').change(careportal.reasonable);
    $('#percent').on('input', careportal.filterInputs);
    $('#absolute').on('input', careportal.filterInputs);
    $('#insulinSplitNow').on('input', careportal.adjustSplit);
    $('#insulinSplitExt').on('input', careportal.adjustSplit);

    // Only call filterInputs if there are events and an event type is selected
    if (careportal.events?.length > 0) {
      // Set default event type if none selected
      if (!$('#eventType').val()) {
        $('#eventType').val(careportal.events[0].val);
      }
      careportal.filterInputs();
    }
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
    return coreResolveEventName(value, careportal.events);
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
    // DOM I/O: read every form value into a plain `raw` object,
    // then hand off to the pure normalizer in
    // lib/client-core/careportal/normalize-treatment (Track 2 / Phase 5a).
    var eventType = $('#eventType').val();
    var durationVal = $('#duration').val();
    var durationParsed = times.msecs(parseDuration(durationVal)).mins;

    var raw = {
      enteredBy: $('#enteredBy').val()
      , eventType: eventType
      , otp: $('#otp').val()
      , remoteCarbs: $('#remoteCarbs').val()
      , remoteAbsorption: $('#remoteAbsorption').val()
      , remoteBolus: $('#remoteBolus').val()
      , glucose: $('#glucoseValue').val().replace(',', '.')
      , reason: $('#reason').val()
      , targetTop: $('#targetTop').val().replace(',', '.')
      , targetBottom: $('#targetBottom').val().replace(',', '.')
      , glucoseType: $('#treatment-form').find('input[name=glucoseType]:checked').val()
      , carbs: $('#carbsGiven').val()
      , protein: $('#proteinGiven').val()
      , fat: $('#fatGiven').val()
      , sensorCode: $('#sensorCode').val()
      , transmitterId: $('#transmitterId').val()
      , insulin: $('#insulinGiven').val()
      , duration: durationParsed < 1 ? durationVal : durationParsed
      , percent: $('#percent').val()
      , profile: $('#profile').val()
      , preBolus: $('#preBolus').val()
      , notes: $('#notes').val()
      , units: client.settings.units
      , absoluteRaw: $('#absolute').val()
      , splitNowRaw: $('#insulinSplitNow').val()
      , splitExtRaw: $('#insulinSplitExt').val()
    };

    if ($('#othertime').is(':checked')) {
      raw.eventTime = mergeDateAndTime().toDate();
    }

    return coreNormalizeTreatment(raw, {
      units: units
      , MMOL_TO_MGDL: consts.MMOL_TO_MGDL
      , inputMatrix: inputMatrix
    });
  }

  careportal.save = function save (event) {
    var data = gatherData();
    confirmPost(data);
    maybePrevent(event);
  };

  function validateData (data) {
    return coreValidate(data, { units: units, MMOL_TO_MGDL: consts.MMOL_TO_MGDL });
  }

  function buildConfirmText (data) {
    return coreBuildConfirmText(data, {
      translate: translate
      , units: units
      , resolveEventName: careportal.resolveEventName
      , MMOL_TO_MGDL: consts.MMOL_TO_MGDL
    });
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

    // Can't decipher why the following logic was in place
    // and it's now bugging out and resetting any date set manually
    // so I'm disabling this
    /*
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
    */

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
