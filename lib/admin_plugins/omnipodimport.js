'use strict';

var omnipodimport = {
    name: 'omnipodimport'
    , label: 'Import data from an Omnipod PDM file'
    , pluginType: 'admin'
};

function init() {
    return omnipodimport;
}

module.exports = init;

omnipodimport.actions = [{
    name: "Upload carb and bolus entries"
    , description: 'This task will read an Omnipod PDM export file and import the Carb and Bolus entries.'
    , buttonLabel: 'Upload an Omnipod PDM export file.'
    , preventClose: true
  }];

omnipodimport.actions[0].init = function uploadOmnipodInit(client) {
    var fileinput = $('<input>').attr('name', 'ibf').attr('type', 'file').attr('accept', '.ibf');

    var form = $('<form>').attr('ID', 'ibfForm');
    form.append(fileinput);

    var $div = $('#admin_' + omnipodimport.name + '_0_html');
    $div.append($('<br>'));
    $div.append(form);
}

omnipodimport.actions[0].code = function uploadOmnipod(client, callback) {
    var $status = $('#admin_' + omnipodimport.name + '_0_status');
    var apisecrethash = localStorage.getItem('apisecrethash');

    if (!client.hashauth.isAuthenticated()) {
        alert(translate('Your device is not authenticated yet'));
        if (callback) {
          callback();
        }
        return;
    };

    $status.hide().text('Uploading...').fadeIn('slow');

    $.ajax({
        method: "POST",
        url: "/upload/omnipod",
        data: new FormData($('form')[0]),
        beforeSend: function beforeSend (xhr) {
            xhr.setRequestHeader('api-secret', apisecrethash);
        },
        cache: false,
        contentType: false,
        processData: false,
        success: function success (resp) {
            $status.hide().text('Upload complete!').fadeIn('slow');
        }
    });

    if (callback) {
        callback();
    }
}
