	function report_treatments(datastorage,daystoshow,options) {
		var icon_remove = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACrElEQVQ4T42Ty2sTQRzHv5tmk2yyjRNtpfZhL8V6s2KoUNC2XqwgaCsVQcGiFqpHi0c9iRdR/ANE9KR40FIQX4cueKoPaKFoLdSYNtE0abKT1+5s9iW7aUMiHtzTzO7v85md+c6PA4DrHbsPCKIgOWO1pA7dT6YXnXH949SE/F63pqwZtRrO+SCKgjQ5NUV+azpmHj2krMwaJC4c8Erj+/eRyloMMwWFKgbn1nC3ervlK1evkXBLGBZT8SOewotnTylTNLdgeg/pDgZDC2cPHSR8bB22DVC9hFe0SG/H0xFXcHlykjRHRDBWgJcZSCY38Xx2lhqMnRYE34Px/sN9vlQWeoHBAx2yXsRruVAVuFsIBaSJ8+eJGPaBqQV4NROJjTzez89jLBoFn6FgybQL54wS3uTyVDFQ3cL2IYpBv3RhdJSIIQ80tQyv7gEqJvS8AmUlBs7UXPhtjtZgh3UFNYngk86NHCfNAg9dMwHVBPu+CpsVkTXKeJeVG+AGgTOZ3tt6MSKKjy+NjEBjFrR4ElZmA4pdxstMFsyyJu6tZZ7Ux9vwB6EAL50ZGiRECEPPUOixVTRxHlicgSVWxEdZpuZWfNuS2hk48NjwMIkIYZglBnV5Cbqtws/5IaAJmsfCglrEl2y2QeKmEBJ80tixKmxrFpSVr0gV0viQoxho2YUuPohmeFD22PiklLC4ma5JuBvdrfLJI0dJd0s7bM0ES8aR/BXDXGaTskqlL+D3Lwy0tZEePoAd4EA5YF4tYymdonfjmQh3s6dTPjU4SHYGwjAKecSXFyGlM1TdytntE56T+ts7SC/vhw3gm6njc2Kd3vm5Ub1IwQAvnYhGiZpYw1wiWYPrIw7wnBTt7CLOOwdmut14kQQvqt24tfK/utGR6LaF+iRqMf4N/O/8D28HiiCRYqzAAAAAAElFTkSuQmCC";
    var icon_edit = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABEUlEQVQ4jZ3MMUsCYQDG8ee8IySQbNCLyyEKG/RLNAXicqvQcAeNLrcFLlE0+xHuNpt8wy04rrYm8Q4HQRE56BSC3lSqU1BwCoxM39dnffj9BWyxXvVeEzvtctBwHyRebNu2Nk2lzMlrgJB+qBEeTByiKYpihl+fIO8jTI9PDJEVF1+K2iw+M6PhDuyag4NkQi/c3FkCK5Z3ZbM76qLltpCbn+vXxq0FABsDy9hzPdBvqvtXvvXzrw1swmsDLPjfACteGeDBfwK8+FdgGwwAIgC0ncsjxGRSH/eiPBgAJADY2z8sJ4JBfNBsDqlADVYMANIzKalv/bHaefKsTH9iPFb8ISsGAJym0+Qinz3jQktbAHcxvx3559eSAAAAAElFTkSuQmCC";

		var table = '<table>';
		table += '<tr style="background:gray"><th></th><th style="width:80px" align="left">'+translate('Time')+'</th><th style="width:150px" align="left">'+translate('Event Type')+'</th><th style="width:150px" align="left">'+translate('Blood Glucose')+'</th><th style="width:50px" align="left">'+translate('Insulin')+'</th><th style="width:50px" align="left">'+translate('Carbs')+'</th><th style="width:150px" align="left">'+translate('Entered By')+'</th><th style="width:300px" align="left">'+translate('Notes')+'</th></tr>';
		
		Object.keys(daystoshow).forEach(function (day) {
			table += '<tr><td></td><td colspan="7"><b>'+localeDate(day)+'</b></td></tr>';
			var treatments = datastorage[day].treatments;
			for (var t=0; t<treatments.length; t++) {
				var tr = treatments[t];
				table += '<tr class="border_bottom">';
				table += '<td>';
        table += '<img style="cursor:pointer" title="'+translate('Delete record')+'" src="'+icon_remove+'" href="#" class="deleteTreatment" data=\''+JSON.stringify(tr)+'\' day="'+day+'">';
        table += '&nbsp;';
        table += '<img style="cursor:pointer" title="'+translate('Edit record')+'" src="'+icon_edit+'" href="#" class="editTreatment" data=\''+JSON.stringify(tr)+'\' day="'+day+'">';
        table += '</td>';
				table += '<td>'+(new Date(tr.created_at).toLocaleTimeString().replace(/([\d]+:[\d]{2})(:[\d]{2})(.*)/, "$1$3"))+'</td>';
				table += '<td>'+(tr.eventType ? tr.eventType : '')+'</td>';
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
	}
	
	function deleteTreatment(event) {
		var data = JSON.parse($(this).attr('data'));
		var day = $(this).attr('day');

		var ok = window.confirm(
				translate('Delete this treatment?')+'\n' +
				'\n'+translate('Event Type')+': ' + data.eventType +
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
			show();
		}
		if (event) event.preventDefault();
		return false;
	}

	function deleteTreatmentRecord(_id) {
		if (!Nightscout.auth.isAuthenticated()) {
			alert(translate('Your device is not authenticated yet'));
			return false;
		}
		
		var xhr = new XMLHttpRequest();
		xhr.open('DELETE', '/api/v1/treatments/'+_id, true);
		xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
		xhr.setRequestHeader('api-secret', Nightscout.auth.hash());
		xhr.onload = function () {
			if (xhr.statusText!='OK') {
				alert(translate('Deleting record failed'));
			}
		}
		xhr.send(null);
		return true;
	}

	function editTreatment(event) {
		var data = JSON.parse($(this).attr('data'));
		var day = $(this).attr('day');

    $( '#rp_edittreatmentdialog' ).dialog({
        width: 350
      , height: 500
      ,  buttons: [
        { text: translate('Save'),
          class: 'leftButton',
          click: function() {
            data.eventType = $('#rp_eventType').val();
            data.glucose = $('#rp_glucoseValue').val();
            data.glucoseType = $('#rp_edittreatmentdialog').find('input[name=rp_bginput]:checked').val();
            data.carbs = $('#rp_carbsGiven').val();
            data.insulin = $('#rp_insulinGiven').val();
            data.notes = $('#rp_adnotes').val();
            data.enteredBy = $('#rp_enteredBy').val();
            data.created_at = Nightscout.utils.mergeInputTime($('#rp_eventTimeValue').val(), $('#rp_eventDateValue').val());
            $( this ).dialog( "close" );
            saveTreatmentRecord(data);
            delete datastorage[day];
            show();
          }
        },
        { text: translate('Cancel'),
           click: function () { $( this ).dialog( "close" ); }
        }
        ]
      , open   : function(ev, ui) {
        $(this).parent().css('box-shadow', '20px 20px 20px 0px black');
        $(this).parent().find('.ui-dialog-buttonset'      ).css({'width':'100%','text-align':'right'})
        $(this).parent().find('button:contains("'+translate('Save')+'")').css({'float':'left'});
        $('#rp_eventType').val(translate(data.eventType));
        $('#rp_glucoseValue').val(data.glucose ? data.glucose : '').attr('placeholder', translate('Value in') + ' ' + serverSettings.units);
        $('#rp_bgfromsensor').prop('checked', data.glucoseType === 'Sensor');
        $('#rp_bgfrommeter').prop('checked', data.glucoseType === 'Finger');
        $('#rp_bgmanual').prop('checked', data.glucoseType === 'Manual');
        $('#rp_carbsGiven').val(data.carbs ? data.carbs : '');
        $('#rp_insulinGiven').val(data.insulin ? data.insulin : '');
        $('#rp_adnotes').val(data.notes ? data.notes : '');
        $('#rp_enteredBy').val(data.enteredBy ? data.enteredBy : '');
        $('#rp_eventTimeValue').val(moment(data.created_at).format('HH:mm'));
        $('#rp_eventDateValue').val(moment(data.created_at).format('YYYY-MM-DD'));
        $('#rp_eventType').focus();
      }

    });
   
    if (event) event.preventDefault();
		return false;
	}

	function saveTreatmentRecord(data) {
		if (!Nightscout.auth.isAuthenticated()) {
			alert(translate('Your device is not authenticated yet'));
			return false;
		}
		
	
		var dataJson = JSON.stringify(data, null, ' ');

		var xhr = new XMLHttpRequest();
		xhr.open('PUT', '/api/v1/treatments/', true);
		xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
		xhr.setRequestHeader('api-secret', Nightscout.auth.hash());
		xhr.onload = function () {
			if (xhr.statusText!='OK') {
				alert(translate('Saving record failed'));
			}
		}
		xhr.send(dataJson);
		return true;
	}

