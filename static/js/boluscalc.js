/*
	TODO:
	secret hash must be stored from editor. otherwise autohide quickpick fails

*/

(function () {
	'use strict';

	var quickpicks = [];
	var foods = [];

	var icon_remove = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACrElEQVQ4T42Ty2sTQRzHv5tmk2yyjRNtpfZhL8V6s2KoUNC2XqwgaCsVQcGiFqpHi0c9iRdR/ANE9KR40FIQX4cueKoPaKFoLdSYNtE0abKT1+5s9iW7aUMiHtzTzO7v85md+c6PA4DrHbsPCKIgOWO1pA7dT6YXnXH949SE/F63pqwZtRrO+SCKgjQ5NUV+azpmHj2krMwaJC4c8Erj+/eRyloMMwWFKgbn1nC3ervlK1evkXBLGBZT8SOewotnTylTNLdgeg/pDgZDC2cPHSR8bB22DVC9hFe0SG/H0xFXcHlykjRHRDBWgJcZSCY38Xx2lhqMnRYE34Px/sN9vlQWeoHBAx2yXsRruVAVuFsIBaSJ8+eJGPaBqQV4NROJjTzez89jLBoFn6FgybQL54wS3uTyVDFQ3cL2IYpBv3RhdJSIIQ80tQyv7gEqJvS8AmUlBs7UXPhtjtZgh3UFNYngk86NHCfNAg9dMwHVBPu+CpsVkTXKeJeVG+AGgTOZ3tt6MSKKjy+NjEBjFrR4ElZmA4pdxstMFsyyJu6tZZ7Ux9vwB6EAL50ZGiRECEPPUOixVTRxHlicgSVWxEdZpuZWfNuS2hk48NjwMIkIYZglBnV5Cbqtws/5IaAJmsfCglrEl2y2QeKmEBJ80tixKmxrFpSVr0gV0viQoxho2YUuPohmeFD22PiklLC4ma5JuBvdrfLJI0dJd0s7bM0ES8aR/BXDXGaTskqlL+D3Lwy0tZEePoAd4EA5YF4tYymdonfjmQh3s6dTPjU4SHYGwjAKecSXFyGlM1TdytntE56T+ts7SC/vhw3gm6njc2Kd3vm5Ub1IwQAvnYhGiZpYw1wiWYPrIw7wnBTt7CLOOwdmut14kQQvqt24tfK/utGR6LaF+iRqMf4N/O/8D28HiiCRYqzAAAAAAElFTkSuQmCC";

	function initBoluscalcDrawer()  {
		// Load quickpicks
		$.ajax('/api/v1/food/quickpicks.json', {
			success: function (records) {
				quickpicks = records;
				$('#bc_quickpick').empty().append(new Option('(none)',-1));
				for (var i=0; i<records.length; i++) {
					var r = records[i];
					$('#bc_quickpick').append(new Option(r.name+' ('+r.carbs+' g)',i));
				};
				$('#bc_quickpick').change(quickpickChange);
			}
		}).done(function() {calculateInsulin()});
		
		// Set units info
		if (browserSettings.units == 'mmol') $('#bc_units').text('mmol/L');
		else $('#bc_units').text('mg/dL');
		
		
		//Load BG
		var bg = 0;
		if (Nightscout.client.latestSGV) {
			bg = Nightscout.client.latestSGV.y;
			if (bg < 39) bg = 0;
			else bg = Nightscout.utils.scaleBg(bg)
			if (new Date().getTime() - Nightscout.client.latestSGV.x > 10 * 60 * 1000) bg = 0; // Do not use if record is older than 10 min
		}
		$('#bc_bg').val(bg);
		
		foods = [];
		$('#bc_usebg').prop('checked','checked');
		$('#bc_usecarbs').prop('checked','checked');
		$('#bc_usecob').prop('checked','');
		$('#bc_useiob').prop('checked','checked');
		$('#bc_bgfromsensor').prop('checked','checked');
		$('#bc_carbs').val('');
		$('#bc_quickpick').val(2);
		$('#bc_preBolus').val(0);
		$('#bc_notes').val('');
		$('#bc_enteredBy').val(browserStorage.get('enteredBy') || '');
		$('#bc_nowtime').prop('checked', true);
		$('#bc_othercorrection').val(0); 
	}
	
	function destroyBoluscalcDrawer() {
		Nightscout.utils.resetYAxisOffset();
		Nightscout.utils.updateBrushToNow();
	}

	if (isTouch())
		$('.insulincalculationpart').change(calculateInsulin); // Make it faster on mobile devices
	else {
		$('.insulincalculationpart').on('input',calculateInsulin);
		$('input:checkbox.insulincalculationpart').change(calculateInsulin);
	}
	$('#bc_bgfrommeter').change(calculateInsulin);
	$('#bc_addfromdatabase').click(addFoodFromDatabase);

	$('#bc_eventTime input:radio').change(function (event){
		if ($('#bc_othertime').is(':checked')) {
			$('#bc_eventTimeValue').focus();
		} else {
			calculateInsulin();
			Nightscout.utils.setYAxisOffset(50); //50% of extend
			Nightscout.utils.updateBrushToTime(mergeInputTime());
		}
		event.preventDefault();
	});

	$('.bc_eventtimeinput').focus(function (event) {
		$('#bc_othertime').prop('checked', true);
		var time = mergeInputTime();
		$(this).attr('oldminutes',time.getMinutes());
		$(this).attr('oldhours',time.getHours());
		event.preventDefault();
	});

	$('.bc_eventtimeinput').change(function (event) {
		$('#bc_othertime').prop('checked', true);
		event.preventDefault();
		calculateInsulin();
		Nightscout.utils.setYAxisOffset(50); //50% of extend
		var time = mergeInputTime();
		if ($(this).attr('oldminutes')==59 && time.getMinutes()==0) time.addHours(1);
		if ($(this).attr('oldminutes')==0 && time.getMinutes()==59) time.addHours(-1);
		$('#bc_eventTimeValue').val(time.toTimeString().slice(0,5));
		$('#bc_eventDateValue').val(time.toDateInputValue());
		Nightscout.utils.updateBrushToTime(time);
		$(this).attr('oldminutes',time.getMinutes());
		$(this).attr('oldhours',time.getHours());
	});


	$('#boluscalcDrawerToggle').click(function(event) {
		toggleDrawer('#boluscalcDrawer', initBoluscalcDrawer, destroyBoluscalcDrawer);
		event.preventDefault();
	});

	function calculateInsulin(event) {
		if (event) event.preventDefault();
		
		var units = browserSettings.units;
		var now = new Date();
		
		var boluscalc = {};
		var oldbg = false;
		var sensorbg = 0;
		
		// Clear results before check
		$('#bc_insulintotal').text('0.00');
		$('#bc_carbsneeded').text('0.00');
		$('#bc_inzulinbg').text('0.00');
		$('#bc_inzulincarbs').text('0.00');

		// Calculate event time from date & time
		boluscalc.eventTime = new Date();
		if ($('#bc_nowtime').is(':checked')) {
			$('#bc_eventTimeValue').val(new Date().toTimeString().slice(0,5));
			$('#bc_eventDateValue').val(new Date().toDateInputValue());
			$('#bc_retro').css('display','none');
			if (Nightscout.client.latestSGV) {
				sensorbg = Nightscout.client.latestSGV.y;
				if (sensorbg < 39) sensorbg = 0;
				else sensorbg = Nightscout.utils.scaleBg(sensorbg)
				if (now.getTime() - Nightscout.client.latestSGV.x > 10 * 60 * 1000) {
					oldbg = true; // Do not use if record is older than 10 min
					sensorbg = 0;
				}
			}
		} else {
			$('#bc_retro').css('display','');
			var time = $('#bc_eventTimeValue').val();
			var eventTimeParts = time.split(':');
			boluscalc.eventTime = new Date($('#bc_eventDateValue').val());
			boluscalc.eventTime.setHours(eventTimeParts[0]);
			boluscalc.eventTime.setMinutes(eventTimeParts[1]);
			boluscalc.eventTime.setSeconds(0);
			boluscalc.eventTime.setMilliseconds(0);
			sensorbg = findClosestSGVToPastTime(boluscalc.eventTime.getTime());
			if (sensorbg == 0) oldbg = true;
		}
			
		//Load BG
		if ($('#bc_bgfromsensor').is(':checked')) {
			$('#bc_bg').val(sensorbg ? sensorbg : '');
		}

		// Load IOB
		boluscalc.iob = 0;
		if ($('#bc_useiob').is(':checked')) {
			boluscalc.iob = parseFloat(Nightscout.iob.calcTotal(Nightscout.client.treatments,boluscalc.eventTime).iob);
			$('#bc_iob').text((boluscalc.iob > 0 ? '-' : '') + boluscalc.iob.toFixed(2));
		} else {
			$('#bc_iob').text('');
		}

		// Load COB
		var ic = Nightscout.currentProfile.ic(boluscalc.eventTime,units);
		if ($('#bc_usecob').is(':checked')) {
			boluscalc.cob = Nightscout.cob.calcTotal(Nightscout.client.treatments,boluscalc.eventTime,true).cob || 0;
			boluscalc.insulincob = roundTo00(boluscalc.cob / ic);
			$('#bc_cob').text(boluscalc.cob.toFixed(2));
			$('#bc_cobu').text(boluscalc.insulincob.toFixed(2));
		} else {
			boluscalc.cob = 0;
			boluscalc.insulincob = 0;
			$('#bc_cob').text('');
			$('#bc_cobu').text('');
		}

		// BG
		if ($('#bc_usebg').is(':checked')) {
			boluscalc.bg = parseFloat($('#bc_bg').val().replace(',','.'));
			if (boluscalc.bg == 0 || (oldbg && $('#bc_bgfromsensor').is(':checked'))) {
				$('#bc_bg').css('background-color','red');
			} else $('#bc_bg').css('background-color','');
			var bgdiff = 0;
			var targetBGLow = Nightscout.currentProfile.targetBGLow(boluscalc.eventTime,units);
			var targetBGHigh = Nightscout.currentProfile.targetBGHigh(boluscalc.eventTime,units);
			var isf = Nightscout.currentProfile.isf(boluscalc.eventTime,units);
			if (targetBGLow==0 || targetBGHigh==0 || isf==0) {
				$('#bc_inzulinbgtd').css('background-color','red');
				return null;
			} else $('#bc_inzulinbgtd').css('background-color','');
			if (boluscalc.bg <= targetBGLow) bgdiff = boluscalc.bg - targetBGLow;
			else if (boluscalc.bg >= targetBGHigh) bgdiff = boluscalc.bg - targetBGHigh;
			boluscalc.insulinbg = roundTo00(bgdiff / isf);
			$('#bc_inzulinbg').text(boluscalc.insulinbg.toFixed(2));
			$('#bc_inzulinbg').attr('title',
				'Target BG range: '+targetBGLow + ' - ' + targetBGHigh + 
				'\nISF: ' +  isf +
				'\nBG diff: ' +  bgdiff.toFixed(1)
				);
		} else {
			boluscalc.bg = 0;
			boluscalc.insulinbg = 0;
			$('#bc_inzulinbgtd').css('background-color','');
			$('#bc_bg').css('background-color','');
			$('#bc_inzulinbg').text('');
		}
		
		// Foods
		if (foods.length) {
			var carbs = 0, gisum = 0;
			var html = '<table  style="float:right;margin-right:20px;font-size:12px">';
			for (var fi=0; fi<foods.length; fi++) {
				var f = foods[fi];
				carbs += f.carbs * f.portions;
				gisum += f.carbs * f.portions * f.gi;
				html += '<tr>';
				html += '<td>';
				html += '<img style="cursor:pointer" title="Delete record" src="'+icon_remove+'" href="#" class="deleteFoodRecord" index="'+fi+'">';
				html += '</td>';
				html += '<td>'+ f.name + '</td>';
				html += '<td>'+ (f.portion*f.portions).toFixed(1) + ' ' + f.unit + '</td>';
				html += '<td>('+ (f.carbs*f.portions).toFixed(1) + ' g)</td>';
				html += '</tr>';
			}
			html += '</table>';
			$('#bc_food').html(html);
			$('.deleteFoodRecord').click(deleteFoodRecord);
			$('#bc_carbs').val(carbs.toFixed(0));
			$('#bc_carbs').attr('disabled',true);
			$('#bc_gi').css('display','none');
			$('#bc_gicalculated').css('display','');
			boluscalc.gi = (gisum/carbs).toFixed(2);
			$('#bc_gicalculated').text(boluscalc.gi);
			//$('#bc_gitd').attr('colspan','');
		} else {
			$('#bc_food').html('');
			$('#bc_carbs').attr('disabled',false);
			boluscalc.gi = $('#bc_gi').val();
			$('#bc_gi').css('display','');
			$('#bc_gicalculated').css('display','none');
			$('#bc_gicalculated').text('');
			//$('#bc_gitd').attr('colspan',3);
		}
		boluscalc.foods = clone(foods);
		
		// Carbs
		if ($('#bc_usecarbs').is(':checked')) {
			boluscalc.carbs = parseInt($('#bc_carbs').val().replace(',','.'));
			if ($('#bc_carbs').val()=='') {
				boluscalc.carbs = 0;
				$('#bc_carbs').css('background-color','');
			} else if (isNaN(boluscalc.carbs)) {
				$('#bc_carbs').css('background-color','red');
				return null;
			} else $('#bc_carbs').css('background-color','');
			if (Nightscout.currentProfile.ic(boluscalc.eventTime)==0) {
				$('#bc_inzulincarbstd').css('background-color','red');
				return null;
			} else $('#bc_inzulincarbstd').css('background-color','');
			boluscalc.insulincarbs = roundTo00(boluscalc.carbs / ic);
			$('#bc_inzulincarbs').text(boluscalc.insulincarbs.toFixed(2));
			$('#bc_inzulincarbs').attr('title','IC: ' +  ic);
		} else {
			boluscalc.carbs = 0;
			boluscalc.insulincarbs = 0;
			$('#bc_carbs').css('background-color','');
			$('#bc_inzulincarbs').text('');
		}
		
		
		// Corrections
		boluscalc.othercorrection = parseFloat($('#bc_othercorrection').val().replace(',','.'));

		// Total & rounding
		var total = 0;
		if ($('#bc_useinsulin').is(':checked')) {
			total = boluscalc.insulinbg + boluscalc.insulincarbs + boluscalc.insulincob - boluscalc.iob + boluscalc.othercorrection;
		}
		boluscalc.insulin = floorTo005(total);
		boluscalc.roundingcorrection = boluscalc.insulin - total;
		
		$('#bc_rouding').text(boluscalc.roundingcorrection.toFixed(2));
		$('#bc_insulintotal').text(boluscalc.insulin);
		
		// Carbs needed if too much iob
		boluscalc.carbsneeded = 0;
		if (boluscalc.insulin<0) {
			boluscalc.carbsneeded = Math.round(-total * ic);
			$('#bc_carbsneeded').text(boluscalc.carbsneeded+' g');
			$('#bc_insulinover').text(boluscalc.insulin.toFixed(2));
			$('#bc_carbsneededtr').css('display','');
			$('#bc_insulinneededtr').css('display','none');
			//$('#bc_submit').css('display','none');
		} else {
			$('#bc_carbsneeded').text('');
			$('#bc_insulinover').text('');
			$('#bc_carbsneededtr').css('display','none');
			$('#bc_insulinneededtr').css('display','');
		}
		
		// Basal rate
		$('#bc_basal').text(Nightscout.currentProfile.basal(boluscalc.eventTime).toFixed(3));
		console.log('Insulin calculation: ',boluscalc);
		return boluscalc;
	}

	function roundTo00(x) {
		return Math.round(100*x) / 100;
	}
	
	function floorTo005(x) {
		return (5 * Math.floor(100*x/5)) / 100;
	}
	
	function mergeInputTime() {
		var value = $('#bc_eventTimeValue').val();
		var eventTimeParts = value.split(':');
		var eventTime = new Date($('#bc_eventDateValue').val());
		eventTime.setHours(eventTimeParts[0]);
		eventTime.setMinutes(eventTimeParts[1]);
		eventTime.setSeconds(0);
		eventTime.setMilliseconds(0);
		return eventTime;
	}
	
	function boluscalcSubmit(event) {
		if (event) event.preventDefault();

		var data = {};
		data.boluscalc = calculateInsulin();
		if (!data.boluscalc) {
			alert('Calculation not completed!');
			return;
		}
		
		data.enteredBy = $('#bc_enteredBy').val();
		data.eventType = 'Bolus Wizard';
		if ($('#bc_bg').val()!=0) {
			data.glucose = $('#bc_bg').val();
			data.glucoseType = $('#bc_bgfrommeter').is(':checked') ? 'Finger' : (  $('#bc_bgfromsensor').is(':checked') ? 'Sensor' : 'Manual');
			data.units = browserSettings.units;
		}
		data.carbs = $('#bc_carbs').val();
		data.insulin = $('#bc_insulintotal').text();
		if (data.insulin<=0) delete data.insulin;
		data.preBolus = parseInt($('#bc_preBolus').val());
		data.notes = $('#bc_notes').val();

		var eventTimeDisplay = '';
		if ($('#bc_othertime').is(':checked')) {
			data.eventTime = mergeInputTime();
			eventTimeDisplay = data.eventTime.toLocaleString();
		}

		var dataJson = JSON.stringify(data, null, ' ');

		var ok = window.confirm(
				translate('Please verify that the data entered is correct')+': ' +
				'\n'+translate('Event Type')+': ' + data.eventType +
				(data.glucose ? '\n'+translate('Blood Glucose')+': ' + data.glucose : '')+
				(data.glucoseType ? '\n'+translate('Method')+': ' + data.glucoseType : '')+
				(data.carbs ? '\n'+translate('Carbs Given')+': ' + data.carbs : '' )+
				(data.insulin ? '\n'+translate('Insulin Given')+': ' + data.insulin : '')+
				(data.preBolus ? '\n'+translate('Pre Bolus')+': ' + data.preBolus : '')+
				(data.notes ? '\n'+translate('Notes')+': ' + data.notes : '' )+
				(data.enteredBy ? '\n'+translate('Entered By')+': ' + data.enteredBy : '' )+
				($('#bc_othertime').is(':checked') ? '\n'+translate('Event Time')+': ' + eventTimeDisplay : '')
		);

		if (ok) {
			var xhr = new XMLHttpRequest();
			xhr.open('POST', '/api/v1/treatments/', true);
			xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
			xhr.send(dataJson);

			browserStorage.set('enteredBy', data.enteredBy);

			quickpickHideFood();
			closeDrawer('#boluscalcDrawer',destroyBoluscalcDrawer);
		}
		return false;
	}

	// Food manipulation
	function deleteFoodRecord(event) {
		var index = $(this).attr('index');
		foods.splice(index,1);
		calculateInsulin();
		if (event) event.preventDefault();
		return false;
	}
	
	function quickpickChange(event) {
		var qpiselected = $('#bc_quickpick').val();
		
		if (qpiselected == -1) { // (none)
			$('#bc_carbs').val(0);
			foods = [];
		} else {
			var qp = quickpicks[qpiselected];
			foods = clone(qp.foods);
		}
		
		calculateInsulin();
		if (event) event.preventDefault();
	}
	
	function quickpickHideFood() {
		var qpiselected = $('#bc_quickpick').val();
		
		if (qpiselected == -1) { // (none)
			return;
		} else {
			var qp = quickpicks[qpiselected];
			if (qp.hideafteruse) {
				qp.hidden = true;

				var apisecrethash = localStorage.getItem('apisecrethash');
				var dataJson = JSON.stringify(qp, null, ' ');

				var xhr = new XMLHttpRequest();
				xhr.open('PUT', '/api/v1/food/', true);
				xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
				xhr.setRequestHeader('api-secret', apisecrethash);
				xhr.send(dataJson);
			}
		}
		
		calculateInsulin();
		if (event) event.preventDefault();
	}
	
	var categories = [];
	var foodlist = [];
	var databaseloaded = false;
	var filter = {
		  category: ''
		, subcategory: ''
		, name: ''
	};
	
	function loadDatabase(callback) {
		categories = [];
		foodlist = [];
		$.ajax('/api/v1/food/regular.json', {
			success: function (records) {
				records.forEach(function (r) {
					foodlist.push(r);
					if (r.category && !categories[r.category]) categories[r.category] = {};
					if (r.category && r.subcategory) categories[r.category][r.subcategory] = true;
				});
				databaseloaded = true;
				console.log('Food database loaded');
				fillForm();
			}
		}).done(function() { if (callback) callback(); } );
	}

	function fillForm(event) {
		$('#bc_filter_category').empty().append(new Option('(none)',''));
		for (var s in categories) {
			$('#bc_filter_category').append(new Option(s,s));
		}
		filter.category = '';
		fillSubcategories();
		
		$('#bc_filter_category').change(fillSubcategories);
		$('#bc_filter_subcategory').change(doFilter);
		$('#bc_filter_name').on('input',doFilter);
	
		if (event) event.preventDefault();
		return false;
	}

	function fillSubcategories(event) {
		if (event) {
			event.preventDefault();
		}
		filter.category = $('#bc_filter_category').val();
		filter.subcategory = '';
		$('#bc_filter_subcategory').empty().append(new Option('(none)',''));
		if (filter.category != '') {
			for (var s in categories[filter.category]) {
				$('#bc_filter_subcategory').append(new Option(s,s));
			}
		}
		doFilter();
	}
	
	function doFilter(event) {
		if (event) {
			filter.category = $('#bc_filter_category').val();
			filter.subcategory = $('#bc_filter_subcategory').val();
			filter.name = $('#bc_filter_name').val();
		}
		$('#bc_data').empty();
		for (var i=0; i<foodlist.length; i++) {
			if (filter.category != '' && foodlist[i].category != filter.category) continue;
			if (filter.subcategory != '' && foodlist[i].subcategory != filter.subcategory) continue;
			if (filter.name!= '' && foodlist[i].name.toLowerCase().indexOf(filter.name.toLowerCase())<0) continue;
			var o = '';
			o += foodlist[i].name + ' | ';
			o += 'Portion: ' + foodlist[i].portion + ' ';
			o += foodlist[i].unit + ' | ';
			o += 'Carbs: ' + foodlist[i].carbs+' g';
			$('#bc_data').append(new Option(o,i));
		}
		$('#bc_addportions').val("1");
		
		if (event) event.preventDefault();
	}
	
	function addFoodFromDatabase(event) {
		if (!databaseloaded) {
			loadDatabase(addFoodFromDatabase);
			if (event) event.preventDefault();
			return;
		}
		
		$('#bc_addportions').val("1");
		$( "#bc_addfooddialog" ).dialog({
			  width: 640
			, height: 400
			,  buttons: [
				{ text: translate("Add"),
				  click: function() {
					var index = $('#bc_data').val();
					var portions = parseFloat($('#bc_addportions').val().replace(',','.'));
					if (index != null && !isNaN(portions) && portions >0) {
						foodlist[index].portions = portions;
						foods.push(clone(foodlist[index]));
						calculateInsulin();
						$( this ).dialog( "close" );
					}
				  }
				},
				{ text: translate("Reload database"),
				  class: 'leftButton',
				  click: loadDatabase
				}
			  ]
			, open   : function(ev, ui) {
				$(this).parent().css('box-shadow', '20px 20px 20px 0px black');
				$(this).parent().find('.ui-dialog-buttonset'      ).css({'width':'100%','text-align':'right'})
				$(this).parent().find('button:contains("'+translate('Add')+'")').css({'float':'left'});
				$('#bc_filter_name').focus();
			}

		});
		if (event) event.preventDefault();
		return false;
	}


	function clone(obj) {
		if (null == obj || "object" != typeof obj) return obj;
		var copy = obj.constructor();
		for (var attr in obj) {
			if (obj.hasOwnProperty(attr)) copy[attr] = obj[attr];
		}
		return copy;
	}

	Date.prototype.toDateInputValue = (function() {
		var local = new Date(this);
		local.setMinutes(this.getMinutes() - this.getTimezoneOffset());
		return local.toJSON().slice(0,10);
	});

	Date.prototype.addHours = function(h) {    
	   this.setTime(this.getTime() + (h*60*60*1000)); 
	   return this;   
	}    
	
	function findClosestSGVToPastTime(time) {
        var closeBGs = Nightscout.client.data.filter(function(d) {
		  if (d.color == 'transparent') return false;
		  if (d.type != 'sgv') return false;
          if (!d.y) {
            return false;
          } else {
            return Math.abs((new Date(d.date)).getTime() - time) <= 10 * 60 * 1000;
          }
        });
		
		// If there are any in 10 min range try 5 min 1st
		var closeBG5m = closeBGs.filter(function(d) {
            return Math.abs((new Date(d.date)).getTime() - time) <= 5 * 60 * 1000;
        });
		if (closeBG5m.length>0) closeBGs = closeBG5m;

        var totalBG = 0;
        closeBGs.forEach(function(d) {
          totalBG += Number(d.y);
        });

        return totalBG > 0 ? Nightscout.utils.scaleBg(totalBG / closeBGs.length) : 0;
      }

	
	Nightscout.boluscalc = Nightscout.boluscalc || {};
    Nightscout.boluscalc.calculateInsulin = calculateInsulin;
    Nightscout.boluscalc.boluscalcSubmit = boluscalcSubmit;
})();

