'use strict';

var moment = window.moment;
var toTextContent = require('../utils/html').toTextContent;
var treatmentTime = require('../client/treatmenttime');

var treatments = {
  name: 'treatments'
  , label: 'Treatments'
  , pluginType: 'report'
};

function init() {
  return treatments;
}

module.exports = init;

treatments.html = function html(client) {
  var translate = client.translate;
  var ret =
      '<h2>' + translate('Treatments') + '</h2>'
    + '<b class="treatment-report-hint">' + translate('To see this report, press SHOW while in this view') + '</b>'
    + '<div id="treatments-report"></div>'
    ;
  ret +=
      '<div id="rp_edittreatmentdialog" style="display:none" title="' + translate('Edit treatment') + '">'
    + '      <label for="rped_eventType">'
    + translate('Event Type')
    + '         <select id="rped_eventType"></select>'
    + '      </label>'
    + '      <fieldset>'
    + '          <legend>' + translate('Glucose Reading') + '</legend>'
    + '          <input type="number" step="any" id="rped_glucoseValue" />'
    + '          <label><br>' + translate('Measurement Method') + '<br></label>'
    + '          <input type="radio" name="rp_bginput" id="rped_bgfromsensor"  value="Sensor">'
    + '          <i title="' + translate('BG from CGM') + '" class="icon-chart-line" style="margin-right:0;margin-left:-0.6em;color:lightgreen"></i>'
    + '          <input type="radio" name="rp_bginput" id="rped_bgfrommeter"  value="Finger">'
    + '          <i title="' + translate('BG from meter') + '" class="icon-tint" style="margin-right:0;margin-left:-0.6em;color:red"></i>'
    + '          <input type="radio" name="rp_bginput" id="rped_bgmanual" value="Manual">'
    + '          <i title="' + translate('Manual BG') + '" class="icon-sort-numeric" style="margin-right:0;margin-left:-0.6em;color:blue"></i>'
    + '      </fieldset>'
    + '      <label for="rped_carbsGiven">'
    + translate('Carbs Given')
    + '          <input type="number" step="any" min="0" id="rped_carbsGiven" placeholder="' + translate('Amount in grams') + '" />'
    + '      </label>'
    + '      <br>'
    + '      <label for="rped_proteinGiven">'
    + translate('Protein')
    + '          <input type="number" step="any" min="0" id="rped_proteinGiven" placeholder="' + translate('Amount in grams') + '" />'
    + '      </label>'
    + '      <br>'
    + '      <label for="rped_fatGiven">'
    + translate('Fat')
    + '          <input type="number" step="any" min="0" id="rped_fatGiven" placeholder="' + translate('Amount in grams') + '" />'
    + '      </label>'
    + '      <br>'
    + '      <label for="rped_insulinGiven">'
    + translate('Insulin Given')
    + '          <input type="number" step="0.05" min="0" id="rped_insulinGiven" placeholder="' + translate('Amount in units') + '"/>'
    + '      </label>'
    + '      <br>'
    + '      <label for="rped_duration">'
    + translate('Duration')
    + '          <input type="number" step="1" min="0" id="rped_duration" placeholder="' + translate('Duration in minutes') + '"/>'
    + '      </label>'
    + '      <br>'
    + '      <label for="rped_percent">'
    + translate('Percent')
    + '          <input type="number" step="10" id="rped_percent" placeholder="' + translate('Basal change in %') + '"/>'
    + '      </label>'
    + '      <br>'
    + '      <label for="rped_absolute">'
    + translate('Basal value')
    + '          <input type="number" step="0.05" id="rped_absolute" placeholder="' + translate('Absolute basal value') + '"/>'
    + '      </label>'
    + '      <br>'
    + '      <label for="rped_profile">'
    + translate('Profile')
    + '          <select id="rped_profile" /></select>'
    + '      </label>'
    + '      <br>'
    + '      <label for="rped_adnotes">' + translate('Additional Notes, Comments') + '</label>'
    + '      <textarea id="rped_adnotes" style="width:300px"></textarea><br>'
    + '      <label for="rped_enteredBy" class="left-column extra-space">'
    + translate('Entered By')
    + '        <input type="text" id="rped_enteredBy" value="" />'
    + '      </label>'
    + '      <div id="rp_eventTime">'
    + translate('Event Time')
    + '        <br>'
    + '        <input type="date" id="rped_eventDateValue" class="rp_eventinput"/>'
    + '        <input type="time" id="rped_eventTimeValue" class="rp_eventinput"/>'
    + '     </div>'
    + '   </div>'
    ;

  return ret;
};

