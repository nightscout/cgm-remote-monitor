'use strict';

const _ = require('lodash');

var subjects = {
  name: 'subjects'
  , label: 'Subjects - People, Devices, etc'
  , pluginType: 'admin'
};

function init () {
  return subjects;
}

module.exports = init;

var $status = null;

subjects.actions = [{
  description: 'Each subject will have a unique access token and 1 or more roles.  Click on the access token to open a new view with the selected subject, this secret link can then be shared.'
  , buttonLabel: 'Add new Subject'
  , init: function init (client, callback) {
    $status = $('#admin_' + subjects.name + '_0_status');
    $status.hide().text(client.translate('Loading database ...')).fadeIn('slow');
    var table = $('<table id="admin_subjects_table">').css('margin-top', '10px');
    $('#admin_' + subjects.name + '_0_html').append(table).append(genDialog(client));
    reload(client, callback);
  }
  , preventClose: true
  , code: function createNewSubject (client, callback) {
    openDialog({}, client, callback);
  }
}];

function createOrSaveSubject (subject, client, callback) {

  var method = _.isEmpty(subject._id) ? 'POST' : 'PUT';

  $.ajax({
    method: method
    , url: '/api/v2/authorization/subjects/'
    , headers: client.headers()
    , data: subject
  }).done(function success () {
    reload(client, callback);
  }).fail(function fail (err) {
    console.error('Unable to ' + method + ' Subject', err.responseText);
    window.alert(client.translate('Unable to save Subject'));
    if (callback) {
      callback();
    }
  });
}

function deleteSubject (subject, client, callback) {
  $.ajax({
    method: 'DELETE'
    , url: '/api/v2/authorization/subjects/' + subject._id
    , headers: client.headers()
  }).done(function success () {
    reload(client, callback);
  }).fail(function fail (err) {
    console.error('Unable to delete Subject', err.responseText);
    window.alert(client.translate('Unable to delete Subject'));
    if (callback) {
      callback();
    }
  });
}

function reload (client, callback) {
  $.ajax({
    method: 'GET'
    , url: '/api/v2/authorization/subjects'
    , headers: client.headers()
  }).done(function success (records) {
    subjects.records = records;
    $status.hide().text(client.translate('Database contains %1 subjects', { params: [records.length] })).fadeIn('slow');
    showSubjects(records, client);
    if (callback) {
      callback();
    }
  }).fail(function fail (err) {
    $status.hide().text(client.translate('Error loading database')).fadeIn('slow');
    subjects.records = [];
    if (callback) {
      callback(err);
    }
  });
}

function genDialog (client) {
  var ret =
    '<div id="editsubjectdialog" style="display:none" title="' + client.translate('Edit Subject') + '">' +
    '      <label for="edsub_name">' +
    client.translate('Name') +
    '          <input id="edsub_name" placeholder="' + client.translate('person, device, etc') + '"/>' +
    '      </label>' +
    '      <br>' +
    '      <label for="edsub_roles">' +
    client.translate('Roles') +
    '          <input id="edsub_roles" placeholder="' + client.translate('role1, role2') + '"/>' +
    '      </label>' +
    '      <br>' +
    '      <label for="edsub_notes">' + client.translate('Additional Notes, Comments') + '</label>' +
    '      <textarea id="edsub_notes" style="width:300px"></textarea><br>' +
    '   </div>';

  return $(ret);
}

function openDialog (subject, client) {
  $('#editsubjectdialog').dialog({
    width: 360
    , height: 300
    , buttons: [
      {
        text: client.translate('Save')
        , class: 'leftButton'
        , click: function() {
          subject.name = $('#edsub_name').val();
          subject.roles =
            _.chain($('#edsub_roles').val().toLowerCase().split(/[;, ]/))
            .map(_.trim)
            .reject(_.isEmpty)
            .sort()
            .value();
          subject.notes = $('#edsub_notes').val();

          var self = this;
          createOrSaveSubject(subject, client, function callback () {
            $(self).dialog('close');
          });
        }
      }
      , {
        text: client.translate('Cancel')
        , click: function() { $(this).dialog('close'); }
      }
    ]
    , open: function() {
      $(this).parent().css('box-shadow', '20px 20px 20px 0px black');
      $(this).parent().find('.ui-dialog-buttonset').css({ 'width': '100%', 'text-align': 'right' });
      $(this).parent().find('button:contains("' + client.translate('Save') + '")').css({ 'float': 'left' });
      $('#edsub_name').val(subject.name || '').focus();
      $('#edsub_roles').val(subject.roles ? subject.roles.join(', ') : '');
      $('#edsub_notes').val(subject.notes || '');
    }

  });

}

