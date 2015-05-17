/* Code by Milos Kozak

TODO:
	- treatment drawer must be updated to enter glycemic index
	- update calculation to use new style of values
	- how to handle units? store native or convert to mg/dL?

*/
	var c_profile = null;
	
	var defaultprofile = {
			//General values
			"simple": true,
			"calculator": false,
			"dia":3,
			
			// Simple style values, "from" are in minutes from midnight
			"carbratio":24,
			"carbs_hr":30,
			"sens":17,
			
			"validfrom": new Date(),
			
			//Bolus calculator style values, "from" are in minutes from midnight
			"ic": [{"from":0,"val":0},
					{"from":48*30,"val":0}
					],
			"car_high": 30,
			"car_medium": 30,
			"car_low": 30,
			"delay_high": 20,
			"delay_medium": 20,
			"delay_low": 20,
			"isf": [{"from":0,"val":0},
					{"from":48*30,"val":0}
					],

			"basal": [{"from":0,"val":0},
					{"from":48*30,"val":0}
					],
			"targetBG": [
					{"from":0,"low":0,"high":0},
					{"from":48*30,"low":0,"high":0}
					]
	};

	var GuiToVal = [
			// General
			{ "html":"pe_input_simple",		"type":"checkbox" , "settings":"c_profile.simple" },
			{ "html":"pe_input_calculator",	"type":"checkbox" , "settings":"c_profile.calculator" },
			{ "html":"pe_dia", 				"type":"float" , 	"settings":"c_profile.dia" },
			
			{ "html":"pe_validfrom", 		"type":"date" , 	"settings":"c_profile.validfrom" },
			
			// Simple style values
			{ "html":"pe_if", 			"type":"int" , 			"settings":"c_profile.carbratio" },
			{ "html":"pe_hr", 			"type":"int" , 			"settings":"c_profile.carbs_hr" },
			{ "html":"pe_isf", 			"type":"int" , 			"settings":"c_profile.sens" },
			
			//Bolus calculator style values
			{ "html":"pe_hr_high", 		"type":"int" , 			"settings":"c_profile.car_high" },
			{ "html":"pe_hr_medium",	"type":"int" , 			"settings":"c_profile.car_medium" },
			{ "html":"pe_hr_low", 		"type":"int" , 			"settings":"c_profile.car_low" },
			{ "html":"pe_delay_high", 	"type":"int" , 			"settings":"c_profile.delay_high" },
			{ "html":"pe_delay_medium",	"type":"int" , 			"settings":"c_profile.delay_medium" },
			{ "html":"pe_delay_low", 	"type":"int" , 			"settings":"c_profile.delay_low" }
	];
	
	var icon_add = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABa0lEQVQ4T6WTzysEYRjHP+/Mrv2hHOTuqJRNOfgPSORHokg4OClHcnVzVygHF6WIcuHMnyCHVRyI3ZYxa23vzOzs7LzamaI0e5i89fTWt/f5vPV5n1cQsXLbHepvfLv5JaLORoZNwMbyFo5vYfsWB0c7xAasLa5T/vCg45Oj48P4gJWFVYxCA63L5PzkND5gfm4Jo+Chd5W5OrtsDYgS1pQ1OTuNUfTQO8tcX9xE+QugYnS/X81MzGP7MpTWkEFVZY1KxcVPV3h27zAtA+oCagIcDfWUCgEje31qfHwK06gHjaF5iXQcHCV5lHmqqgQCNEAI0IsavCVDwNBurxoeGwmaAkDDwvYsqtIh//6AJUoklP97s62BbJYeAqIcpJNZsoM+r2aVbKKOekiBL8An3BuAEiGg1SSKAYnttpFxPdR9Jv4zipxFTUuQKqsfYbFGWfTYuO06yRfxIyweoLuG+iMsFuBfvzFy7FqE33vs2BFqlfN5AAAAAElFTkSuQmCC";
	var icon_remove = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACrElEQVQ4T42Ty2sTQRzHv5tmk2yyjRNtpfZhL8V6s2KoUNC2XqwgaCsVQcGiFqpHi0c9iRdR/ANE9KR40FIQX4cueKoPaKFoLdSYNtE0abKT1+5s9iW7aUMiHtzTzO7v85md+c6PA4DrHbsPCKIgOWO1pA7dT6YXnXH949SE/F63pqwZtRrO+SCKgjQ5NUV+azpmHj2krMwaJC4c8Erj+/eRyloMMwWFKgbn1nC3ervlK1evkXBLGBZT8SOewotnTylTNLdgeg/pDgZDC2cPHSR8bB22DVC9hFe0SG/H0xFXcHlykjRHRDBWgJcZSCY38Xx2lhqMnRYE34Px/sN9vlQWeoHBAx2yXsRruVAVuFsIBaSJ8+eJGPaBqQV4NROJjTzez89jLBoFn6FgybQL54wS3uTyVDFQ3cL2IYpBv3RhdJSIIQ80tQyv7gEqJvS8AmUlBs7UXPhtjtZgh3UFNYngk86NHCfNAg9dMwHVBPu+CpsVkTXKeJeVG+AGgTOZ3tt6MSKKjy+NjEBjFrR4ElZmA4pdxstMFsyyJu6tZZ7Ux9vwB6EAL50ZGiRECEPPUOixVTRxHlicgSVWxEdZpuZWfNuS2hk48NjwMIkIYZglBnV5Cbqtws/5IaAJmsfCglrEl2y2QeKmEBJ80tixKmxrFpSVr0gV0viQoxho2YUuPohmeFD22PiklLC4ma5JuBvdrfLJI0dJd0s7bM0ES8aR/BXDXGaTskqlL+D3Lwy0tZEePoAd4EA5YF4tYymdonfjmQh3s6dTPjU4SHYGwjAKecSXFyGlM1TdytntE56T+ts7SC/vhw3gm6njc2Kd3vm5Ub1IwQAvnYhGiZpYw1wiWYPrIw7wnBTt7CLOOwdmut14kQQvqt24tfK/utGR6LaF+iRqMf4N/O/8D28HiiCRYqzAAAAAAElFTkSuQmCC";
	
	var apistatus = {};
	var mongoprofiles = [];

	// Fetch data from mongo
	$('#pe_status').hide().text(translate('Loading status')+' ...').fadeIn("slow");
	// status with defaults first
	$.ajax('/api/v1/status.json', {
		success: function (xhr) {
			apistatus = { 
				  apiEnabled: xhr.apiEnabled
				, defaults: xhr.defaults //  { ...., defaults: {timeFormat: '24', units: 'mmol'} }
			};
	   },
		error: function () {
			alert('Error loading your defaults. 12H and mg/dL will be used');
			apistatus = { 'defaults': { 'timeFormat': '12', 'units': 'mg/dL', 'language': 'en', 'customTitle': 'Nightscout'} };
		}
	}).done(function () {
		$('#pe_status').hide().text('Loading profile records ...').fadeIn("slow");
		$.ajax('/api/v1/profile.json', {
			success: function (records) {
				c_profile = {};
				mongoprofiles = records;
				// create new profile to be edited from last record
				if (records[0] && records[0].dia) {
					// Use only values(keys) defined in defaultprofile, drop the rest. Preparation for future changes.
					c_profile = defaultprofile;
					for (var key in records[0]) {
						if (typeof c_profile[key] != 'undefined') 
							c_profile[key] = records[0][key];
						// copy _id of record too
						if (key == '_id') 
							c_profile[key] = records[0][key];
					}
					$('#pe_status').hide().text('Values loaded.').fadeIn("slow");
					mongoprofiles.unshift(c_profile);
				} else {
					c_profile = defaultprofile;
					mongoprofiles.unshift(c_profile);
					$('#pe_status').hide().text('Default values used.').fadeIn("slow");
				}
			},
			error: function () {
				c_profile = defaultprofile;
				mongoprofiles.unshift(c_profile);
				$('#pe_status').hide().text('Error. Default values used.').fadeIn("slow");
			}
		}).done(initeditor);
	});
	
	function initeditor() {
		// Add handler for style switching
		$('#pe_input_simple').change(switchStyle);
		$('#pe_input_calculator').change(switchStyle);

		// display status
		$('#pe_units').text(apistatus['defaults']['units']);
		$('#pe_timeformat').text(apistatus['defaults']['timeFormat']+'h');
		$('#pe_title').text(apistatus['defaults']['customTitle']);

		var lastvalidfrom = new Date(mongoprofiles[1] && mongoprofiles[1].validfrom ? mongoprofiles[1].validfrom : null);
		
		//timepicker
		$('#pe_validfrom').datetimepicker({
			  lang: apistatus['defaults']['language']
			, mask: true
			, stepMinute: 15
			, timeFormat: apistatus['defaults']['timeFormat'] == '12' ? 'hh:mm p' : 'HH:mm'
			, dateFormat: apistatus['defaults']['timeFormat'] == '12' ? 'mm/dd/yy' : 'd.m.yy'
			, minDate: lastvalidfrom
			//this has a serious bug
			//, minDateTime: mongoprofiles[1] && mongoprofiles[1].validfrom ? mongoprofiles[1].validfrom : null
			, maxDate: new Date()
			, maxDateTime: new Date()
			, onSelect: function(d,i){
				  if(d !== i.lastVal){
					  $(this).change();
				  }
			 }
		}).on('change', dateChanged);

		//$('#pe_validfrom').datetimepicker('setDate', lastvalidfrom);
	
		// Set values from profile to html
		fillFrom();
		// hide unused style of ratios
		switchStyle();
		// show proper submit button
		dateChanged();
		
		// date of last record
		if (lastvalidfrom)
			$('#pe_lastrecvalidfrom').html('Last record date: '+lastvalidfrom.toLocaleString()+' <i>(Date must be newer to create new record or the same to update current record)</i>');
		else 
			$('#pe_lastrecvalidfrom').html('');

		console.log('Done initeditor()');
	}
	
	// Handling valid from date change
	function dateChanged(event) {
		var newdate = $('#pe_validfrom').datetimepicker('getDate');
		if (mongoprofiles.length<2 || +new Date(mongoprofiles[1].validfrom) != +newdate) {
			$('#pe_submit').text('Create new record');
			$('#pe_validfrom').css({'background-color':'green'});
			$('#pe_submit').css({'background-color':'green'});
		} else {
			$('#pe_submit').text('Update record');
			$('#pe_validfrom').css({'background-color':'white'});
			$('#pe_submit').css({'background-color':'buttonface'});
		}
		if (event) {
			event.preventDefault();
		}
	}
	
	// Handling html events and setting/getting values
	function switchStyle(event) {
		if ($('#pe_input_simple').prop('checked')) {
			$('#pe_simple').show("slow");
			$('#pe_calculator').hide("slow");
		} else {
			$('#pe_simple').hide("slow");
			$('#pe_calculator').show("slow");
		}
		if (event) {
			event.preventDefault();
		}
	}
	
	function fillFrom(event) {
		var mmoltime = [
			"0:00","0:30","1:00","1:30","2:00","2:30","3:00","3:30","4:00","4:30","5:00","5:30",
			"6:00","6:30","7:00","7:30","8:00","8:30","9:00","9:30","10:00","10:30","11:00","11:30",
			"12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","17:30",
			"18:00","18:30","19:00","19:30","20:00","20:30","21:00","21:30","22:00","22:30","23:00","23:30",
			"24:00"
		];
		var mgtime = [
			"12:00AM","0:30AM","1:00AM","1:30AM","2:00AM","2:30AM","3:00AM","3:30AM","4:00AM","4:30AM","5:00AM","5:30AM",
			"6:00AM","6:30AM","7:00AM","7:30AM","8:00AM","8:30AM","9:00AM","9:30AM","10:00AM","10:30AM","11:00AM","11:30AM",
			"12:00PM","0:30PM","1:00PM","1:30PM","2:00PM","2:30PM","3:00PM","3:30PM","4:00PM","4:30PM","5:00PM","5:30PM",
			"6:00PM","6:30PM","7:00PM","7:30PM","8:00PM","8:30PM","9:00PM","9:30PM","10:00PM","10:30PM","11:00PM","11:30PM",
			"Midnight"
		];
		if (event) saveSettings();
		
		// Fill dropdown boxes
		[{prefix:'pe_basal', array:'basal', label:'Rate: '},
		 {prefix:'pe_ic', array:'ic', label:'IC: '},
		 {prefix:'pe_isf', array:'isf', label:'ISF: '}
		].forEach(function (e) {
			// add end record if not at the end
			if (c_profile[e.array][c_profile[e.array].length-1].from!=48*30) c_profile[e.array].push({"from":48*30,"val":0});
			var html = '<table>';
			for (var i=0; i<c_profile[e.array].length; i++) {
				html += '<tr>';
				html += '<td>From: <select class="pe_selectabletime" id="'+e.prefix+'_from_'+i+'">';
				var lowesttime=-1;
				for (var t=0;t<49;t++) {
					if (i==0 && t>0) continue;
					if (i>0 && isNaN(c_profile[e.array][i-1].from)) continue;
					if (i>0 && c_profile[e.array][i-1].from >= t*30) continue;
					if (lowesttime == -1) lowesttime = t*30;
					var selected = '';
					if (c_profile[e.array][i].from == t*30) selected = 'selected';
					html += '<option value="'+(t*30)+'" '+selected+'>';
					if (apistatus['defaults']['timeFormat']=='24') {
						html += mmoltime[t];
					} else {
						html += mgtime[t];
					}
				}
				html += '</select>';
				if (c_profile[e.array][i].from<48*30) {
					html += '<td>'+e.label+'<input type="text" id="'+e.prefix+'_val_'+i+'" value="'+c_profile[e.array][i].val+'"></td>';
					html += '<td>';
					html += '<img style="cursor:pointer" title="Add new interval before" src="'+icon_add+'" href="#" onclick="saveSettings(); c_profile[\''+e.array+'\'].splice('+i+',0,{from:0,val:0}); return fillFrom();">';
					if (i!=0) {
						html += '<img style="cursor:pointer" title="Delete interval" src="'+icon_remove+'" href="#" onclick="saveSettings(); c_profile[\''+e.array+'\'].splice('+i+',1); return fillFrom();">';
					}
					html += '</td>';
				}
				html += '</tr>';
				
				if (lowesttime>c_profile[e.array][i].from) c_profile[e.array][i].from = lowesttime;
				updateGuiToVal({html:e.prefix+'_from_'+i, type:'dropdownval', settings:'c_profile["'+e.array+'"]['+i+'].from' });
				updateGuiToVal({html:e.prefix+'_val_'+i, type:'float', settings:'c_profile["'+e.array+'"]['+i+'].val' });
			}
			html += '</table>';
			$('#'+e.prefix+'_placeholder').html(html);
		});
		
		
		// target BG
		// add end record if not at the end
		if (c_profile.targetBG[c_profile.targetBG.length-1].from!=48*30) c_profile.targetBG.push({"from":48*30,"low":0,"high":0});
		var html = '<table>';
		for (var i=0; i<c_profile.targetBG.length; i++) {
			html += '<tr>';
			html += '<td>From: <select class="pe_selectabletime" id="pe_targetbg_from_'+i+'">';
			var lowesttime=-1;
			for (var t=0;t<49;t++) {
				if (i==0 && t>0) continue;
				if (i>0 && isNaN(c_profile.targetBG[i-1].from)) continue;
				if (i>0 && c_profile.targetBG[i-1].from >= t*30) continue;
				if (lowesttime == -1) lowesttime = t*30;
				var selected = '';
				if (c_profile.targetBG[i].from == t*30) selected = 'selected';
				html += '<option value="'+(t*30)+'" '+selected+'>';
				if (apistatus['defaults']['timeFormat']=='24') {
					html += mmoltime[t];
				} else {
					html += mgtime[t];
				}
			}
			html += '</select>';
			if (c_profile.targetBG[i].from<48*30) {
				html += '<td>Low : <input type="text" id="pe_targetbg_low_'+i+'" value="'+c_profile.targetBG[i].low+'"></td>';
				html += '<td>High : <input type="text" id="pe_targetbg_high_'+i+'" value="'+c_profile.targetBG[i].high+'"></td>';
				html += '<td>';
				html += '<img style="cursor:pointer" title="Add new interval before" src="'+icon_add+'" href="#" onclick="saveSettings(); c_profile.targetBG.splice('+i+',0,{from:0,low:0,high:0}); return fillFrom();">';
				if (i!=0) {
					html += '<img style="cursor:pointer" title="Delete interval" src="'+icon_remove+'" href="#" onclick="saveSettings(); c_profile.targetBG.splice('+i+',1); return fillFrom();">';
				}
				html += '</td>';
			}
			html += '</tr>';
			
			if (lowesttime>c_profile.targetBG[i].from) c_profile.targetBG[i].from = lowesttime;
			updateGuiToVal({html:'pe_targetbg_from_'+i, type:'dropdownval', settings:'c_profile.targetBG['+i+'].from' });
			updateGuiToVal({html:'pe_targetbg_low_'+i, type:'float', settings:'c_profile.targetBG['+i+'].low' });
			updateGuiToVal({html:'pe_targetbg_high_'+i, type:'float', settings:'c_profile.targetBG['+i+'].high' });
		}
		html += '</table>';
		$('#pe_targetbg_placeholder').html(html);
		
		$(".pe_selectabletime").bind("change",fillFrom);

		updateGUI();
		if (event) {
			event.preventDefault();
		}
		return false;
	}
	
	function updateGuiToVal(rec) {
		for (var i=0; i<GuiToVal.length; i++) {
			if (GuiToVal[i].html==rec.html) {
				GuiToVal[i] = rec;
				return;
			}
		}
		GuiToVal.push(rec);
	}

	
	// fill GUI with values from object
	function updateGUI() {
		for(var ii=0, len=GuiToVal.length; ii < len; ii++) {
			if (document.getElementById(GuiToVal[ii].html)) {
				if (GuiToVal[ii].type == "int") {
					var val = eval(GuiToVal[ii].settings);
					setElement(GuiToVal[ii].html,'value',val == 0 ? '' : val);
				} else if (GuiToVal[ii].type == "array") 
					setElement(GuiToVal[ii].html,'value',JSON.stringify(eval(GuiToVal[ii].settings)).replace('[','').replace(']',''));
				else if (GuiToVal[ii].type == "float") {
					var val = eval(GuiToVal[ii].settings);
					setElement(GuiToVal[ii].html,'value',val == 0 ? '' : val);
				} else if (GuiToVal[ii].type == "checkbox") {
					setElement(GuiToVal[ii].html,'checked',eval(GuiToVal[ii].settings));
				} else if (GuiToVal[ii].type == "text")
					setElement(GuiToVal[ii].html,'value',eval(GuiToVal[ii].settings));
				else if (GuiToVal[ii].type == "dropdown") {
					setElement(GuiToVal[ii].html,'selectedIndex',eval(GuiToVal[ii].settings));
				} else if (GuiToVal[ii].type == "date") {
					$('#'+GuiToVal[ii].html).datetimepicker('setDate', new Date(eval(GuiToVal[ii].settings)));
				} else if (GuiToVal[ii].type == "dropdownval") {
					var sel = document.getElementById(GuiToVal[ii].html);
					var val = eval(GuiToVal[ii].settings);
					for(var i = 0, j = sel.options.length; i < j; ++i) {
						if(sel.options[i].value === val) {
						   sel.selectedIndex = i;
						   break;
						}
					}
				}
			}
		} 
	}
	
	function setElement(id,property,content) {
		var el = document.getElementById(id);
		if (el) el[property] = content;
		else console.log('Trying to set non existing id ' + id + ' property ' + property);
	}

	function saveSettings() {
		// Grab values from html GUI to object
		for(var ii=0, len=GuiToVal.length; ii < len; ii++) {
			try {
				if(document.getElementById(GuiToVal[ii].html) == null) continue;

				if (GuiToVal[ii].type == "int")
					eval(GuiToVal[ii].settings + '=(document.getElementById("' + GuiToVal[ii].html + '").value=="")?0:parseInt(document.getElementById("' + GuiToVal[ii].html + '").value)')
				else if (GuiToVal[ii].type == "array")
					eval(GuiToVal[ii].settings + '= JSON.parse("["+document.getElementById("' + GuiToVal[ii].html + '").value+"]")');
				else if (GuiToVal[ii].type == "float") {
					eval(GuiToVal[ii].settings + '=parseFloat(document.getElementById("' + GuiToVal[ii].html + '").value.replace(",","."))');
					eval(GuiToVal[ii].settings + '= isNaN(' + GuiToVal[ii].settings + ') ? 0 : ' + GuiToVal[ii].settings);
				} else if (GuiToVal[ii].type == "checkbox")
					eval(GuiToVal[ii].settings + '=document.getElementById("' + GuiToVal[ii].html + '").checked');
				else if (GuiToVal[ii].type == "text")
					eval(GuiToVal[ii].settings + '=document.getElementById("' + GuiToVal[ii].html + '").value');
				else if (GuiToVal[ii].type == "dropdownval") {
					eval(GuiToVal[ii].settings + '=document.getElementById("' + GuiToVal[ii].html + '").value');
				} else if (GuiToVal[ii].type == "date") {
					eval(GuiToVal[ii].settings + '= $("#' + GuiToVal[ii].html + '").datetimepicker("getDate")');
				} else if (GuiToVal[ii].type == "dropdown") {
					eval(GuiToVal[ii].settings + '=document.getElementById("' + GuiToVal[ii].html + '").selectedIndex');
				}
			} catch (e) { /*alert('Wrong value entered: '+GuiToVal[ii].html+'  '+GuiToVal[ii].settings + ' ' + e.message);*/ }
		}
		console.info(JSON.stringify(c_profile));
	}
	
	function clone(obj) {
		if (null == obj || "object" != typeof obj) return obj;
		var copy = obj.constructor();
		for (var attr in obj) {
			if (obj.hasOwnProperty(attr)) copy[attr] = obj[attr];
		}
		return copy;
	}
	
	function profileSubmit(event) {
		try {
			saveSettings();
			if (new Date(c_profile.validfrom) > new Date()) {
				alert('Date must be set in the past');
				$('#pe_status').hide().html('Wrong date').fadeIn("slow");
				return false;
			}
			
			if (!Nightscout.auth.isAuthenticated()) {
				alert(translate('Your device is not authenticated yet'));
				return false;
			}
			
			c_profile.units = apistatus['defaults']['units'];
			
			if ($('#pe_submit').text().indexOf('Create new record')>-1) {
				if (mongoprofiles.length > 1 && (new Date(c_profile.validfrom) <= new Date(mongoprofiles[1].validfrom))) {
					alert('Date must be greater than last record '+new Date(mongoprofiles[1].validfrom));
					$('#pe_status').hide().html('Wrong date').fadeIn("slow");
					return false;
				}
				
				// remove _id when creating new record
				delete c_profile._id;
				
				var dataJson = JSON.stringify(c_profile, null, ' ');

				var xhr = new XMLHttpRequest();
				xhr.open('POST', '/api/v1/profile/', true);
				xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
				xhr.setRequestHeader('api-secret', Nightscout.auth.hash());
				xhr.onload = function () {
					$('#pe_status').hide().text(xhr.statusText).fadeIn("slow");
					if (xhr.statusText=='OK') {
						var newprofile = clone(c_profile);
						mongoprofiles.unshift(newprofile);
						initeditor();
					}
				}
				xhr.send(dataJson);
			} else {
				// Update record
				var dataJson = JSON.stringify(c_profile, null, ' ');

				var xhr = new XMLHttpRequest();
				xhr.open('PUT', '/api/v1/profile/', true);
				xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
				xhr.setRequestHeader('api-secret', Nightscout.auth.hash());
				xhr.onload = function () {
					$('#pe_status').hide().text(xhr.statusText).fadeIn("slow");
				}
				xhr.send(dataJson);
			}

			return false;
		} catch (e) { alert(e.message); return false; }
	}