// Sentinels for the two dropdown entries that are not themselves an event
// type. The NUL prefix keeps them distinct from any uploader-supplied value.
var ALL_EVENT_TYPES = '\u0000all';
var NO_EVENT_TYPE = '\u0000none';

// Kept across renders so pressing SHOW again preserves the chosen event type.
var selectedEventType = ALL_EVENT_TYPES;

treatments.report = function report_treatments(datastorage, sorteddaystoshow, options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var report_plugins = Nightscout.report_plugins;
  var profile = client.sbx.data.profile;
  var premium = client.settings.theme === 'modern';
  var modernRowSequence = 0;

  function buildConfirmText(data) {
    var text = [
        translate('Delete this treatment?')+'\n'
        , '\n'+translate('Event Type')+': ' + translate(client.careportal.resolveEventName(data.eventType))
    ];

    function pushIf (check, valueText) {
      if (check) {
        text.push(valueText);
      }
    }

    pushIf(data.glucose, translate('Blood Glucose') + ': ' + data.glucose);
    pushIf(data.glucoseType, translate('Measurement Method') + ': ' + translate(data.glucoseType));

    pushIf(data.carbs, translate('Carbs Given') + ': ' + data.carbs);
    pushIf(data.protein, translate('Protein') + ': ' + data.protein);
    pushIf(data.fat, translate('Fat') + ': ' + data.fat);
    pushIf(data.insulin, translate('Insulin Given') + ': ' + data.insulin);
    pushIf(data.duration, translate('Duration') + ': ' + data.duration);
    pushIf(data.percent, translate('Percent') + ': ' + data.percent);
    pushIf(!isNaN(data.absolute), translate('Basal value') + ': ' + data.absolute);
    pushIf(data.preBolus, translate('Carb Time') + ': ' + data.preBolus + ' ' + translate('mins'));
    pushIf(data.notes, translate('Notes') + ': ' + data.notes);
    pushIf(data.enteredBy, translate('Entered By') + ': ' + data.enteredBy);

    var eventTime = data.eventTime || data.created_at;
    text.push(translate('Event Time') + ': ' + (eventTime ? profile.applyTimezone(moment(eventTime)).format('L LT') : profile.applyTimezone(moment()).format('L LT')));
    return text.join('\n');
  }

  function deleteTreatment(event) {
    $(this).closest('details.treatment-menu').prop('open', false);
    if (!client.hashauth.isAuthenticated()) {
      window.alert(translate('Your device is not authenticated yet'));
      return false;
    }

    var data = JSON.parse($(this).attr('data'));
    var day = $(this).attr('day');

    if (window.confirm(buildConfirmText(data))) {
      $.ajax({
        method: 'DELETE'
      , url: '/api/v1/treatments/' + data._id
      , headers: client.headers()
      }).done(function treatmentDeleted (response) {
        console.info('treatment deleted', response);
      }).fail(function treatmentDeleteFail (response) {
        console.info('treatment delete failed', response);
        window.alert(translate('Deleting record failed') + '. ' + translate('Status') + ': ' + response.status);
      });
      delete datastorage[day];
      report_plugins.show();
    }
    maybePrevent(event);
    return false;
  }

  function editTreatment(event) {
    var data = JSON.parse($(this).attr('data'));
    var day = $(this).attr('day');    // prepare event list
    $('#rped_eventType').empty();
    client.careportal.events?.forEach(function eachEvent(event) {
      if (event.name.indexOf('Temp Basal') > -1) {
        return;
      }
      $('#rped_eventType').append('<option value="' + event.val+ '">' + translate(event.name) + '</option>');
    });
    $('#rped_eventType').append('<option value="Temp Basal">' + translate('Temp Basal') + '</option>');
    $('#rped_eventType').append('<option value="Bolus Wizard">' + translate('Bolus Wizard') + '</option>');

    var profileSelect = $('#rped_profile').empty();
    profileSelect.append($('<option>').val(''));
    client.profilefunctions.listBasalProfiles().forEach(function (p) {
      profileSelect.append($('<option>').val(p).text(toTextContent(p)));
    });

    $( '#rp_edittreatmentdialog' ).dialog({
        width: 360
      , height: 600
      ,  buttons: [
        { text: translate('Save'),
          class: 'leftButton',
          click: function() {
            data.eventType = $('#rped_eventType').val();
            data.glucose = $('#rped_glucoseValue').val();
            data.glucoseType = $('#rp_edittreatmentdialog').find('input[name=rp_bginput]:checked').val();
            data.carbs = $('#rped_carbsGiven').val();
            data.protein = $('#rped_proteinGiven').val();
            data.fat = $('#rped_fatGiven').val();
            data.insulin = $('#rped_insulinGiven').val();
            data.duration = $('#rped_duration').val();
            data.percent = $('#rped_percent').val();
            data.absolute = $('#rped_absolute').val();
            data.profile = $('#rped_profile').val();
            data.notes = $('#rped_adnotes').val();
            data.enteredBy = $('#rped_enteredBy').val();
            data.eventTime = profile.parseInTimezone($('#rped_eventDateValue').val() + 'T' + $('#rped_eventTimeValue').val()).toISOString();
            data.units = options.units;
            treatmentTime.alignEditedRecord(data, data.eventTime);
            delete data.created_at;
            if (data.absolute === '') {
              delete data.absolute;
            }
            $( this ).dialog('close');
            saveTreatmentRecord(data);
            delete datastorage[day];
            report_plugins.show();
          }
        },
        { text: translate('Cancel'),
           click: function () { $( this ).dialog('close'); }
        }
      ]
      , open   : function() {
        $(this).parent().css('box-shadow', '20px 20px 20px 0px black');
        $(this).parent().find('.ui-dialog-buttonset'      ).css({'width':'100%','text-align':'right'});
        $(this).parent().find('button:contains("'+translate('Save')+'")').css({'float':'left'});
        $('#rped_eventType').val(data.eventType);
        $('#rped_glucoseValue').val(data.glucose ? data.glucose : '').attr('placeholder', translate('Value in') + ' ' + options.units);
        $('#rped_bgfromsensor').prop('checked', data.glucoseType === 'Sensor');
        $('#rped_bgfrommeter').prop('checked', data.glucoseType === 'Finger');
        $('#rped_bgmanual').prop('checked', data.glucoseType === 'Manual');
        $('#rped_carbsGiven').val(data.carbs ? data.carbs : '');
        $('#rped_proteinGiven').val(data.protein ? data.protein : '');
        $('#rped_fatGiven').val(data.fat ? data.fat : '');
        $('#rped_insulinGiven').val(data.insulin ? data.insulin : '');
        $('#rped_duration').val(data.duration ? data.duration : '');
        $('#rped_percent').val(data.percent ? data.percent : '');
        $('#rped_absolute').val('absolute' in data ? data.absolute : '');
        $('#rped_profile').val(data.profile ? data.profile : '');
        $('#rped_adnotes').val(data.notes ? data.notes : '');
        $('#rped_enteredBy').val(data.enteredBy ? data.enteredBy : '');
        var eventTime = profile.applyTimezone(moment(data.created_at));
        $('#rped_eventTimeValue').val(eventTime.format('HH:mm'));
        $('#rped_eventDateValue').val(eventTime.format('YYYY-MM-DD'));
        $('#rped_eventType').focus();
      }

    });

    if (event) {
      event.preventDefault();
    }
    return false;
  }

  function saveTreatmentRecord(data) {
    if (!client.hashauth.isAuthenticated()) {
      window.alert(translate('Your device is not authenticated yet'));
      return false;
    }

    $.ajax({
      method: 'PUT'
    , url: '/api/v1/treatments/'
    , headers: client.headers()
    , data: data
    }).done(function treatmentSaved (response) {
      console.info('treatment saved', response);
    }).fail(function treatmentSaveFail (response) {
      console.info('treatment save failed', response);
      window.alert(translate('Saving record failed') + '. ' + translate('Status') + ': ' + response.status);
    });

    return true;
  }

  function maybePrevent (event) {
    if (event) {
      event.preventDefault();
    }
    return false;
  }

  var icon_remove = '/images/report-delete.png';
  var icon_edit = '/images/report-edit.png';

  function headerRow () {
    return $('<tr>').css('background','gray')
      .append($('<th>'))
      .append($('<th>').css('width','80px').attr('align','left').append(translate('Time')))
      .append($('<th>').css('width','150px').attr('align','left').append(translate('Event Type')))
      .append($('<th>').css('width','150px').attr('align','left').append(translate('Blood Glucose')))
      .append($('<th>').css('width','50px').attr('align','left').append(translate('Insulin')))
      .append($('<th>').css('width','100px').attr('align','left').append(translate('Carbs/Food/Time')))
      .append($('<th>').css('width','50px').attr('align','left').append(translate('Protein')))
      .append($('<th>').css('width','50px').attr('align','left').append(translate('Fat')))
      .append($('<th>').css('width','50px').attr('align','left').append(translate('Duration')))
      .append($('<th>').css('width','50px').attr('align','left').append(translate('Percent')))
      .append($('<th>').css('width','50px').attr('align','left').append(translate('Basal value')))
      .append($('<th>').css('width','50px').attr('align','left').append(translate('Profile')))
      .append($('<th>').css('width','150px').attr('align','left').append(translate('Entered By')))
      .append($('<th>').css('width','300px').attr('align','left').append(translate('Notes')));
  }

  function modernHeaderRow () {
    var row = $('<tr>');
    [['Time', ''], ['Event Type', ''], ['Glucose', options.units === 'mmol' ? 'mmol/L' : 'mg/dL'],
      ['Insulin', 'U'], ['Carbs', 'g'], ['Basal rate', 'U/h'], ['Duration', 'min'], ['Entered By', ''],
      ['Notes', ''], ['Actions', ''], ['Details', '']].forEach(function(column, index) {
      var cell = $('<th scope="col">').text(translate(column[0])).appendTo(row);
      if (column[1]) $('<small>').text(column[1]).appendTo(cell);
      if (index === 10) cell.addClass('treatment-details-heading');
    });
    return row;
  }

  function dayRow (day) {
    if (premium) return $('<tr class="treatment-day-row">').append($('<th scope="rowgroup" colspan="11">').text(report_plugins.utils.localeDate(day)));
    return $('<tr>')
      .append($('<td>').attr('colspan','12').css('background','lightgray')
        .append($('<b>').append(report_plugins.utils.localeDate(day)))
      );
  }

  function treatmentRow (tr, day) {
    var carbs = tr.carbs ? tr.carbs : '';
    carbs += tr.foodType ? ' ' + tr.foodType : '';
    carbs += tr.absorptionTime ? ' ' + (Math.round(tr.absorptionTime / 60.0 * 10) / 10) + 'h' : '';
    var correctionRangeText = '';
    if (tr.correctionRange) {
      var min = tr.correctionRange[0];
      var max = tr.correctionRange[1];

      if (client.settings.units === 'mmol') {
        max = client.utils.roundBGForDisplay(client.utils.scaleMgdl(max));
        min = client.utils.roundBGForDisplay(client.utils.scaleMgdl(min));
      }

      if (tr.correctionRange[0] === tr.correctionRange[1]) {
        correctionRangeText = '' + min;
      } else {
        correctionRangeText = '' + min + ' - ' + max;
      }
    }
    var eventCell = $('<td>');
    if (tr.eventType) {
      eventCell.text(toTextContent(translate(client.careportal.resolveEventName(tr.eventType))));
      if (tr.reason) {
        eventCell.append($('<br>')).append($('<span>').text(toTextContent(tr.reason)));
      }
      if (tr.insulinNeedsScaleFactor) {
        eventCell.append($('<br>')).append($('<span>').text(tr.insulinNeedsScaleFactor * 100 + '%'));
      }
      if (tr.correctionRange) {
        eventCell.append($('<span>').text(' ' + toTextContent(correctionRangeText)));
      }
    }

    var actions = $('<td>');
    if (!premium) actions
      .append($('<img>').addClass('deleteTreatment').css('cursor','pointer').attr('title',translate('Delete record')).attr('src',icon_remove).attr('data',JSON.stringify(tr)).attr('day',day))
      .append('&nbsp;')
      .append($('<img>').addClass('editTreatment').css('cursor','pointer').attr('title',translate('Edit record')).attr('src',icon_edit).attr('data',JSON.stringify(tr)).attr('day',day));
    return $('<tr>').addClass('border_bottom')
      .append(actions)
      .append($('<td>').text(profile.applyTimezone(moment(tr.created_at)).format(client.settings.timeFormat === 24 ? 'HH:mm' : 'h:mm A')))
      .append(eventCell)
      .append($('<td>').attr('align','center').text(toTextContent(tr.glucose
        ? tr.glucose + (tr.glucoseType ? ' (' + translate(tr.glucoseType) + ')' : '')
        : '')))
      .append($('<td>').attr('align','center').text(tr.insulin ? tr.insulin.toFixed(2) : ''))
      .append($('<td>').attr('align','center').text(toTextContent(carbs)))
      .append($('<td>').attr('align','center').text(toTextContent(tr.protein ? tr.protein : '')))
      .append($('<td>').attr('align','center').text(toTextContent(tr.fat ? tr.fat : '')))
      .append($('<td>').attr('align','center').text(tr.duration ? tr.duration.toFixed(0) : ''))
      .append($('<td>').attr('align','center').text(toTextContent(tr.percent ? tr.percent : '')))
      .append($('<td>').attr('align','center').text('absolute' in tr ? tr.absolute.toFixed(2) : ''))
      .append($('<td>').attr('align','center').text(toTextContent(tr.profile ? tr.profile : '')))
      .append($('<td>').text(toTextContent(tr.enteredBy ? tr.enteredBy : '')))
      .append($('<td>').text(toTextContent(tr.notes ? tr.notes : '')));
  }

  function actionIcon (path) {
    return '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="' + path + '"></path></svg>';
  }

  function modernTreatmentRow (tr, day, index) {
    var cells = treatmentRow(tr, day).children('td').detach();
    var row = $('<tr class="border_bottom treatment-data-row">').toggleClass('treatment-alt', index % 2 === 1);
    var id = 'treatment-details-' + (++modernRowSequence);
    var detail = $('<tr class="treatment-detail-row" hidden>').attr('id', id);
    var detailCell = $('<td colspan="11">').appendTo(detail);
    var kind = tr.carbs ? 'meal' : tr.eventType === 'Temp Basal' ? 'basal' : tr.insulin ? 'insulin' : 'neutral';
    var correction = Array.isArray(tr.correctionRange) && tr.correctionRange.map(function(value) {
      return options.units === 'mmol' ? client.utils.roundBGForDisplay(client.utils.scaleMgdl(value)) : value;
    }).join(' – ');
    cells.eq(2).empty().append($('<span>').addClass('treatment-badge treatment-badge-' + kind)
      .text(tr.eventType ? toTextContent(translate(client.careportal.resolveEventName(tr.eventType))) : translate('(none)')));
    var glucose = cells.eq(3);
    if (Number.isFinite(Number(tr.glucose)) && tr.glucose !== undefined && tr.glucose !== null && tr.glucose !== '') {
      var displayed = Number(tr.glucose) > 0 ? report_plugins.utils.scaledTreatmentBG(tr, []) : 0;
      glucose.text(client.utils.roundBGForDisplay(displayed));
    }
    cells.eq(5).text(tr.carbs === undefined || tr.carbs === null || tr.carbs === '' ? '' : toTextContent(tr.carbs));
    cells.eq(13).wrapInner('<span class="treatment-note-preview"></span>');
    [1, 2, 3, 4, 5, 10, 8, 12, 13].forEach(function(sourceIndex, column) {
      var cell = cells.eq(sourceIndex).appendTo(row).addClass('treatment-col-' + column).removeAttr('align');
      if (!cell.text().trim()) cell.text('—').addClass('treatment-empty');
    });
    var actions = $('<td class="treatment-actions">').appendTo(row);
    function button (name, className) {
      return $('<button type="button">').addClass(className).attr({title: translate(name), 'aria-label': translate(name), data: JSON.stringify(tr), day: day});
    }
    button('Edit record', 'editTreatment treatment-action').html(actionIcon('M14 5l5 5M4 20l4-1L20 7a2.1 2.1 0 0 0-3-3L5 16z')).appendTo(actions);
    var menu = $('<details class="treatment-menu">').appendTo(actions);
    $('<summary>').attr({'aria-label': translate('More actions'), title: translate('More actions')})
      .text('⋯').appendTo(menu);
    button('Delete record', 'deleteTreatment').text(translate('Delete record')).appendTo(menu);
    var toggle = $('<button type="button" class="treatment-action treatment-detail-toggle">')
      .attr({'aria-controls': id, 'aria-expanded': 'false', 'aria-label': translate('Show details'), title: translate('Show details')})
      .html(actionIcon('M6 9l6 6 6-6')).appendTo($('<td class="treatment-disclosure">').appendTo(row));
    toggle.on('click', function() {
      var open = toggle.attr('aria-expanded') !== 'true';
      if (open && !detailCell.children().length) {
        var list = $('<dl class="treatment-detail-grid">').appendTo(detailCell);
        [['Protein', tr.protein, 'g'], ['Fat', tr.fat, 'g'], ['Percent', tr.percent, '%'], ['Profile', tr.profile, ''],
          ['Food', tr.foodType, ''], ['Absorption', tr.absorptionTime === undefined ? undefined : client.utils.toRoundedStr(tr.absorptionTime / 60, 1), 'h'],
          ['Carb Time', tr.preBolus, 'min'], ['Measurement Method', tr.glucoseType, ''], ['Reason', tr.reason, ''],
          ['Insulin needs', tr.insulinNeedsScaleFactor === undefined ? undefined : tr.insulinNeedsScaleFactor * 100, '%'],
          ['Correction range', correction || undefined, ''], ['Notes', tr.notes, '']].forEach(function(field) {
          if (field[1] === undefined || field[1] === null || field[1] === '') return;
          var group = $('<div>').toggleClass('treatment-detail-notes', field[0] === 'Notes').appendTo(list);
          $('<dt>').text(translate(field[0])).appendTo(group);
          $('<dd>').text(toTextContent(String(field[1])) + (field[2] ? ' ' + field[2] : '')).appendTo(group);
        });
        if (!list.children().length) $('<p>').text(translate('No additional details')).appendTo(detailCell);
      }
      detail.prop('hidden', !open);
      row.toggleClass('is-expanded', open);
      toggle.attr({'aria-expanded': String(open), 'aria-label': translate(open ? 'Hide details' : 'Show details'), title: translate(open ? 'Hide details' : 'Show details')});
    });
    return [row[0], detail[0]];
  }

  function eventTypeKey (tr) {
    return tr.eventType ? tr.eventType : NO_EVENT_TYPE;
  }

  function eventTypeLabel (key) {
    var label = key === NO_EVENT_TYPE ? translate('(none)') : translate(client.careportal.resolveEventName(key));
    return toTextContent(label);
  }

  // A day is dropped from datastorage once it is only needed for the previous
  // day's treatments, so a filter change on an already rendered table skips it.
  function reportedDays () {
    return sorteddaystoshow.filter(function loaded (day) {
      return datastorage[day] && datastorage[day].treatments;
    });
  }

  // Counted over the days the day filters let through, so the dropdown only
  // ever offers event types that are present in the result.
  function eventTypeCounts () {
    var counts = Object.create(null);
    reportedDays().forEach(function eachDay (day) {
      datastorage[day].treatments.forEach(function eachTreatment (tr) {
        var key = eventTypeKey(tr);
        counts[key] = (counts[key] || 0) + 1;
      });
    });
    return counts;
  }

  function dayTreatments (day) {
    var treatments = [...datastorage[day].treatments];
    if (options.order === report_plugins.consts.ORDER_NEWESTONTOP) {
      treatments.reverse();
    }
    if (selectedEventType !== ALL_EVENT_TYPES) {
      treatments = treatments.filter(function matchesFilter (tr) {
        return eventTypeKey(tr) === selectedEventType;
      });
    }
    return treatments;
  }

  function filterBar (counts, shown, total) {
    var select = $('<select>').attr('id','treatments-eventtype');
    select.append($('<option>').attr('value',ALL_EVENT_TYPES).text(translate('All event types') + (premium ? '' : ' (' + total + ')')));
    Object.keys(counts).sort(function byLabel (a, b) {
      return eventTypeLabel(a).localeCompare(eventTypeLabel(b));
    }).forEach(function eachType (key) {
      select.append($('<option>').attr('value',key).text(eventTypeLabel(key) + ' (' + counts[key] + ')'));
    });
    select.val(selectedEventType);
    select.change(function onFilterChange () {
      selectedEventType = $(this).val();
      renderTable();
    });

    return $('<div>').addClass('filterbar')
      .append($('<label>').attr('for','treatments-eventtype').text(translate('Event Type') + ': '))
      .append(select)
      .append($('<span>').addClass('recordcount')
        .text(premium && shown === total ? total + ' ' + translate('records') : translate('Showing %1 of %2 records', { params: [shown, total] })));
  }

  function renderTable () {
    var counts = eventTypeCounts();
    if (!(selectedEventType in counts)) {
      selectedEventType = ALL_EVENT_TYPES;
    }
    var total = Object.keys(counts).reduce(function sum (acc, key) { return acc + counts[key]; }, 0);
    var shown = selectedEventType === ALL_EVENT_TYPES ? total : counts[selectedEventType];

    var table = $('<table>');
    if (premium) table.addClass('treatments-table').append($('<thead>').append(modernHeaderRow()));
    else table.append(headerRow());
    reportedDays().forEach(function eachDay (day) {
      var treatments = dayTreatments(day);
      if (!treatments.length) { return; }
      var group = premium ? $('<tbody>').appendTo(table) : table;
      group.append(dayRow(day));
      treatments.forEach(function eachTreatment (tr, index) {
        group.append(premium ? modernTreatmentRow(tr, day, index) : treatmentRow(tr, day));
      });
    });

    var host = $('#treatments-report').empty();
    if (premium && sorteddaystoshow.length) {
      var days = sorteddaystoshow.slice().sort();
      $('<div class="treatments-period">').text(profile.parseInTimezone(days[0]).format('D MMM YYYY') + ' – ' + profile.parseInTimezone(days[days.length - 1]).format('D MMM YYYY')).appendTo(host);
    }
    host.append(filterBar(counts, shown, total));
    if (premium) $('<div class="treatment-table-wrap" role="region" tabindex="0">').attr('aria-label', translate('Treatments')).append(table).appendTo(host);
    else host.append(table);
    $('.deleteTreatment').click(deleteTreatment);
    $('.editTreatment').click(editTreatment);
  }

  renderTable();
};
