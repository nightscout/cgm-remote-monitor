/* Code by Milos Kozak

TODO:
	- treatment drawer must be updated to enter glycemic index
	- update calculation to use new style of values
	- how to handle units? store native or convert to mg/dL?

*/
	var profile = {};
	var apisecret = "", storeapisecret = false;
	
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
			"ic": [{"from":0,"val":24},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0}
					],
			"car_high": 30,
			"car_medium": 30,
			"car_low": 30,
			"isf": [{"from":0,"val":17},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0}
					],

			// Basal rates
			"basal": [{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0},
					{"from":0,"val":0}
					]
	};

	var GuiToVal = [
			// API secret
			{ "html":"pe_apisecret", 		"type":"text" , 	"settings":"apisecret" },
			{ "html":"pe_storeapisecret",	"type":"checkbox" , "settings":"storeapisecret" },
	
			// General
			{ "html":"pe_input_simple",		"type":"checkbox" , "settings":"profile.simple" },
			{ "html":"pe_input_calculator",	"type":"checkbox" , "settings":"profile.calculator" },
			{ "html":"pe_dia", 				"type":"float" , 	"settings":"profile.dia" },
			
			{ "html":"pe_validfrom", 		"type":"date" , 	"settings":"profile.validfrom" },
			
			// Simple style values
			{ "html":"pe_if", 			"type":"int" , 			"settings":"profile.carbratio" },
			{ "html":"pe_hr", 			"type":"int" , 			"settings":"profile.carbs_hr" },
			{ "html":"pe_isf", 			"type":"int" , 			"settings":"profile.sens" },
			
			//Bolus calculator style values
			{ "html":"pe_hr_high", 		"type":"int" , 			"settings":"profile.car_high" },
			{ "html":"pe_hr_medium",	"type":"int" , 			"settings":"profile.car_medium" },
			{ "html":"pe_hr_low", 		"type":"int" , 			"settings":"profile.car_low" },
			
			{ "html":"pe_if_from_0", 	"type":"dropdownval" ,	"settings":"profile.ic[0].from" },
			{ "html":"pe_if_0", 		"type":"int" ,			"settings":"profile.ic[0].val" },
			{ "html":"pe_if_from_1", 	"type":"dropdownval" ,	"settings":"profile.ic[1].from" },
			{ "html":"pe_if_1", 		"type":"int" ,			"settings":"profile.ic[1].val" },
			{ "html":"pe_if_from_2", 	"type":"dropdownval" ,	"settings":"profile.ic[2].from" },
			{ "html":"pe_if_2", 		"type":"int" ,			"settings":"profile.ic[2].val" },
			{ "html":"pe_if_from_3", 	"type":"dropdownval" ,	"settings":"profile.ic[3].from" },
			{ "html":"pe_if_3", 		"type":"int" ,			"settings":"profile.ic[3].val" },
			{ "html":"pe_if_from_4", 	"type":"dropdownval" ,	"settings":"profile.ic[4].from" },
			{ "html":"pe_if_4", 		"type":"int" ,			"settings":"profile.ic[4].val" },
			{ "html":"pe_if_from_5", 	"type":"dropdownval" ,	"settings":"profile.ic[5].from" },
			{ "html":"pe_if_5", 		"type":"int" ,			"settings":"profile.ic[5].val" },
			{ "html":"pe_if_from_6", 	"type":"dropdownval" ,	"settings":"profile.ic[6].from" },
			{ "html":"pe_if_6", 		"type":"int" ,			"settings":"profile.ic[6].val" },
			{ "html":"pe_if_from_7", 	"type":"dropdownval" ,	"settings":"profile.ic[7].from" },
			{ "html":"pe_if_7", 		"type":"int" ,			"settings":"profile.ic[7].val" },
			{ "html":"pe_if_from_8", 	"type":"dropdownval" ,	"settings":"profile.ic[8].from" },
			{ "html":"pe_if_8", 		"type":"int" ,			"settings":"profile.ic[8].val" },
			{ "html":"pe_if_from_9", 	"type":"dropdownval" ,	"settings":"profile.ic[9].from" },
			{ "html":"pe_if_9", 		"type":"int" ,			"settings":"profile.ic[9].val" },
			{ "html":"pe_if_from_10", 	"type":"dropdownval" ,	"settings":"profile.ic[10].from" },
			{ "html":"pe_if_10", 		"type":"int" ,			"settings":"profile.ic[10].val" },
			{ "html":"pe_if_from_11", 	"type":"dropdownval" ,	"settings":"profile.ic[11].from" },
			{ "html":"pe_if_11", 		"type":"int" ,			"settings":"profile.ic[11].val" },
			
			{ "html":"pe_isf_from_0", 	"type":"dropdownval" ,	"settings":"profile.isf[0].from" },
			{ "html":"pe_isf_0", 		"type":"int" ,			"settings":"profile.isf[0].val" },
			{ "html":"pe_isf_from_1", 	"type":"dropdownval" ,	"settings":"profile.isf[1].from" },
			{ "html":"pe_isf_1", 		"type":"int" ,			"settings":"profile.isf[1].val" },
			{ "html":"pe_isf_from_2", 	"type":"dropdownval" ,	"settings":"profile.isf[2].from" },
			{ "html":"pe_isf_2", 		"type":"int" ,			"settings":"profile.isf[2].val" },
			{ "html":"pe_isf_from_3", 	"type":"dropdownval" ,	"settings":"profile.isf[3].from" },
			{ "html":"pe_isf_3", 		"type":"int" ,			"settings":"profile.isf[3].val" },
			{ "html":"pe_isf_from_4", 	"type":"dropdownval" ,	"settings":"profile.isf[4].from" },
			{ "html":"pe_isf_4", 		"type":"int" ,			"settings":"profile.isf[4].val" },
			{ "html":"pe_isf_from_5", 	"type":"dropdownval" ,	"settings":"profile.isf[5].from" },
			{ "html":"pe_isf_5", 		"type":"int" ,			"settings":"profile.isf[5].val" },
			{ "html":"pe_isf_from_6", 	"type":"dropdownval" ,	"settings":"profile.isf[6].from" },
			{ "html":"pe_isf_6", 		"type":"int" ,			"settings":"profile.isf[6].val" },
			{ "html":"pe_isf_from_7", 	"type":"dropdownval" ,	"settings":"profile.isf[7].from" },
			{ "html":"pe_isf_7", 		"type":"int" ,			"settings":"profile.isf[7].val" },
			{ "html":"pe_isf_from_8", 	"type":"dropdownval" ,	"settings":"profile.isf[8].from" },
			{ "html":"pe_isf_8", 		"type":"int" ,			"settings":"profile.isf[8].val" },
			{ "html":"pe_isf_from_9", 	"type":"dropdownval" ,	"settings":"profile.isf[9].from" },
			{ "html":"pe_isf_9", 		"type":"int" ,			"settings":"profile.isf[9].val" },
			{ "html":"pe_isf_from_10", 	"type":"dropdownval" ,	"settings":"profile.isf[10].from" },
			{ "html":"pe_isf_10", 		"type":"int" ,			"settings":"profile.isf[10].val" },
			{ "html":"pe_isf_from_11", 	"type":"dropdownval" ,	"settings":"profile.isf[11].from" },
			{ "html":"pe_isf_11", 		"type":"int" ,			"settings":"profile.isf[11].val" },
			
			{ "html":"pe_basal_from_0", 	"type":"dropdownval" ,	"settings":"profile.basal[0].from" },
			{ "html":"pe_basal_0", 		"type":"int" ,			"settings":"profile.basal[0].val" },
			{ "html":"pe_basal_from_1", 	"type":"dropdownval" ,	"settings":"profile.basal[1].from" },
			{ "html":"pe_basal_1", 		"type":"int" ,			"settings":"profile.basal[1].val" },
			{ "html":"pe_basal_from_2", 	"type":"dropdownval" ,	"settings":"profile.basal[2].from" },
			{ "html":"pe_basal_2", 		"type":"int" ,			"settings":"profile.basal[2].val" },
			{ "html":"pe_basal_from_3", 	"type":"dropdownval" ,	"settings":"profile.basal[3].from" },
			{ "html":"pe_basal_3", 		"type":"int" ,			"settings":"profile.basal[3].val" },
			{ "html":"pe_basal_from_4", 	"type":"dropdownval" ,	"settings":"profile.basal[4].from" },
			{ "html":"pe_basal_4", 		"type":"int" ,			"settings":"profile.basal[4].val" },
			{ "html":"pe_basal_from_5", 	"type":"dropdownval" ,	"settings":"profile.basal[5].from" },
			{ "html":"pe_basal_5", 		"type":"int" ,			"settings":"profile.basal[5].val" },
			{ "html":"pe_basal_from_6", 	"type":"dropdownval" ,	"settings":"profile.basal[6].from" },
			{ "html":"pe_basal_6", 		"type":"int" ,			"settings":"profile.basal[6].val" },
			{ "html":"pe_basal_from_7", 	"type":"dropdownval" ,	"settings":"profile.basal[7].from" },
			{ "html":"pe_basal_7", 		"type":"int" ,			"settings":"profile.basal[7].val" },
			{ "html":"pe_basal_from_8", 	"type":"dropdownval" ,	"settings":"profile.basal[8].from" },
			{ "html":"pe_basal_8", 		"type":"int" ,			"settings":"profile.basal[8].val" },
			{ "html":"pe_basal_from_9", 	"type":"dropdownval" ,	"settings":"profile.basal[9].from" },
			{ "html":"pe_basal_9", 		"type":"int" ,			"settings":"profile.basal[9].val" },
			{ "html":"pe_basal_from_10", 	"type":"dropdownval" ,	"settings":"profile.basal[10].from" },
			{ "html":"pe_basal_10", 		"type":"int" ,			"settings":"profile.basal[10].val" },
			{ "html":"pe_basal_from_11", 	"type":"dropdownval" ,	"settings":"profile.basal[11].from" },
			{ "html":"pe_basal_11", 		"type":"int" ,			"settings":"profile.basal[11].val" },
			{ "html":"pe_basal_from_12", 	"type":"dropdownval" ,	"settings":"profile.basal[12].from" },
			{ "html":"pe_basal_12", 		"type":"int" ,			"settings":"profile.basal[12].val" },
			{ "html":"pe_basal_from_13", 	"type":"dropdownval" ,	"settings":"profile.basal[13].from" },
			{ "html":"pe_basal_13", 		"type":"int" ,			"settings":"profile.basal[13].val" },
			{ "html":"pe_basal_from_14", 	"type":"dropdownval" ,	"settings":"profile.basal[14].from" },
			{ "html":"pe_basal_14", 		"type":"int" ,			"settings":"profile.basal[14].val" },
			{ "html":"pe_basal_from_15", 	"type":"dropdownval" ,	"settings":"profile.basal[15].from" },
			{ "html":"pe_basal_15", 		"type":"int" ,			"settings":"profile.basal[15].val" },
			{ "html":"pe_basal_from_16", 	"type":"dropdownval" ,	"settings":"profile.basal[16].from" },
			{ "html":"pe_basal_16", 		"type":"int" ,			"settings":"profile.basal[16].val" },
			{ "html":"pe_basal_from_17", 	"type":"dropdownval" ,	"settings":"profile.basal[17].from" },
			{ "html":"pe_basal_17", 		"type":"int" ,			"settings":"profile.basal[17].val" },
			{ "html":"pe_basal_from_18", 	"type":"dropdownval" ,	"settings":"profile.basal[18].from" },
			{ "html":"pe_basal_18", 		"type":"int" ,			"settings":"profile.basal[18].val" },
			{ "html":"pe_basal_from_19", 	"type":"dropdownval" ,	"settings":"profile.basal[19].from" },
			{ "html":"pe_basal_19", 		"type":"int" ,			"settings":"profile.basal[19].val" },
			{ "html":"pe_basal_from_20", 	"type":"dropdownval" ,	"settings":"profile.basal[20].from" },
			{ "html":"pe_basal_20", 		"type":"int" ,			"settings":"profile.basal[20].val" },
			{ "html":"pe_basal_from_21", 	"type":"dropdownval" ,	"settings":"profile.basal[21].from" },
			{ "html":"pe_basal_21", 		"type":"int" ,			"settings":"profile.basal[21].val" },
			{ "html":"pe_basal_from_22", 	"type":"dropdownval" ,	"settings":"profile.basal[22].from" },
			{ "html":"pe_basal_22", 		"type":"int" ,			"settings":"profile.basal[22].val" },
			{ "html":"pe_basal_from_23", 	"type":"dropdownval" ,	"settings":"profile.basal[23].from" },
			{ "html":"pe_basal_23", 		"type":"int" ,			"settings":"profile.basal[23].val" }
	];
	
	var apistatus = {};
	var mongoprofiles = [];

	// load api secret from browser storage
	apisecret = localStorage.getItem('apisecret');
	if (apisecret) storeapisecret = true;

	
   // Fetch data from mongo
   $('#pe_status').hide().text('Loading status ...').fadeIn("slow");
   // status with defaults first
   $.ajax('/api/v1/status.json', {
        success: function (xhr) {
            apistatus = { 
                  apiEnabled: xhr.apiEnabled
				, defaults: xhr.defaults //  { ...., defaults: {time-format: '24', display-units: 'mmol'} }
			};
       },
		error: function () {
			alert('Error loading your defaults. 12H and mg/dL will be used');
			apistatus = { 'defaults': { 'time-format': '12', 'display-units': 'mg/dL', 'language': 'en'} };
		}
    }).done(function () {
		$('#pe_status').hide().text('Loading profile records ...').fadeIn("slow");
		$.ajax('/api/v1/profile.json', {
			success: function (records) {
				mongoprofiles = records;
				// create new profile to be edited from last record
				if (records[0] && records[0].dia) {
					// Use only values(keys) defined in defaultprofile, drop the rest. Preparation for future changes.
					profile = defaultprofile;
					for (var key in records[0]) {
						if (typeof profile[key] != 'undefined') 
							profile[key] = records[0][key];
						// copy _id of record too
						if (key == '_id') 
							profile[key] = records[0][key];
						// default validfrom is current date
						if (key == 'validfrom')
							profile[key] = new Date();
					}
					$('#pe_status').hide().text('Values loaded.').fadeIn("slow");
					mongoprofiles.unshift(profile);
				} else {
					profile = defaultprofile;
					mongoprofiles.unshift(profile);
					$('#pe_status').hide().text('Default values used.').fadeIn("slow");
				}
			},
			error: function () {
				profile = defaultprofile;
				mongoprofiles.unshift(profile);
				$('#pe_status').hide().text('Error. Default values used.').fadeIn("slow");
			}
		}).done(initeditor);
	});
	
	function initeditor() {
		// Add handler for style switching
		$('#pe_input_simple').change(switchStyle);
		$('#pe_input_calculator').change(switchStyle);

		// display status
		$('#pe_units').text(apistatus['defaults']['display-units']);
		$('#pe_timeformat').text(apistatus['defaults']['time-format']+'h');
		
		//timepicker
		$('#pe_validfrom').datetimepicker({
			  lang: apistatus['defaults']['language']
			, mask: true
			, stepMinute: 15
			, timeFormat: apistatus['defaults']['time-format'] == '12' ? 'hh:mm p' : 'HH:mm'
			, dateFormat: apistatus['defaults']['time-format'] == '12' ? 'mm/dd/yy' : 'd.m.yy'
			, minDate: mongoprofiles[1] && mongoprofiles[1].validfrom ? mongoprofiles[1].validfrom : null
			//this has a serious bug
			//, minDateTime: mongoprofiles[1] && mongoprofiles[1].validfrom ? mongoprofiles[1].validfrom : null
			, maxDate: new Date()
			, maxDateTime: new Date()
		});

		// Set values from profile to html
		fillFrom();
		// hide unused style of ratios
		switchStyle();
		
		
		console.log('Done initeditor()');
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
		var endof_isf = false, endof_if = false,  endof_basal = false;

		// I:F
		for (var i=0; i<defaultprofile.ic.length; i++) {
			$("#pe_if_from_"+i).bind("change",null);
			$("#pe_if_from_"+i).empty();
			for (var t=0;t<49;t++) {
				if (i==0 && t>0) continue;
				if (i>0 && isNaN(profile.ic[i-1].from)) continue;
				if (i>0 && profile.ic[i-1].from >= t*30) continue;
				if (endof_if) continue;
				if (apistatus['defaults']['time-format']=='24') {
					$("#pe_if_from_"+i).append(new Option(mmoltime[t],t*30));
				} else {
					$("#pe_if_from_"+i).append(new Option(mgtime[t],t*30));
				}
			}
			//read value if modified because time not available anymore
			$("#pe_if_from_"+i).val(profile.ic[i].from);
			if (!$("#pe_if_from_"+i).val())	$("#pe_if_from_"+i).prop("selectedIndex",0);
			profile.ic[i].from = $("#pe_if_from_"+i).val();
			if (profile.ic[i].from == 48*30)  { endof_if = true; profile.ic[i].val = 0; }
			// bind handler back
			$("#pe_if_from_"+i).bind("change",fillFrom);
		}
			
		// ISF
		for (var i=0; i<defaultprofile.isf.length; i++) {
			$("#pe_isf_from_"+i).bind("change",null);
			$("#pe_isf_from_"+i).empty();
			for (var t=0;t<49;t++) {
				if (i==0 && t>0) continue;
				if (i>0 && isNaN(profile.isf[i-1].from)) continue;
				if (i>0 && profile.isf[i-1].from >= t*30) continue;
				if (endof_isf) continue;
				if (apistatus['defaults']['time-format']=='24') {
					$("#pe_isf_from_"+i).append(new Option(mmoltime[t],t*30));
				} else {
					$("#pe_isf_from_"+i).append(new Option(mgtime[t],t*30));
				}
			}
			//read value if modified because time not available anymore
			$("#pe_isf_from_"+i).val(profile.isf[i].from);
			if (!$("#pe_isf_from_"+i).val()) $("#pe_isf_from_"+i).prop("selectedIndex",0);
			profile.isf[i].from = $("#pe_isf_from_"+i).val();
			if (profile.isf[i].from == 48*30) { endof_isf = true; profile.isf[i].val = 0; }
			// bind handler back
			$("#pe_isf_from_"+i).bind("change",fillFrom);
		}	

		// basal
		for (var i=0; i<defaultprofile.basal.length; i++) {
			$("#pe_basal_from_"+i).bind("change",null);
			$("#pe_basal_from_"+i).empty();
			for (var t=0;t<49;t++) {
				if (i==0 && t>0) continue;
				if (i>0 && isNaN(profile.basal[i-1].from)) continue;
				if (i>0 && profile.basal[i-1].from >= t*30) continue;
				if (endof_basal) continue;
				if (apistatus['defaults']['time-format']=='24') {
					$("#pe_basal_from_"+i).append(new Option(mmoltime[t],t*30));
				} else {
					$("#pe_basal_from_"+i).append(new Option(mgtime[t],t*30));
				}
			}
			//read value if modified because time not available anymore
			$("#pe_basal_from_"+i).val(profile.basal[i].from);
			if (!$("#pe_basal_from_"+i).val()) $("#pe_basal_from_"+i).prop("selectedIndex",0);
			profile.basal[i].from = $("#pe_basal_from_"+i).val();
			if (profile.basal[i].from == 48*30) { endof_basal = true; profile.basal[i].val = 0; }
			// bind handler back
			$("#pe_basal_from_"+i).bind("change",fillFrom);
			
		}
		updateGUI();
		if (event) {
			event.preventDefault();
		}
		return false;
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
					$('#'+GuiToVal[ii].html).datetimepicker('setDate', new Date());
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
			} catch (e) { alert('Wrong value entered: '+GuiToVal[ii].html+'  '+GuiToVal[ii].settings + ' ' + e.message); }
		}
		console.log(JSON.stringify(profile));
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
			if (new Date(profile.validfrom) > new Date()) {
				alert('Date must be set in the past');
				$('#pe_status').hide().html('Wrong date').fadeIn("slow");
				return false;
			}
			
			if (mongoprofiles.length > 1 && (new Date(profile.validfrom) <= new Date(mongoprofiles[1].validfrom))) {
				alert('Date must be greater than last record '+new Date(mongoprofiles[1].validfrom));
				$('#pe_status').hide().html('Wrong date').fadeIn("slow");
				return false;
			}
			
			if (apisecret.length != 15) {
				alert('You API secret must be exactly 15 characters long');
				$('#pe_status').hide().html('Bad API secret').fadeIn("slow");
				return false;
			}
			
			// remove _id when creating new record
			// must be changed if we decide to have ability to edit old records
			delete profile._id;
			
			var dataJson = JSON.stringify(profile, null, ' ');
			// create apisecret hash
			var secrethash = CryptoJS.SHA1(apisecret);

			var xhr = new XMLHttpRequest();
			xhr.open('POST', '/api/v1/profile/', true);
			xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
			xhr.setRequestHeader('api-secret', secrethash);
			xhr.onload = function () {
				$('#pe_status').hide().text(xhr.statusText).fadeIn("slow");
				if (xhr.statusText=='OK') {
					var newprofile = clone(profile);
					newprofile.validfrom = new Date();
					mongoprofiles.unshift(newprofile);
					initeditor();
				}
			}
			xhr.send(dataJson);

			// store or remove from browser store api secret
			if (storeapisecret) 
				localStorage.setItem('apisecret',apisecret);
			else
				localStorage.removeItem('apisecret');
			return false;
		} catch (e) { alert(e.message); return false; }
	}


