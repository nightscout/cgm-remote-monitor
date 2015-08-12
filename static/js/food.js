/* Code by Milos Kozak

*/
	var foodrec_template = { 
		  _id: ''
		, type: 'food'
		, category: ''
		, subcategory: ''
		, name: ''
		, portion: 0
		, carbs: 0
		, gi: 2
		, unit: ''
	};

	var foodunits = ['g', 'ml', 'pcs'];
	
	var foodrec = clone(foodrec_template);

	var HIDDEN = 99999;
	var quickpickrec_template = { 
		  _id: ''
		, type: 'quickpick'
		, name: ''
		, foods: []
		, carbs: 0
		, hideafteruse: true
		, hidden: false
		, position: HIDDEN
	};

	var filter = {
		  category: ''
		, subcategory: ''
		, name: ''
	};
	
	var GuiToVal = [
			// API secret
			{ "html":"fe_filter_category", 		"type":"dropdownval" , 	"settings":"filter.category" },
			{ "html":"fe_filter_subcategory", 	"type":"dropdownval" , 	"settings":"filter.subcategory" },
			{ "html":"fe_filter_name", 			"type":"text" , 		"settings":"filter.name" },
			
			{ "html":"fe_id", 					"type":"text" , 		"settings":"foodrec._id" },
			{ "html":"fe_category", 			"type":"text" , 		"settings":"foodrec.category" },
			{ "html":"fe_subcategory", 			"type":"text" , 		"settings":"foodrec.subcategory" },
			{ "html":"fe_name", 				"type":"text" , 		"settings":"foodrec.name" },
			{ "html":"fe_portion", 				"type":"int" , 			"settings":"foodrec.portion" },
			{ "html":"fe_unit", 				"type":"dropdownval" , 	"settings":"foodrec.unit" },
			{ "html":"fe_carbs", 				"type":"int" , 			"settings":"foodrec.carbs" },
			{ "html":"fe_gi", 					"type":"int" , 			"settings":"foodrec.gi" },

			{ "html":"fe_quickpick_showhidden",	"type":"checkbox" , 	"settings":"showhidden" }
			
	];
	
	//https://www.iconfinder.com/iconsets/musthave
	var icon_add = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABa0lEQVQ4T6WTzysEYRjHP+/Mrv2hHOTuqJRNOfgPSORHokg4OClHcnVzVygHF6WIcuHMnyCHVRyI3ZYxa23vzOzs7LzamaI0e5i89fTWt/f5vPV5n1cQsXLbHepvfLv5JaLORoZNwMbyFo5vYfsWB0c7xAasLa5T/vCg45Oj48P4gJWFVYxCA63L5PzkND5gfm4Jo+Chd5W5OrtsDYgS1pQ1OTuNUfTQO8tcX9xE+QugYnS/X81MzGP7MpTWkEFVZY1KxcVPV3h27zAtA+oCagIcDfWUCgEje31qfHwK06gHjaF5iXQcHCV5lHmqqgQCNEAI0IsavCVDwNBurxoeGwmaAkDDwvYsqtIh//6AJUoklP97s62BbJYeAqIcpJNZsoM+r2aVbKKOekiBL8An3BuAEiGg1SSKAYnttpFxPdR9Jv4zipxFTUuQKqsfYbFGWfTYuO06yRfxIyweoLuG+iMsFuBfvzFy7FqE33vs2BFqlfN5AAAAAElFTkSuQmCC";
	var icon_remove = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACrElEQVQ4T42Ty2sTQRzHv5tmk2yyjRNtpfZhL8V6s2KoUNC2XqwgaCsVQcGiFqpHi0c9iRdR/ANE9KR40FIQX4cueKoPaKFoLdSYNtE0abKT1+5s9iW7aUMiHtzTzO7v85md+c6PA4DrHbsPCKIgOWO1pA7dT6YXnXH949SE/F63pqwZtRrO+SCKgjQ5NUV+azpmHj2krMwaJC4c8Erj+/eRyloMMwWFKgbn1nC3ervlK1evkXBLGBZT8SOewotnTylTNLdgeg/pDgZDC2cPHSR8bB22DVC9hFe0SG/H0xFXcHlykjRHRDBWgJcZSCY38Xx2lhqMnRYE34Px/sN9vlQWeoHBAx2yXsRruVAVuFsIBaSJ8+eJGPaBqQV4NROJjTzez89jLBoFn6FgybQL54wS3uTyVDFQ3cL2IYpBv3RhdJSIIQ80tQyv7gEqJvS8AmUlBs7UXPhtjtZgh3UFNYngk86NHCfNAg9dMwHVBPu+CpsVkTXKeJeVG+AGgTOZ3tt6MSKKjy+NjEBjFrR4ElZmA4pdxstMFsyyJu6tZZ7Ux9vwB6EAL50ZGiRECEPPUOixVTRxHlicgSVWxEdZpuZWfNuS2hk48NjwMIkIYZglBnV5Cbqtws/5IaAJmsfCglrEl2y2QeKmEBJ80tixKmxrFpSVr0gV0viQoxho2YUuPohmeFD22PiklLC4ma5JuBvdrfLJI0dJd0s7bM0ES8aR/BXDXGaTskqlL+D3Lwy0tZEePoAd4EA5YF4tYymdonfjmQh3s6dTPjU4SHYGwjAKecSXFyGlM1TdytntE56T+ts7SC/vhw3gm6njc2Kd3vm5Ub1IwQAvnYhGiZpYw1wiWYPrIw7wnBTt7CLOOwdmut14kQQvqt24tfK/utGR6LaF+iRqMf4N/O/8D28HiiCRYqzAAAAAAElFTkSuQmCC";
	var icon_edit = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABEUlEQVQ4jZ3MMUsCYQDG8ee8IySQbNCLyyEKG/RLNAXicqvQcAeNLrcFLlE0+xHuNpt8wy04rrYm8Q4HQRE56BSC3lSqU1BwCoxM39dnffj9BWyxXvVeEzvtctBwHyRebNu2Nk2lzMlrgJB+qBEeTByiKYpihl+fIO8jTI9PDJEVF1+K2iw+M6PhDuyag4NkQi/c3FkCK5Z3ZbM76qLltpCbn+vXxq0FABsDy9hzPdBvqvtXvvXzrw1swmsDLPjfACteGeDBfwK8+FdgGwwAIgC0ncsjxGRSH/eiPBgAJADY2z8sJ4JBfNBsDqlADVYMANIzKalv/bHaefKsTH9iPFb8ISsGAJym0+Qinz3jQktbAHcxvx3559eSAAAAAElFTkSuQmCC";
	var icon_up = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAH3SURBVDhPlZK/a1NRFMe/9/1KotLcwbYiipo2NqmDpTpoiJiguPgPCC7iYAcbYp0LxUGkxVr6Y6lgu6iLm4uCQszi4JS6FHQRFMRBDOJrcvPyEs+97+V3A+2Bw7nvcr6f973nXoZ+8RQTqCGn1hrSuIOCWneF5tfO8MWZ2Ax/NPmYB1kop/Z2iV6AL56O3eNj4TP4Lf7iVnSKm7ByWOuFdAJ88d14lp8Oj+P9jw/Y/vMFBgK4GbnNLUaQpU5Iawbt4gEpzqPiVmirprqi/BRKjo0XW5vFSkmkMevNxAM0bPvidyQuuwJuvUrbdTBWh6ZpGOOjEM4Onn/aKIoyQR6gwBriTHzGs/09j5Jbxo5rw67aEDWhfuOiCkM3cO7wWdQcB68+viyKfyKt4zq2s/H7/OJQEj9Lv6BrOkbCJ/H62xvYBHFAx2Aurh5LITJwAgfMIA6GDiEyPBL8/LVwg2GdPHbF/PllLGwtI2CYlBYsqteOp7H6dhFkxEvHqxqmyGB70szkeU2ya+l0eSQOmh5ECR9SzzzlE8oVsN53IKm0LQGmQRCTXBBAfitAV/QBMBLoTRfyKMqBtN0VfQFymAogXZB4Xw6YD9DJheGDDFrvHUDlytHLSB1J4tJwAonBCwSk1l0ArafciDm6Vtko07+qZrqUz9o1wH8prahHZgYc2gAAAABJRU5ErkJggg==";
	
	var foodlist = [];
	var foodquickpick = [];
	var foodquickpicktodelete = [];
	var showhidden = false;
	var categories = {};
	

	// Fetch data from mongo
	$('#fe_status').hide().text('Loading food database ...').fadeIn("slow");
	$.ajax('/api/v1/food.json', {
		success: function (records) {
			records.forEach(function (r) {
				if (r.type == 'food') {
					foodlist.push(r);
					if (r.category && !categories[r.category]) categories[r.category] = {};
					if (r.category && r.subcategory) categories[r.category][r.subcategory] = true;
				} else if (r.type == 'quickpick') calculateCarbs(foodquickpick.push(r)-1);
				else console.log('Unknown food database record');
			});
			$('#fe_status').hide().text(translate('Database loaded')).fadeIn("slow");
			foodquickpick.sort(function (a,b) { return cmp(parseInt(a.position),parseInt(b.position)) });
		},
		error: function () {
			$('#fe_status').hide().text(translate('Error: Database failed to load')).fadeIn("slow");
		}
	}).done(initeditor);
	
	function initeditor() {
		// Add handlers for gui
		$('#fe_editcreate').click(foodSubmit);
		$('#fe_clear').click(clearRec);
		$('#fe_id').change(updateSaveButton);
		$('#fe_quickpick_add').click(quickpickCreateRecord);
		$('#fe_quickpick_save').click(quickpickSave);
		$('#fe_filter_category').change(fillSubcategories);
		$('#fe_filter_subcategory').change(doFilter);
		$('#fe_quickpick_showhidden').change(showHidden);
		$('#fe_filter_name').on('input',doFilter);
		$('#fe_category_list').change(function(event) { $('#fe_category').val($('#fe_category_list').val()); fillSubcategories(event,true) });
		$('#fe_subcategory_list').change(function(event) { $('#fe_subcategory').val($('#fe_subcategory_list').val())});
		$('#fe_unit').empty();
		for (var u=0; u<foodunits.length; u++) $('#fe_unit').append(new Option(foodunits[u],foodunits[u]));
	
		// Set values from profile to html
		fillForm();
		// show proper submit button
		updateSaveButton();

		console.log('Done initeditor()');
	}
	
	function updateSaveButton(event) {
		if($('#fe_id').val()=='') {
			$('#fe_editcreate').text(translate('Create new record'));
		} else {
			$('#fe_editcreate').text(translate('Save record'));
		}
		if (event) {
			event.preventDefault();
		}
	}
	
	function fillSubcategories(event,editrec) {
		if (event) {
			event.preventDefault();
			saveSettings();
		}
		if (!editrec) {
			filter.subcategory = '';
			$('#fe_filter_subcategory').empty().append(new Option(translate('(none)'),''));
			if (filter.category != '') {
				for (s in categories[filter.category]) {
					$('#fe_filter_subcategory').append(new Option(s,s));
				}
			}
			doFilter();
		} else {
			foodrec.subcategory = '';
			$('#fe_subcategory_list').empty().append(new Option(translate('(none)'),''));
			if (foodrec.category != '') {
				for (s in categories[foodrec.category]) {
					$('#fe_subcategory_list').append(new Option(s,s));
				}
			}
			$('#fe_subcategory').val('');
		}
	}
	
	function doEdit(index) {
		foodrec = clone(foodlist[index]);
		updateGUI();
		updateSaveButton();
	}
	
	function updateFoodArray(newrec) {
		for (var i=0; i<foodlist.length; i++) {
			if (foodlist[i]._id == newrec._id) {
				foodlist[i] = clone(newrec);
				if (newrec.category && !categories[newrec.category]) categories[newrec.category] = {};
				if (newrec.category && newrec.subcategory) categories[newrec.category][newrec.subcategory] = true;
				return;
			}
		}
	}

	function fillForm(event) {
		$('#fe_filter_category').empty().append(new Option(translate('(none)'),''));
		$('#fe_category_list').empty().append(new Option(translate('(none)'),''));
		for (s in categories) {
			$('#fe_filter_category').append(new Option(s,s));
			$('#fe_category_list').append(new Option(s,s));
		}
		fillSubcategories();
		drawQuickpick();
		
		updateGUI();
		if (event) {
			event.preventDefault();
		}
		return false;
	}
	
	function doFilter(event) {
		if (event) saveSettings();
		var html = '';
		$('#fe_data_header').html(
			'<span class="fs50"></span>'+
			'<span class="fs200">'+translate('Name')+'</span>'+
			'<span class="fs150" style="text-align:center;">'+translate('Portion')+'</span>'+
			'<span class="fs50" style="text-align:center;">'+translate('Unit')+'</span>'+
			'<span class="fs100" style="text-align:center;">'+translate('Carbs')+' [g]</span>'+
			'<span class="fs100" style="text-align:center;">'+translate('GI')+' [1-3]</span>'+
			'<span class="fs150">'+translate('Category')+'</span>'+
			'<span class="fs150">'+translate('Subcategory')+'</span>'
		);
		for (var i=0; i<foodlist.length; i++) {
			if (filter.category != '' && foodlist[i].category != filter.category) continue;
			if (filter.subcategory != '' && foodlist[i].subcategory != filter.subcategory) continue;
			if (filter.name!= '' && foodlist[i].name.toLowerCase().indexOf(filter.name.toLowerCase())<0) continue;
			html += '<div index="'+i+'" class="draggablefood" style="background-color:gray;border: 2px solid #000;cursor:move;">';
			html += '<span class="fs50">';
			html += '<img style="cursor:pointer" title="'+translate('Edit record')+'" src="'+icon_edit+'" href="#" onclick="doEdit('+i+'); return false;"> ';
			html += '<img style="cursor:pointer" title="'+translate('Delete record')+'" src="'+icon_remove+'" href="#" onclick="return deleteFoodRecord('+i+');">';
			html += '</span>';
			html += '<span class="fs200">'+foodlist[i].name+'</span>';
			html += '<span class="fs150" style="text-align:center;">'+foodlist[i].portion+'</span>';
			html += '<span class="fs50" style="text-align:center;">'+foodlist[i].unit+'</span>';
			html += '<span class="fs100" style="text-align:center;">'+foodlist[i].carbs+'</span>';
			html += '<span class="fs100" style="text-align:center;">'+foodlist[i].gi+'</span>';
			html += '<span class="fs150">'+foodlist[i].category+'</span>';
			html += '<span class="fs150">'+foodlist[i].subcategory+'</span>';
			html += '</div>';
		}
		
		html += '';
		$('#fe_data').html(html);

		$('.draggablefood').draggable({
			helper: function(){
				return $(this).clone().width($(this).width()).height($(this).height());
			},
//				start: function () { g_actions_dragorigin = 'draggablefood'; },
			scope: 'foodlist',
			revert: "invalid"
		});

		if (event) {
			event.preventDefault();
		}
	}
	
	function deleteQuickpickRecord(index) {
		foodquickpicktodelete.push(foodquickpick[index]._id);
		foodquickpick.splice(index,1);
		drawQuickpick();
		return false;
	}
	
	function deleteFoodRecord(index) {
		deleteRecord(foodlist[index]._id);
		foodlist.splice(index,1);
		fillForm();
		return false;
	}
	
	function quickpickFindById(_id) {
		for (var i=0; i<foodquickpick.length; i++) {
			if (foodquickpick[i]._id == _id) return foodquickpick[i];
		}
		return null;
	}
	
	function showHidden(event) {
		saveSettings();
		drawQuickpick();
		if (event) {
			event.preventDefault();
		}
		return false;
	}
	
	function drawQuickpick() {
		var html = '';
		var hiddentotal = 0;
		for (var i=0; i<foodquickpick.length; i++) {
			var q = foodquickpick[i];
			if (showhidden == false && q.hidden) { hiddentotal++; continue; }
			html += '<fieldset class="sortablequickpick" index="'+i+'" _id="'+q._id+'" style="cursor:move;background-color:#383838" >';
			html += '<legend>';
			html += '<img style="cursor:pointer" title="'+translate('Move to the top')+'" src="'+icon_up+'" href="#" onclick="return quickpickMoveToTop('+i+');">';
			html += ' | <img style="cursor:pointer" title="'+translate('Delete record')+'" src="'+icon_remove+'" href="#" onclick="return deleteQuickpickRecord('+i+');">';
			html += ' | '+translate('Name')+': <input type="text" class="fq_name" index="'+i+'" value="'+q.name+'">';
			html += ' <input type="checkbox" class="fq_hidden" index="'+i+'"'+(q.hidden ? ' checked' : '')+'>'+translate('Hidden');
			html += ' <input type="checkbox" class="fq_hideafteruse" index="'+i+'"'+(q.hideafteruse ? ' checked' : '')+'>'+translate('Hide after use');
			html += ' | '+translate('Carbs')+': '+q.carbs.toFixed(0) + ' g';
			html += '</legend>';
//			html += '<br>';

			if (q.foods.length) {
				html +=
					'<span class="fs50"></span>'+
					'<span class="fs200">'+translate('Name')+'</span>'+
					'<span class="fs150" style="text-align:center;">'+translate('Portion')+' [g,ml]</span>'+
					'<span class="fs100" style="text-align:center;">'+translate('Carbs')+' [g]</span>'+
					'<br>';
			} else {
				html += '<i>-&gt; Drag&drop food here</i>';
			}

			for (var j=0;j<q.foods.length; j++) {
				var r = q.foods[j];
				html += '<div style="background-color:gray;border: 2px solid" id="fqp_food_'+i+'_'+j+'">';
				html += '<span class="fs50">';
				html += '<img style="cursor:pointer" title="'+translate('Delete record')+'" src="'+icon_remove+'" href="#" onclick="return deleteQuickpickFood('+i+','+j+');">';
				html += '</span>';
				html += '<span class="fs200">'+r.name+'</span>';
				html += '<span class="fs150" style="text-align:center;">'+r.portion+'</span>';
				html += '<span class="fs100" style="text-align:center;">'+r.carbs+'</span>';
				html += ''+translate('Portions')+': <input type="text" id="fq_portions_'+q._id+'_'+j+'" value="'+r.portions+'" onchange="return savePortions('+i+','+j+',$(this).val());">';
				html += '</div>';
			}
			html += '</fieldset>';
		}
		
		$('#fe_picklist').html(html);
		$('#fe_quickpick_hiddencount').text(hiddentotal ? (' ('+hiddentotal+')') : '');

		$('.fq_name').change(function (event) {
			var index = $(this).attr('index');
			foodquickpick[index].name = $(this).val();
		});
		$('.fq_hidden').change(function (event) {
			var index = $(this).attr('index');
			foodquickpick[index].hidden = this.checked;
			if (!this.checked)
				foodquickpick.splice(0, 0, foodquickpick.splice(index, 1)[0]);
			drawQuickpick();
		});
		
		$('.fq_hideafteruse').change(function (event) {
			var index = $(this).attr('index');
			foodquickpick[index].hideafteruse = this.checked;
		});
		
		$('.sortablequickpick').droppable({
			hoverClass: "ui-state-hover",
			drop: dropFood,
			scope: 'foodlist',
			greedy: true
		});
		$('#fe_picklist').sortable({
			  revert: true
			, axis: 'y'
			, placeholder: "highlight"
			, update: resortArray
		});
	}
	
	function savePortions(i,j,val) {
		foodquickpick[i].foods[j].portions=val.replace(/\,/g,'.');
		calculateCarbs(i);
		drawQuickpick();
		return false;
	}
	
	function deleteQuickpickFood(index,findex) {
		foodquickpick[index].foods.splice(findex,1);
		calculateCarbs(index);
		drawQuickpick();
		return false;
	}
	
	function dropFood(event,ui) {

		var item = ui.draggable;
		var fi = foodlist[item.attr('index')];
		
		var qi = $(this).attr('index');
		var q = foodquickpick[qi];
		
		fi.portions = 1;
		q.foods.push(fi);
		calculateCarbs(qi);
		
		drawQuickpick();
	}

	function calculateCarbs(index) {
		var qp = foodquickpick[index];
		qp.carbs = 0;
		for (var j=0;j<qp.foods.length; j++) {
			qp.carbs += qp.foods[j].carbs * qp.foods[j].portions;
		}
	}
	
	function resortArray(event,ui) {
      var newHtmlIndex = ui.item.index();
	  var oldArrayIndex = ui.item.attr('index');
	  var insertBeforArrayIndex = this.childNodes[newHtmlIndex+1].attributes.index.nodeValue;
	  foodquickpick.splice(insertBeforArrayIndex, 0, foodquickpick.splice(oldArrayIndex, 1)[0]);
	  //drawQuickpick();
	  return;
	}
	
	function quickpickMoveToTop(index) {
	  foodquickpick.splice(0, 0, foodquickpick.splice(index, 1)[0]);
	  drawQuickpick();
	  return;
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
	
	function updateGuiToVal(rec) {
		for (var i=0; i<GuiToVal.length; i++) {
			if (GuiToVal[i].html==rec.html) {
				GuiToVal[i] = rec;
				return;
			}
		}
		GuiToVal.push(rec);
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
		//console.info(JSON.stringify(c_profile));
	}
	
	function clearRec(event) {
		if (event) event.preventDefault();
		foodrec = clone(foodrec_template);
		updateGUI();
		updateSaveButton();
		return false;
	}
	
	function foodSubmit(event) {
		saveSettings();

		if (!Nightscout.auth.isAuthenticated()) {
			alert(translate('Your device is not authenticated yet'));
			return false;
		}
			
		if ($('#fe_editcreate').text().indexOf(translate('Create new record'))>-1) {
			
			// remove _id when creating new record
			delete foodrec._id;
			
			var dataJson = JSON.stringify(foodrec, null, ' ');

			var xhr = new XMLHttpRequest();
			xhr.open('POST', '/api/v1/food/', true);
			xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
			xhr.setRequestHeader('api-secret', Nightscout.auth.hash());
			xhr.onload = function () {
				$('#fe_status').hide().text(xhr.statusText).fadeIn("slow");
				if (xhr.statusText=='OK') {
					var newrec = JSON.parse(xhr.responseText)[0];
					foodlist.push(newrec);
					if (foodrec.category && !categories[foodrec.category]) categories[foodrec.category] = {};
					if (foodrec.category && foodrec.subcategory) categories[foodrec.category][foodrec.subcategory] = true;
					clearRec();
					fillForm();
				}
			}
			xhr.send(dataJson);
		} else {
			// Update record
			var dataJson = JSON.stringify(foodrec, null, ' ');

			var xhr = new XMLHttpRequest();
			xhr.open('PUT', '/api/v1/food/', true);
			xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
			xhr.setRequestHeader('api-secret', Nightscout.auth.hash());
			xhr.onload = function () {
				$('#fe_status').hide().text(xhr.statusText).fadeIn("slow");
				if (xhr.statusText=='OK') {
					updateFoodArray(foodrec);
					clearRec();
					fillForm();
				}
			}
			xhr.send(dataJson);
		}

		if (event) event.preventDefault();
		return false;
	}

	function deleteRecord(_id) {
		if (!Nightscout.auth.isAuthenticated()) {
			alert(translate('Your device is not authenticated yet'));
			return false;
		}
			
		var dataJson = JSON.stringify(_id, null, ' ');

		var xhr = new XMLHttpRequest();
		xhr.open('DELETE', '/api/v1/food/'+_id, true);
		xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
		xhr.setRequestHeader('api-secret', Nightscout.auth.hash());
		xhr.onload = function () {
			$('#fe_status').hide().text(xhr.statusText).fadeIn("slow");
			if (xhr.statusText=='OK') {
			}
		}
		xhr.send(null);

		return false;

	}

	function updateRecord(foodrec) {
		if (!Nightscout.auth.isAuthenticated()) {
			alert(translate('Your device is not authenticated yet'));
			return false;
		}
			
		var dataJson = JSON.stringify(foodrec, null, ' ');

		var xhr = new XMLHttpRequest();
		xhr.open('PUT', '/api/v1/food/', true);
		xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
		xhr.setRequestHeader('api-secret', Nightscout.auth.hash());
		xhr.send(dataJson);
	}

	function quickpickCreateRecord(event) {
		try {
			var newrec = clone(quickpickrec_template);
			
			if (!Nightscout.auth.isAuthenticated()) {
				alert(translate('Your device is not authenticated yet'));
				return false;
			}
				
			// remove _id when creating new record
			delete newrec._id;
			
			var dataJson = JSON.stringify(newrec, null, ' ');

			var xhr = new XMLHttpRequest();
			xhr.open('POST', '/api/v1/food/', true);
			xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
			xhr.setRequestHeader('api-secret', Nightscout.auth.hash());
			xhr.onload = function () {
				$('#fe_status').hide().text(xhr.statusText).fadeIn("slow");
				if (xhr.statusText=='OK') {
					var newrec = JSON.parse(xhr.responseText)[0];
					foodquickpick.push(newrec);
					drawQuickpick();
				}
			}
			xhr.send(dataJson);

			if (event) event.preventDefault();
			return false;

		} catch (e) { alert(e.message); return false; }
	}

	function quickpickSave(event) {
		if (!Nightscout.auth.isAuthenticated()) {
			alert(translate('Your device is not authenticated yet'));
			return false;
		}
			
		for (var i=0; i<foodquickpicktodelete.length; i++) {
			deleteRecord(foodquickpicktodelete[i]);
		}
		
		for (var i=0; i<foodquickpick.length; i++) {
			var fqp = foodquickpick[i];
			if (fqp.hidden) fqp.position = HIDDEN;
			else fqp.position = i;
			updateRecord(fqp);
		}
		
		if (event) event.preventDefault();
		return false;
	}
	
	function cmp(v1,v2){
		return (v1<v2?-1:(v1>v2?1:0));
	}