function showSubject (subject, table, client) {
  var editIcon = $('<img title="' + client.translate('Edit this subject') + '" style="cursor:pointer" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABEUlEQVQ4jZ3MMUsCYQDG8ee8IySQbNCLyyEKG/RLNAXicqvQcAeNLrcFLlE0+xHuNpt8wy04rrYm8Q4HQRE56BSC3lSqU1BwCoxM39dnffj9BWyxXvVeEzvtctBwHyRebNu2Nk2lzMlrgJB+qBEeTByiKYpihl+fIO8jTI9PDJEVF1+K2iw+M6PhDuyag4NkQi/c3FkCK5Z3ZbM76qLltpCbn+vXxq0FABsDy9hzPdBvqvtXvvXzrw1swmsDLPjfACteGeDBfwK8+FdgGwwAIgC0ncsjxGRSH/eiPBgAJADY2z8sJ4JBfNBsDqlADVYMANIzKalv/bHaefKsTH9iPFb8ISsGAJym0+Qinz3jQktbAHcxvx3559eSAAAAAElFTkSuQmCC">');
  editIcon.click(function clicked () {
    openDialog(subject, client);
  });
  var deleteIcon = $('<img title="' + client.translate('Delete this subject') + '" style="cursor:pointer" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACrElEQVQ4T42Ty2sTQRzHv5tmk2yyjRNtpfZhL8V6s2KoUNC2XqwgaCsVQcGiFqpHi0c9iRdR/ANE9KR40FIQX4cueKoPaKFoLdSYNtE0abKT1+5s9iW7aUMiHtzTzO7v85md+c6PA4DrHbsPCKIgOWO1pA7dT6YXnXH949SE/F63pqwZtRrO+SCKgjQ5NUV+azpmHj2krMwaJC4c8Erj+/eRyloMMwWFKgbn1nC3ervlK1evkXBLGBZT8SOewotnTylTNLdgeg/pDgZDC2cPHSR8bB22DVC9hFe0SG/H0xFXcHlykjRHRDBWgJcZSCY38Xx2lhqMnRYE34Px/sN9vlQWeoHBAx2yXsRruVAVuFsIBaSJ8+eJGPaBqQV4NROJjTzez89jLBoFn6FgybQL54wS3uTyVDFQ3cL2IYpBv3RhdJSIIQ80tQyv7gEqJvS8AmUlBs7UXPhtjtZgh3UFNYngk86NHCfNAg9dMwHVBPu+CpsVkTXKeJeVG+AGgTOZ3tt6MSKKjy+NjEBjFrR4ElZmA4pdxstMFsyyJu6tZZ7Ux9vwB6EAL50ZGiRECEPPUOixVTRxHlicgSVWxEdZpuZWfNuS2hk48NjwMIkIYZglBnV5Cbqtws/5IaAJmsfCglrEl2y2QeKmEBJ80tixKmxrFpSVr0gV0viQoxho2YUuPohmeFD22PiklLC4ma5JuBvdrfLJI0dJd0s7bM0ES8aR/BXDXGaTskqlL+D3Lwy0tZEePoAd4EA5YF4tYymdonfjmQh3s6dTPjU4SHYGwjAKecSXFyGlM1TdytntE56T+ts7SC/vhw3gm6njc2Kd3vm5Ub1IwQAvnYhGiZpYw1wiWYPrIw7wnBTt7CLOOwdmut14kQQvqt24tfK/utGR6LaF+iRqMf4N/O/8D28HiiCRYqzAAAAAAElFTkSuQmCC">');
  deleteIcon.click(function clicked () {
    var ok = window.confirm(client.translate('Are you sure you want to delete: ') + subject.name);
    if (ok) {
      deleteSubject(subject, client);
    }
  });
  table.append($('<tr>').css('background-color', '#0f0f0f')
    .append($('<td>').attr('width', '20%').append(editIcon).append(deleteIcon).append(subject.name))
    .append($('<td>').attr('width', '20%').append(subject.roles ? subject.roles.join(', ') : '[none]'))
    .append($('<td>').attr('width', '20%').append('<a href="/?token=' + subject.accessToken + '" target="_blank">' + subject.accessToken + '</a>'))
    .append($('<td>').attr('width', '10%').append(subject.notes ? subject.notes : ''))
  );
}

function showSubjects (subjects, client) {
  var table = $('#admin_subjects_table');
  table.empty().append($('<tr>').css('background', '#040404')
    .append($('<th>').css('width', '100px').attr('align', 'left').append(client.translate('Name')))
    .append($('<th>').css('width', '150px').attr('align', 'left').append(client.translate('Roles')))
    .append($('<th>').css('width', '150px').attr('align', 'left').append(client.translate('Access Token')))
    .append($('<th>').css('width', '150px').attr('align', 'left').append(client.translate('Notes')))
  );
  for (var t = 0; t < subjects.length; t++) {
    showSubject(subjects[t], table, client);
  }
}
