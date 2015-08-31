'use strict';
var translate = require('../language')().translate;

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
      '<h1>' + translate('Treatments') + '</h1>'
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
    + '      <label for="rped_insulinGiven">'
    + '          <span class="translate">Insulin Given</span>'
    + '          <input type="number" step="0.05" min="0" id="rped_insulinGiven" placeholder="' + translate('Amount in units') + '"/>'
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
    
treatments.report = function report_treatments(datastorage, daystoshow, options) {
  var Nightscout = window.Nightscout;
  var report_plugins = Nightscout.report_plugins;
  
  function deleteTreatment(event) {
    if (!client.hashauth.isAuthenticated()) {
      alert(translate('Your device is not authenticated yet'));
      return false;
    }
    
    var data = JSON.parse($(this).attr('data'));
    var day = $(this).attr('day');

    var ok = window.confirm(
        translate('Delete this treatment?')+'\n' +
        '\n'+translate('Event Type')+': ' + translate(resolveEventName(data.eventType)) +
        (data.glucose ? '\n'+translate('Blood Glucose')+': ' + data.glucose : '')+
        (data.glucoseType ? '\n'+translate('Method')+': ' + data.glucoseType : '')+
        (data.carbs ? '\n'+translate('Carbs Given')+': ' + data.carbs : '' )+
        (data.insulin ? '\n'+translate('Insulin Given')+': ' + data.insulin : '')+
        (data.preBolus ? '\n'+translate('Pre Bolus')+': ' + data.preBolus : '')+
        (data.notes ? '\n'+translate('Notes')+': ' + data.notes : '' )+
        (data.enteredBy ? '\n'+translate('Entered By')+': ' + data.enteredBy : '' )+
        ('\n'+translate('Event Time')+': ' + new Date(data.created_at).toLocaleString())
    );

    if (ok) {
      deleteTreatmentRecord(data._id);
      delete datastorage[day];
      report_plugins.show();
    }
    if (event) {
      event.preventDefault();
    }
    return false;
  }

  function deleteTreatmentRecord(_id) {
    var xhr = new XMLHttpRequest();
    xhr.open('DELETE', '/api/v1/treatments/'+_id, true);
    xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
    xhr.setRequestHeader('api-secret', client.hashauth.hash());
    xhr.onload = function () {
      if (xhr.statusText!=='OK') {
        alert(translate('Deleting record failed'));
      }
    };
    xhr.send(null);
    return true;
  }

  function editTreatment(event) {
    var data = JSON.parse($(this).attr('data'));
    var day = $(this).attr('day');

    // prepare event list
    $('#rped_eventType').empty();
    _.each(client.careportal.events, function eachEvent(event) {
      $('#rped_eventType').append('<option value="' + event.val+ '">' + translate(event.name) + '</option>');
    });

    $( '#rp_edittreatmentdialog' ).dialog({
        width: 350
      , height: 500
      ,  buttons: [
        { text: translate('Save'),
          class: 'leftButton',
          click: function() {
            data.eventType = $('#rped_eventType').val();
            data.glucose = $('#rped_glucoseValue').val();
            data.glucoseType = $('#rp_edittreatmentdialog').find('input[name=rp_bginput]:checked').val();
            data.carbs = $('#rped_carbsGiven').val();
            data.insulin = $('#rped_insulinGiven').val();
            data.notes = $('#rped_adnotes').val();
            data.enteredBy = $('#rped_enteredBy').val();
            data.created_at = client.utils.mergeInputTime($('#rped_eventTimeValue').val(), $('#rped_eventDateValue').val());
            data.units = options.units;
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
        $('#rped_insulinGiven').val(data.insulin ? data.insulin : '');
        $('#rped_adnotes').val(data.notes ? data.notes : '');
        $('#rped_enteredBy').val(data.enteredBy ? data.enteredBy : '');
        $('#rped_eventTimeValue').val(moment(data.created_at).format('HH:mm'));
        $('#rped_eventDateValue').val(moment(data.created_at).format('YYYY-MM-DD'));
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
      alert(translate('Your device is not authenticated yet'));
      return false;
    }
 
    var dataJson = JSON.stringify(data, null, ' ');

    var xhr = new XMLHttpRequest();
    xhr.open('PUT', '/api/v1/treatments/', true);
    xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
    xhr.setRequestHeader('api-secret', client.hashauth.hash());
    xhr.onload = function () {
      if (xhr.statusText!=='OK') {
        alert(translate('Saving record failed'));
      }
    };
    xhr.send(dataJson);
    return true;
  }

  function resolveEventName(value) {
    _.each(Nightscout.client.careportal.events, function eachEvent(e) {
      if (e.val === value) {
        value = e.name;
      }
    });
    return value;
  }

  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var report_plugins = Nightscout.report_plugins;

  var icon_remove = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACrElEQVQ4T42Ty2sTQRzHv5tmk2yyjRNtpfZhL8V6s2KoUNC2XqwgaCsVQcGiFqpHi0c9iRdR/ANE9KR40FIQX4cueKoPaKFoLdSYNtE0abKT1+5s9iW7aUMiHtzTzO7v85md+c6PA4DrHbsPCKIgOWO1pA7dT6YXnXH949SE/F63pqwZtRrO+SCKgjQ5NUV+azpmHj2krMwaJC4c8Erj+/eRyloMMwWFKgbn1nC3ervlK1evkXBLGBZT8SOewotnTylTNLdgeg/pDgZDC2cPHSR8bB22DVC9hFe0SG/H0xFXcHlykjRHRDBWgJcZSCY38Xx2lhqMnRYE34Px/sN9vlQWeoHBAx2yXsRruVAVuFsIBaSJ8+eJGPaBqQV4NROJjTzez89jLBoFn6FgybQL54wS3uTyVDFQ3cL2IYpBv3RhdJSIIQ80tQyv7gEqJvS8AmUlBs7UXPhtjtZgh3UFNYngk86NHCfNAg9dMwHVBPu+CpsVkTXKeJeVG+AGgTOZ3tt6MSKKjy+NjEBjFrR4ElZmA4pdxstMFsyyJu6tZZ7Ux9vwB6EAL50ZGiRECEPPUOixVTRxHlicgSVWxEdZpuZWfNuS2hk48NjwMIkIYZglBnV5Cbqtws/5IaAJmsfCglrEl2y2QeKmEBJ80tixKmxrFpSVr0gV0viQoxho2YUuPohmeFD22PiklLC4ma5JuBvdrfLJI0dJd0s7bM0ES8aR/BXDXGaTskqlL+D3Lwy0tZEePoAd4EA5YF4tYymdonfjmQh3s6dTPjU4SHYGwjAKecSXFyGlM1TdytntE56T+ts7SC/vhw3gm6njc2Kd3vm5Ub1IwQAvnYhGiZpYw1wiWYPrIw7wnBTt7CLOOwdmut14kQQvqt24tfK/utGR6LaF+iRqMf4N/O/8D28HiiCRYqzAAAAAAElFTkSuQmCC';
  var icon_edit = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABEUlEQVQ4jZ3MMUsCYQDG8ee8IySQbNCLyyEKG/RLNAXicqvQcAeNLrcFLlE0+xHuNpt8wy04rrYm8Q4HQRE56BSC3lSqU1BwCoxM39dnffj9BWyxXvVeEzvtctBwHyRebNu2Nk2lzMlrgJB+qBEeTByiKYpihl+fIO8jTI9PDJEVF1+K2iw+M6PhDuyag4NkQi/c3FkCK5Z3ZbM76qLltpCbn+vXxq0FABsDy9hzPdBvqvtXvvXzrw1swmsDLPjfACteGeDBfwK8+FdgGwwAIgC0ncsjxGRSH/eiPBgAJADY2z8sJ4JBfNBsDqlADVYMANIzKalv/bHaefKsTH9iPFb8ISsGAJym0+Qinz3jQktbAHcxvx3559eSAAAAAElFTkSuQmCC';

  var table = '<table>';
  table += '<tr style="background:gray"><th></th><th style="width:80px" align="left">'+translate('Time')+'</th><th style="width:150px" align="left">'+translate('Event Type')+'</th><th style="width:150px" align="left">'+translate('Blood Glucose')+'</th><th style="width:50px" align="left">'+translate('Insulin')+'</th><th style="width:50px" align="left">'+translate('Carbs')+'</th><th style="width:150px" align="left">'+translate('Entered By')+'</th><th style="width:300px" align="left">'+translate('Notes')+'</th></tr>';
  
  Object.keys(daystoshow).forEach(function (day) {
    table += '<tr><td></td><td colspan="7"><b>'+report_plugins.utils.localeDate(day)+'</b></td></tr>';
    var treatments = datastorage[day].treatments;
    for (var t=0; t<treatments.length; t++) {
      var tr = treatments[t];
      table += '<tr class="border_bottom">';
      table += '<td>';
      table += '<img style="cursor:pointer" title="'+translate('Delete record')+'" src="'+icon_remove+'" href="#" class="deleteTreatment" data=\''+JSON.stringify(tr)+'\' day="'+day+'">';
      table += '&nbsp;';
      table += '<img style="cursor:pointer" title="'+translate('Edit record')+'" src="'+icon_edit+'" href="#" class="editTreatment" data=\''+JSON.stringify(tr)+'\' day="'+day+'">';
      table += '</td>';
      table += '<td>'+(new Date(tr.created_at).toLocaleTimeString().replace(/([\d]+:[\d]{2})(:[\d]{2})(.*)/, '$1$3'))+'</td>';
      table += '<td>'+(tr.eventType ? translate(resolveEventName(tr.eventType)) : '')+'</td>';
      table += '<td align="center">'+(tr.glucose ? tr.glucose + ' ('+translate(tr.glucoseType)+')' : '')+'</td>';
      table += '<td align="center">'+(tr.insulin ? tr.insulin : '')+'</td>';
      table += '<td align="center">'+(tr.carbs ? tr.carbs : '')+'</td>';
      table += '<td>'+(tr.enteredBy ? tr.enteredBy : '')+'</td>';
      table += '<td>'+(tr.notes ? tr.notes : '')+'</td>';
      
      table += '</tr>';
    }
  });
  $('#treatments-report').html(table);
  $('.deleteTreatment').click(deleteTreatment);
  $('.editTreatment').click(editTreatment);
};
  
