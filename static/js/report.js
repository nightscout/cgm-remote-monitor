//TODO: clean up
var app = {}, browserSettings = {}, browserStorage = $.localStorage;

    'use strict';

	var containerprefix = 'chart-';
	var maxdays = 3 * 31;
	var datastorage = {};
	var daystoshow = {};
	
	var targetBGdefault = {
		"mg/dL": { low: 72, high: 180 },
		"mmol": { low: 4, high: 10 }
	};
	
	var maxInsulinValue = 0
		, maxCarbsValue = 0;
    var 
          ONE_MIN_IN_MS = 60000
        , SIX_MINS_IN_MS =  360000
        , FORMAT_TIME_12 = '%I'
        , FORMAT_TIME_24 = '%H'
		;

	var categories = [];
	var foodlist = [];
	
    var padding = { top: 15, right: 15, bottom: 30, left: 30 };
		
     function getTimeFormat() {
        var timeFormat = FORMAT_TIME_12;
        if (browserSettings.timeFormat) {
            if (browserSettings.timeFormat == '24') {
                timeFormat = FORMAT_TIME_24;
            }
        }
        return timeFormat;
    }

    // lixgbg: Convert mg/dL BG value to metric mmol
    function scaleBg(bg) {
        if (browserSettings.units == 'mmol') {
            return (Math.round((bg / 18) * 10) / 10).toFixed(1);
        } else {
            return bg;
        }
    }

    function rawIsigToRawBg(entry, cal) {

      var raw = 0
        , unfiltered = parseInt(entry.unfiltered) || 0
        , filtered = parseInt(entry.filtered) || 0
        , sgv = entry.y
        , scale = parseFloat(cal.scale) || 0
        , intercept = parseFloat(cal.intercept) || 0
        , slope = parseFloat(cal.slope) || 0;


        if (slope == 0 || unfiltered == 0 || scale == 0) {
          raw = 0;
        } else if (filtered == 0 || sgv < 40) {
            raw = scale * (unfiltered - intercept) / slope;
        } else {
            var ratio = scale * (filtered - intercept) / slope / sgv;
            raw = scale * ( unfiltered - intercept) / slope / ratio;
        }

        return Math.round(raw);
    }

    function drawChart(day,data,options) {
       var   tickValues
			, charts
			, context
			, xScale2, yScale2
			, yInsulinScale, yCarbsScale
			, xAxis2, yAxis2
			, dateFn = function (d) { return new Date(d.date) }
			, foodtexts = 0;

        // Tick Values
        if (browserSettings.units == 'mmol') {
            tickValues = [
                  2.0
                , 4.0
                , 6.0
                , 8.0
                , 10.0
                , 12.0
                , 14.0
                , 16.0
                , 18.0
                , 20.0
                , 22.0
            ];
        } else {
            tickValues = [
                  40
                , 80
                , 120
                , 160
                , 200
                , 240
                , 280
                , 320
                , 360
                , 400
            ];
        }

        // create svg and g to contain the chart contents
        charts = d3.select('#'+containerprefix+day).html(
			'<b>'+
			localeDate(day)+
			'</b><br>'
		).append('svg');

		charts.append("rect")
			.attr("width", "100%")
			.attr("height", "100%")
			.attr("fill", "WhiteSmoke");
			
        context = charts.append('g');

		// define the parts of the axis that aren't dependent on width or height
        xScale2 = d3.time.scale()
            .domain(d3.extent(data.sgv, function (d) { return d.date; }));

//        yScale2 = d3.scale.log()
        yScale2 = d3.scale.linear()
            .domain([scaleBg(36), scaleBg(420)]);

        yInsulinScale = d3.scale.linear()
            .domain([0, maxInsulinValue*2]);

        yCarbsScale = d3.scale.linear()
            .domain([0, maxCarbsValue*1.25]);

		xAxis2 = d3.svg.axis()
          .scale(xScale2)
          .tickFormat(d3.time.format(getTimeFormat(true)))
          .ticks(24)
          .orient('bottom');

        yAxis2 = d3.svg.axis()
            .scale(yScale2)
            .tickFormat(d3.format('d'))
            .tickValues(tickValues)
//            .orient('right');
            .orient('left');

		// get current data range
        var dataRange = d3.extent(data.sgv, dateFn);

        // get the entire container height and width subtracting the padding
        var chartWidth = options.width - padding.left - padding.right;
        var chartHeight = options.height - padding.top - padding.bottom;
 
 		//set the width and height of the SVG element
		charts.attr('width', options.width)
			.attr('height', options.height)
            /*.attr('transform', 'translate(' + padding.left + ',' + padding.top + ')')*/;
			
		// ranges are based on the width and height available so reset
		xScale2.range([0, chartWidth]);
		yScale2.range([chartHeight,0]);
		yInsulinScale.range([chartHeight,0]);
		yCarbsScale.range([chartHeight,0]);

		// add target BG rect
		context.append('rect')
			.attr('x', xScale2(dataRange[0])+padding.left)
			.attr('y', yScale2(options.targetHigh)+padding.top)
			.attr('width', xScale2(dataRange[1]- xScale2(dataRange[0])))
			.attr('height', yScale2(options.targetLow)-yScale2(options.targetHigh))
			.style('fill', '#D6FFD6')
			.attr('stroke', 'grey');

        // create the x axis container
        context.append('g')
            .attr('class', 'x axis');

        // create the y axis container
        context.append('g')
            .attr('class', 'y axis');

		context.select('.y')
			.attr('transform', 'translate(' + (/*chartWidth + */ padding.left) + ',' + padding.top + ')')
			.style('stroke', 'black')
			.style('shape-rendering', 'crispEdges')
			.style('fill', 'none')
			.call(yAxis2);

		// if first run then just display axis with no transition
		context.select('.x')
			.attr('transform', 'translate(' + padding.left + ',' + (chartHeight + padding.top) + ')')
			.style('stroke', 'black')
			.style('shape-rendering', 'crispEdges')
			.style('fill', 'none')
			.call(xAxis2);

		for (var li in tickValues) {
			context.append('line')
				.attr('class', 'high-line')
				.attr('x1', xScale2(dataRange[0])+padding.left)
				.attr('y1', yScale2(tickValues[li])+padding.top)
				.attr('x2', xScale2(dataRange[1])+padding.left)
				.attr('y2', yScale2(tickValues[li])+padding.top)
				.style('stroke-dasharray', ('3, 3'))
				.attr('stroke', 'grey');
		}

        // bind up the context chart data to an array of circles
        var contextCircles = context.selectAll('circle')
            .data(data.sgv);

        function prepareContextCircles(sel) {
            var badData = [];
            sel.attr('cx', function (d) { 
					return xScale2(d.date) + padding.left; 
				})
                .attr('cy', function (d) {
                    if (isNaN(d.sgv)) {
                        badData.push(d);
                        return yScale2(scaleBg(450) + padding.top);
                    } else {
                        return yScale2(d.sgv) + padding.top;
                    }
                })
                .attr('fill', function (d) { 
					if (d.color == 'gray' && !options.raw) return 'transparent';
					return d.color; 
				})
                .style('opacity', function (d) { 0.5 })
                .attr('stroke-width', function (d) {if (d.type == 'mbg') return 2; else return 0; })
                .attr('stroke', function (d) { return 'black'; })
                .attr('r', function(d) { if (d.type == 'mbg') return 4; else return 2;});

            if (badData.length > 0) {
                console.warn("Bad Data: isNaN(sgv)", badData);
            }

            return sel;
        }

        // if new circle then just display
        prepareContextCircles(contextCircles.enter().append('circle'));

        contextCircles.exit()
            .remove();

		var to = new Date(day).addDays(1).addMinutes(new Date().getTimezoneOffset());
		var from = new Date(day).addMinutes(new Date().getTimezoneOffset());
		var iobpolyline = '', cobpolyline = '';
		for (var dt=from; dt < to; dt.addMinutes(5)) {
			if (options.iob) {
				var iob = Nightscout.iob.calcTotal(data.treatments,dt).display;
/*
				context.append('circle')
					.attr('cx', xScale2(dt) + padding.left)
					.attr('cy', yInsulinScale(iob) + padding.top)
					.attr('fill', 'DarkOrchid')
					.style('opacity', 1)
					.attr('stroke-width', 0)
					.attr('stroke', 'black')
					.attr('r', 1.2);
*/
				if (dt!=from) iobpolyline += ', ';
				iobpolyline += (xScale2(dt) + padding.left) + ',' + (yInsulinScale(iob) + padding.top) + ' ';
			}
			if (options.cob) {
				var cob = Nightscout.cob.calcTotal(data.treatments,dt,true).cob;
/*
				context.append('circle')
					.attr('cx', xScale2(dt) + padding.left)
					.attr('cy', yCarbsScale(cob) + padding.top)
					.attr('fill', 'olive')
					.style('opacity', 1)
					.attr('stroke-width', 0)
					.attr('stroke', 'black')
					.attr('r', 1.2);
*/
				if (dt!=from) cobpolyline += ', ';
				cobpolyline += (xScale2(dt) + padding.left) + ',' + (yCarbsScale(cob) + padding.top) + ' ';
			}
		}
		if (options.iob) 
			context.append('polyline')
				  .attr('stroke', 'blue')
				  .attr('opacity', '0.5')
				  .attr('fill-opacity', '0.1')
				  .attr('points',iobpolyline);
				
		if (options.cob) 
			context.append('polyline')
				  .attr('stroke', 'red')
				  .attr('opacity', '0.5')
				  .attr('fill-opacity', '0.1')
				  .attr('points',cobpolyline);
				

        data.treatments.forEach(function (treatment) {
		  if (treatment.boluscalc && treatment.boluscalc.foods && treatment.boluscalc.foods.length > 0 || treatment.notes) {
				  var lastfoodtext = foodtexts;
				  var drawpointer = false;
				  if (treatment.boluscalc && treatment.boluscalc.foods && treatment.boluscalc.foods.length > 0 && options.food) {
					  var foods = treatment.boluscalc.foods;
					  for (var fi=0; fi<foods.length; fi++) {
						var f = foods[fi];
						var text = ''+ f.name + ' ';
		//				text += ''+ (f.portion*f.portions).toFixed(1) + ' ' + f.unit + ' ';
						text += ''+ (f.carbs*f.portions).toFixed(1) + ' g';
						context.append('text')
						  .style('font-size', '10px')
						  .style('font-weight', 'normal')
					  //    .attr('text-anchor', 'left')
						  .attr('fill', 'black')
						  .attr('y', foodtexts * 15 /*yCarbsScale(treatment.carbs)-50*/)
						  .attr('transform', 'translate(' + (xScale2(treatment.created_at.getTime()) + padding.left) + ',' + padding.top + ')')
						  .html(text);
						foodtexts = (foodtexts+1)%6;
						drawpointer = true;
					  }
				  }
				  if (treatment.notes && options.notes) {
					context.append('text')
					  .style('font-size', '10px')
					  .style('font-weight', 'normal')
				  //    .attr('text-anchor', 'left')
					  .attr('fill', 'black')
					  .attr('y', foodtexts * 15 /*yCarbsScale(treatment.carbs)-50*/)
					  .attr('transform', 'translate(' + (xScale2(treatment.created_at.getTime()) + padding.left) + ',' + padding.top + ')')
					  .html(treatment.notes);
					foodtexts = (foodtexts+1)%6;
					drawpointer = true;
				  }
				  if (drawpointer) {
					  context.append('line')
						.attr('class', 'high-line')
						.attr('x1', xScale2(treatment.created_at.getTime()) + padding.left)
						.attr('y1', lastfoodtext * 15 + padding.top)
						.attr('x2', xScale2(treatment.created_at.getTime()) + padding.left)
						.attr('y2', padding.top + treatment.carbs ? yCarbsScale(treatment.carbs) : ( treatment.insulin ? yInsulinScale(treatment.insulin) : chartHeight))
						.style('stroke-dasharray', ('1, 7'))
						.attr('stroke', 'grey');
				  }
			  }

			if (treatment.carbs && options.carbs) {
				var ic = Nightscout.currentProfile.ic(treatment.created_at);
				context.append('rect')
				  .attr('y',yCarbsScale(treatment.carbs))
				  .attr('height', chartHeight-yCarbsScale(treatment.carbs))
				  .attr('width', 5)
				  .attr('stroke', 'red')
				  .attr('opacity', '0.5')
				  .attr('fill', 'red')
				  .attr('transform', 'translate(' + (xScale2(treatment.created_at.getTime()) + padding.left) + ',' + +padding.top + ')');
				context.append('text')
				  .style('font-size', '12px')
				  .style('font-weight', 'bold')
			  //    .attr('text-anchor', 'left')
				  .attr('fill', 'red')
//				  .attr('opacity', '0.7')
				  .attr('y', yCarbsScale(treatment.carbs)-10)
				  .attr('transform', 'translate(' + (xScale2(treatment.created_at.getTime()) + padding.left) + ',' + +padding.top + ')')
				  .text(treatment.carbs+' g ('+(treatment.carbs/ic).toFixed(2)+'U)');
			}
			
			if (treatment.insulin && options.insulin) {
				context.append('rect')
				  .attr('y',yInsulinScale(treatment.insulin))
				  .attr('height', chartHeight-yInsulinScale(treatment.insulin))
				  .attr('width', 5)
				  .attr('stroke', 'blue')
				  .attr('opacity', '0.5')
				  .attr('fill', 'blue')
				  .attr('transform', 'translate(' + (xScale2(treatment.created_at.getTime()) + padding.left - 2) + ',' + +padding.top + ')');
				context.append('text')
				  .style('font-size', '12px')
				  .style('font-weight', 'bold')
			   //   .attr('text-anchor', 'left')
				  .attr('fill', 'blue')
//				  .attr('opacity', '0.7')
				  .attr('y', yInsulinScale(treatment.insulin)-10)
				  .attr('transform', 'translate(' + (xScale2(treatment.created_at.getTime()) + padding.left - 2) + ',' + +padding.top + ')')
				  .text(treatment.insulin+'U');
			}
		});
}

    function sgvToColor(sgv,options) {
        var color = 'darkgreen';

		if (sgv > options.targetHigh) {
			color = 'red';
		} else if (sgv < options.targetLow) {
			color = 'red';
		}

        return color;
    }

	 $('#info').html('<b>'+translate('Loading status')+' ...</b>');
     $.ajax('/api/v1/status.json', {
        success: function (xhr) {
            app = { name: xhr.name
                , version: xhr.version
                , head: xhr.head
                , apiEnabled: xhr.apiEnabled
                , enabledOptions: xhr.enabledOptions || ''
                , thresholds: xhr.thresholds
                , alarm_types: xhr.alarm_types
                , units: xhr.units
                , careportalEnabled: xhr.careportalEnabled
                , defaults: xhr.defaults
            };
        }
    }).done(function() {
		$('#info').html('<b>'+translate('Loading profile')+' ...</b>');
		$.ajax('/api/v1/profile/current', {
			success: function (record) {
				Nightscout.currentProfile.update(record);
			}
		}).done(function() {
			$('#info').html('<b>'+translate('Loading food database')+' ...</b>');
			$.ajax('/api/v1/food/regular.json', {
				success: function (records) {
					records.forEach(function (r) {
						foodlist.push(r);
						if (r.category && !categories[r.category]) categories[r.category] = {};
						if (r.category && r.subcategory) categories[r.category][r.subcategory] = true;
					});
					fillForm();
				}
			}).done(function() {
				browserSettings = getBrowserSettings(browserStorage);

				$('#info').html('');
				$('.presetdates').click(function(e) { var days = $(this).attr('days');  setDataRange(e,days); });

				$('#rp_show').click(show);
				$('#rp_food').change(function (event) { 
					event.preventDefault(); 
					$('#rp_enablefood').prop('checked',true);
				});
				$('#rp_notes').change(function (event) { 
					event.preventDefault(); 
					$('#rp_enablenotes').prop('checked',true);
				});
				
				$('#rp_targetlow').val(targetBGdefault[browserSettings.units].low);
				$('#rp_targethigh').val(targetBGdefault[browserSettings.units].high);
				
				$('.menutab').click(switchtab);

				setDataRange(null,7);
				
				});
		});
    });

	function show(event) {
		var options = {
			width: 1000,
			height: 300,
			targetLow: 3.5,
			targetHigh: 10,
			raw: true,
			notes: true,
			food: true,
			insulin: true,
			carbs: true,
			iob : true,
			cob : true
		};
		
		options.targetLow = parseFloat($('#rp_targetlow').val().replace(',','.'));
		options.targetHigh = parseFloat($('#rp_targethigh').val().replace(',','.'));
		options.raw = $('#rp_optionsraw').is(':checked');
		options.iob = $('#rp_optionsiob').is(':checked');
		options.cob = $('#rp_optionscob').is(':checked');
		options.notes = $('#rp_optionsnotes').is(':checked');
		options.food = $('#rp_optionsfood').is(':checked');
		options.insulin = $('#rp_optionsinsulin').is(':checked');
		options.carbs = $('#rp_optionscarbs').is(':checked');
		options.width = parseInt($('#rp_size :selected').attr('x'));
		options.height = parseInt($('#rp_size :selected').attr('y'));
		
		
		var matchesneeded = 0;

		// date range
		function datefilter() {
			if ($('#rp_enabledate').is(':checked')) {
				matchesneeded++;
				var from = new Date($('#rp_from').val());
				var to = new Date($('#rp_to').val());
				
				while (from <= to) {
					if (daystoshow[from.toDateInputValue()]) daystoshow[from.toDateInputValue()]++;
					else daystoshow[from.toDateInputValue()] = 1;
					from.addDays(1);
				}
			}
			console.log('Dayfilter: ',daystoshow);
			foodfilter();
		}

		//food filter
		function foodfilter() {
			if ($('#rp_enablefood').is(':checked')) {
				matchesneeded++;
				var _id = $('#rp_food').val();
				if (_id) {
					var treatmentData;
					var tquery = '?find[boluscalc.foods._id]='+_id;
					$.ajax('/api/v1/treatments.json'+tquery, {
						success: function (xhr) {
							treatmentData = xhr.map(function (treatment) {
								var timestamp = new Date(treatment.created_at);
								return timestamp.toDateInputValue();
							});
							// unique it
							treatmentData = $.grep(treatmentData, function(v, k){
								return $.inArray(v ,treatmentData) === k;
							});
							treatmentData.sort(function(a, b) { return a > b; });
						}
					}).done(function () {
					console.log('Foodfilter: ',treatmentData);
					for (var d=0; d<treatmentData.length; d++) {
						if (daystoshow[treatmentData[d]]) daystoshow[treatmentData[d]]++;
						else daystoshow[treatmentData[d]] = 1;
					}
					notesfilter();
					});
				}
			} else {
				notesfilter();
			}
		}
		
		//notes filter
		function notesfilter() {
			if ($('#rp_enablenotes').is(':checked')) {
				matchesneeded++;
				var notes = $('#rp_notes').val();
				if (notes) {
					var treatmentData;
					var tquery = '?find[notes]=/'+notes+'/i';
					$.ajax('/api/v1/treatments.json'+tquery, {
						success: function (xhr) {
							treatmentData = xhr.map(function (treatment) {
								var timestamp = new Date(treatment.created_at);
								return timestamp.toDateInputValue();
							});
							// unique it
							treatmentData = $.grep(treatmentData, function(v, k){
								return $.inArray(v ,treatmentData) === k;
							});
							treatmentData.sort(function(a, b) { return a > b; });
						}
					}).done(function () {
						console.log('Notesfilter: ',treatmentData);
						for (var d=0; d<treatmentData.length; d++) {
							if (daystoshow[treatmentData[d]]) daystoshow[treatmentData[d]]++;
							else daystoshow[treatmentData[d]] = 1;
						}
						eventtypefilter();
					});
				}
			} else {
				eventtypefilter();
			}
		}
		
		//event type filter
		function eventtypefilter() {
			if ($('#rp_enableeventtype').is(':checked')) {
				matchesneeded++;
				var eventtype = $('#rp_eventtype').val();
				if (eventtype) {
					var treatmentData;
					var tquery = '?find[eventType]=/'+eventtype+'/i';
					$.ajax('/api/v1/treatments.json'+tquery, {
						success: function (xhr) {
							treatmentData = xhr.map(function (treatment) {
								var timestamp = new Date(treatment.created_at);
								return timestamp.toDateInputValue();
							});
							// unique it
							treatmentData = $.grep(treatmentData, function(v, k){
								return $.inArray(v ,treatmentData) === k;
							});
							treatmentData.sort(function(a, b) { return a > b; });
						}
					}).done(function () {
						console.log('Eventtypefilter: ',treatmentData);
						for (var d=0; d<treatmentData.length; d++) {
							if (daystoshow[treatmentData[d]]) daystoshow[treatmentData[d]]++;
							else daystoshow[treatmentData[d]] = 1;
						}
						daysfilter();
					});
				}
			} else {
				daysfilter();
			}
		}
		
		function daysfilter() {
			matchesneeded++;
			for (var d in daystoshow) {
				var day = new Date(d).getDay();
				if (day==0 && $('#rp_su').is(':checked')) daystoshow[d]++;
				if (day==1 && $('#rp_mo').is(':checked')) daystoshow[d]++;
				if (day==2 && $('#rp_tu').is(':checked')) daystoshow[d]++;
				if (day==3 && $('#rp_we').is(':checked')) daystoshow[d]++;
				if (day==4 && $('#rp_th').is(':checked')) daystoshow[d]++;
				if (day==5 && $('#rp_fr').is(':checked')) daystoshow[d]++;
				if (day==6 && $('#rp_sa').is(':checked')) daystoshow[d]++;
			}
			display();
		}
		
		function display() {
			console.log('Total: ',daystoshow,'Needed: ',matchesneeded);
			var displayeddays = 0;
			$('#info').html('<b>'+translate('Loading')+' ...</b>');
			$('#charts').html('');
			for (var d in daystoshow) {
				if (daystoshow[d]==matchesneeded) {
					if (displayeddays < maxdays) {
						$('#charts').append($('<div id="chart-'+d+'"></div>'));
						loadData(d,options);
						displayeddays++;
					} else {
						$('#charts').append($('<div>'+d+' '+translate('not displayed')+'.</div>'));
					}
				} else {
					delete daystoshow[d];
				}
			}
			if (displayeddays==0) {
				$('#charts').html('<b>'+translate('Result is empty')+'</b>');
				$('#info').empty();
			}
		}
		
		$('#rp_show').css('display','none');
		daystoshow = {};
		datefilter();
		if (event) event.preventDefault();
	}
	
	function showotherreports(options) {
		// wait for all loads
		for (var d in daystoshow) {
			if (!datastorage[d]) return; // all data not loaded yet
		}

		['dailystats','percentile','glucosedistribution','hourlystats','success','treatments'].forEach(function (chart) {
			// jquery plot doesn't draw to hidden div
			$('#'+chart+'-placeholder').css('display','');
			eval('report_'+chart+'(datastorage,daystoshow,options);');
			if (!$('#'+chart).hasClass('selected'))
				$('#'+chart+'-placeholder').css('display','none');
		});
		
		$('#info').html('');
		$('#rp_show').css('display','');
	}

	// Treatments report
	
	function report_treatments(datastorage,daystoshow,options) {
		var icon_remove = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACrElEQVQ4T42Ty2sTQRzHv5tmk2yyjRNtpfZhL8V6s2KoUNC2XqwgaCsVQcGiFqpHi0c9iRdR/ANE9KR40FIQX4cueKoPaKFoLdSYNtE0abKT1+5s9iW7aUMiHtzTzO7v85md+c6PA4DrHbsPCKIgOWO1pA7dT6YXnXH949SE/F63pqwZtRrO+SCKgjQ5NUV+azpmHj2krMwaJC4c8Erj+/eRyloMMwWFKgbn1nC3ervlK1evkXBLGBZT8SOewotnTylTNLdgeg/pDgZDC2cPHSR8bB22DVC9hFe0SG/H0xFXcHlykjRHRDBWgJcZSCY38Xx2lhqMnRYE34Px/sN9vlQWeoHBAx2yXsRruVAVuFsIBaSJ8+eJGPaBqQV4NROJjTzez89jLBoFn6FgybQL54wS3uTyVDFQ3cL2IYpBv3RhdJSIIQ80tQyv7gEqJvS8AmUlBs7UXPhtjtZgh3UFNYngk86NHCfNAg9dMwHVBPu+CpsVkTXKeJeVG+AGgTOZ3tt6MSKKjy+NjEBjFrR4ElZmA4pdxstMFsyyJu6tZZ7Ux9vwB6EAL50ZGiRECEPPUOixVTRxHlicgSVWxEdZpuZWfNuS2hk48NjwMIkIYZglBnV5Cbqtws/5IaAJmsfCglrEl2y2QeKmEBJ80tixKmxrFpSVr0gV0viQoxho2YUuPohmeFD22PiklLC4ma5JuBvdrfLJI0dJd0s7bM0ES8aR/BXDXGaTskqlL+D3Lwy0tZEePoAd4EA5YF4tYymdonfjmQh3s6dTPjU4SHYGwjAKecSXFyGlM1TdytntE56T+ts7SC/vhw3gm6njc2Kd3vm5Ub1IwQAvnYhGiZpYw1wiWYPrIw7wnBTt7CLOOwdmut14kQQvqt24tfK/utGR6LaF+iRqMf4N/O/8D28HiiCRYqzAAAAAAElFTkSuQmCC";

		var table = '<table>';
		table += '<tr style="background:gray"><th></th><th style="width:80px" align="left">'+translate('Time')+'</th><th style="width:150px" align="left">'+translate('Event Type')+'</th><th style="width:150px" align="left">'+translate('Blood Glucose')+'</th><th style="width:50px" align="left">'+translate('Insulin')+'</th><th style="width:50px" align="left">'+translate('Carbs')+'</th><th style="width:150px" align="left">'+translate('Entered By')+'</th><th style="width:300px" align="left">'+translate('Notes')+'</th></tr>';
		
		Object.keys(daystoshow).forEach(function (day) {
			table += '<tr><td></td><td colspan="7"><b>'+localeDate(day)+'</b></td></tr>';
			var treatments = datastorage[day].treatments;
			for (var t=0; t<treatments.length; t++) {
				var tr = treatments[t];
				table += '<tr class="border_bottom">';
				table += '<td><img style="cursor:pointer" title="'+translate('Delete record')+'" src="'+icon_remove+'" href="#" class="deleteTreatment" data=\''+JSON.stringify(tr)+'\' day="'+day+'"></td>';
				table += '<td>'+(new Date(tr.created_at).toLocaleTimeString().replace(/([\d]+:[\d]{2})(:[\d]{2})(.*)/, "$1$3"))+'</td>';
				table += '<td>'+(tr.eventType ? tr.eventType : '')+'</td>';
				table += '<td align="center">'+(tr.glucose ? tr.glucose + ' ('+tr.glucoseType+')' : '')+'</td>';
				table += '<td align="center">'+(tr.insulin ? tr.insulin : '')+'</td>';
				table += '<td align="center">'+(tr.carbs ? tr.carbs : '')+'</td>';
				table += '<td>'+(tr.enteredBy ? tr.enteredBy : '')+'</td>';
				table += '<td>'+(tr.notes ? tr.notes : '')+'</td>';
				
				table += '</tr>';
			}
		});
		$('#treatments-report').html(table);
		$('.deleteTreatment').click(deleteTreatment);
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
				('\nEvent Time: ' + new Date(data.created_at).toLocaleString())
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
		var apisecrethash = localStorage.getItem('apisecrethash');

		if (!apisecrethash) {
			alert(translate('You API secret hash not stored yet'));
			return false;
		}
		
	
		var dataJson = JSON.stringify(_id, null, ' ');

		var xhr = new XMLHttpRequest();
		xhr.open('DELETE', '/api/v1/treatments/'+_id, true);
		xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
		xhr.setRequestHeader('api-secret', apisecrethash);
		xhr.send(null);
		return true;
	}

	function setDataRange(event,days) {
		var now = new Date();
		var from = new Date().addDays(-days+1);
		$('#rp_from').val(from.toDateInputValue());
		$('#rp_to').val(now.toDateInputValue());
		
		if (event) event.preventDefault();
	}
	
	function switchtab(event) {
		var id = $(this).attr('id');
		
		$('.menutab').removeClass('selected');
		$('#'+id).addClass('selected');
		
		$('.tabplaceholder').css('display','none');
		$('#'+id+'-placeholder').css('display','');
	
	}
	
	function localeDate(day) {
		var ret = 
			[translate("Sunday"),translate("Monday"),translate("Tuesday"),translate("Wednesday"),translate("Thursday"),translate("Friday"),translate("Saturday")][new Date(day).getDay()];
		ret += ' ';
		ret += new Date(day).toLocaleDateString();
		return ret;
	}
	
	function loadData(day,options) {
		// check for loaded data
		if (datastorage[day] && day != new Date().toDateInputValue()) {
			drawChart(day,datastorage[day],options);
			showotherreports(options);
			return;
		}
		// patientData = [actual, predicted, mbg, treatment, cal, devicestatusData];
		var data = {};
		var cgmData = []
		  , mbgData = []
		  , treatmentData = []
		  , calData = []
		  ;
		var dt = new Date(day);
		var from = dt.getTime() + dt.getTimezoneOffset() * 60 * 1000;
		var to = from + 1000 * 60 * 60 * 24;
		var query = '?find[date][$gte]='+from+'&find[date][$lt]='+to+'&count=10000';
		
		$('#'+containerprefix+day).html('<b>'+translate('Loading CGM data of')+' '+day+' ...</b>');
		$.ajax('/api/v1/entries.json'+query, {
			success: function (xhr) {
				xhr.forEach(function (element) {
					if (element) {
						if (element.mbg) {
							mbgData.push({
								y: element.mbg
								, x: element.date
								, d: element.dateString
								, device: element.device
							});
						} else if (element.sgv) {
							cgmData.push({
								y: element.sgv
								, x: element.date
								, d: element.dateString
								, device: element.device
								, filtered: element.filtered
								, unfiltered: element.unfiltered
								, noise: element.noise
								, rssi: element.rssi
								, sgv: element.sgv
							});
						} else if (element.type == 'cal') {
							calData.push({
								x: element.date
								, d: element.dateString
								, scale: element.scale
								, intercept: element.intercept
								, slope: element.slope
							});
						}
					}
				});
			   // sometimes cgm contains duplicates.  uniq it.
				data.sgv = cgmData.slice();
				data.sgv.sort(function(a, b) { return a.x - b.x; });
				var lastDate = 0;
				data.sgv = data.sgv.filter(function(d) {
					var ok = (lastDate + ONE_MIN_IN_MS) < d.x;
					lastDate = d.x;
					return ok;
				});
				data.mbg = mbgData.slice();
				data.mbg.sort(function(a, b) { return a.x - b.x; });
				data.cal = calData.slice();
				data.cal.sort(function(a, b) { return a.x - b.x; });
			}
		}).done(function () {
			$('#'+containerprefix+day).html('<b>'+translate('Loading treatments data of')+' '+day+' ...</b>');
			var tquery = '?find[created_at][$gte]='+new Date(from).toISOString()+'&find[created_at][$lt]='+new Date(to).toISOString();
			$.ajax('/api/v1/treatments.json'+tquery, {
				success: function (xhr) {
					treatmentData = xhr.map(function (treatment) {
						var timestamp = new Date(treatment.timestamp || treatment.created_at);
						treatment.x = timestamp.getTime();
						return treatment;
					});
					data.treatments = treatmentData.slice();
					data.treatments.sort(function(a, b) { return a.x - b.x; });
				}
			}).done(function () {
				$('#'+containerprefix+day).html('<b>'+translate('Processing data of')+' '+day+' ...</b>');
				processData(data,day,options);
			});
				
		});
	}

	function processData(data,day,options) {
		// treatments
		data.treatments.forEach(function (d) {
			d.created_at = new Date(d.created_at);
			if (parseFloat(d.insulin) > maxInsulinValue) maxInsulinValue = parseFloat(d.insulin);
			if (parseFloat(d.carbs) > maxCarbsValue) maxCarbsValue = parseFloat(d.carbs);
		});

		var cal = data.cal[data.cal.length-1];
		var temp1 = [ ];
		if (cal) {
			temp1 = data.sgv.map(function (entry) {
				var noise = entry.noise || 0;
				var rawBg = rawIsigToRawBg(entry, cal);
				return { date: new Date(entry.x - 2 * 1000), y: rawBg, sgv: scaleBg(rawBg), color: 'gray', type: 'rawbg'}
			}).filter(function(entry) { return entry.y > 0});
		}
		var temp2 = data.sgv.map(function (obj) {
			return { date: new Date(obj.x), y: obj.y, sgv: scaleBg(obj.y), color: sgvToColor(scaleBg(obj.y),options), type: 'sgv', noise: obj.noise, filtered: obj.filtered, unfiltered: obj.unfiltered}
		});
		data.sgv = [].concat(temp1, temp2);

		//Add MBG's also, pretend they are SGV's
		data.sgv = data.sgv.concat(data.mbg.map(function (obj) { return { date: new Date(obj.x), y: obj.y, sgv: scaleBg(obj.y), color: 'red', type: 'mbg', device: obj.device } }));

		// make sure data data range will be exactly 24h
		var from = new Date(new Date(day).getTime() + (new Date().getTimezoneOffset()*60*1000));
		var to = new Date(from.getTime() + 1000 * 60 * 60 * 24);
		data.sgv.push({ date: from, y: 40, sgv: 40, color: 'transparent', type: 'rawbg'});
		data.sgv.push({ date: to, y: 40, sgv: 40, color: 'transparent', type: 'rawbg'});

		// clear error data. we don't need it to display them
		data.sgv = data.sgv.filter(function (d) {
			if (d.y < 39) return false;
			return true;
		});
		
		delete data.cal;
		delete data.mbg;
		
		// for other reports
		data.statsrecords = data.sgv.filter(function(r) {
			if (r.type) return r.type == 'sgv';
			else return true;
		}).map(function (r) { 
			var ret = {};
			ret.sgv = parseFloat(r.sgv); 
			ret.bgValue = parseInt(r.y);
			ret.displayTime = r.date;
			return ret;
		});

	  
        datastorage[day] = data;
	    drawChart(day,data,options);
		showotherreports(options);
	}

	// Filtering food code
	// -------------------
	var categories = [];
	var foodlist = [];
	var filter = {
		  category: ''
		, subcategory: ''
		, name: ''
	};

	function fillForm(event) {
		$('#rp_category').empty().append(new Option(translate('(none)'),''));
		for (var s in categories) {
			$('#rp_category').append(new Option(s,s));
		}
		filter.category = '';
		fillSubcategories();
		
		$('#rp_category').change(fillSubcategories);
		$('#rp_subcategory').change(doFilter);
		$('#rp_name').on('input',doFilter);
	
		if (event) event.preventDefault();
		return false;
	}

	function fillSubcategories(event) {
		if (event) {
			event.preventDefault();
		}
		filter.category = $('#rp_category').val();
		filter.subcategory = '';
		$('#rp_subcategory').empty().append(new Option(translate('(none)'),''));
		if (filter.category != '') {
			for (var s in categories[filter.category]) {
				$('#rp_subcategory').append(new Option(s,s));
			}
		}
		doFilter();
	}

	function doFilter(event) {
		if (event) {
			filter.category = $('#rp_category').val();
			filter.subcategory = $('#rp_subcategory').val();
			filter.name = $('#rp_name').val();
		}
		$('#rp_food').empty();
		for (var i=0; i<foodlist.length; i++) {
			if (filter.category != '' && foodlist[i].category != filter.category) continue;
			if (filter.subcategory != '' && foodlist[i].subcategory != filter.subcategory) continue;
			if (filter.name!= '' && foodlist[i].name.toLowerCase().indexOf(filter.name.toLowerCase())<0) continue;
			var o = '';
			o += foodlist[i].name + ' | ';
			o += translate('Portion')+': ' + foodlist[i].portion + ' ';
			o += foodlist[i].unit + ' | ';
			o += translate('Carbs')+': ' + foodlist[i].carbs+' g';
			$('#rp_food').append(new Option(o,foodlist[i]._id));
		}
		
		if (event) event.preventDefault();
	}
	
