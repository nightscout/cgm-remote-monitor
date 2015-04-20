//TODO: clean up
var app = {}, browserSettings = {}, browserStorage = $.localStorage;

    'use strict';

	var containerprefix = 'chart-';
	
	var chw = 1000, chh = 300;
	
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
			["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][new Date(day).getDay()]+
			' '+
			new Date(day).toLocaleDateString()+
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
        var chartWidth = chw - padding.left - padding.right;
        var chartHeight = chh - padding.top - padding.bottom;
 
 		//set the width and height of the SVG element
		charts.attr('width', chw)
			.attr('height', chh)
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
						.attr('y2', padding.top + treatment.carbs ? yCarbsScale(treatment.carbs) :  yInsulinScale(treatment.insulin))
						.style('stroke-dasharray', ('1, 7'))
						.attr('stroke', 'grey');
				  }
			  }

			if (treatment.carbs && options.carbs) {
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
				  .text(treatment.carbs+' g');
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

	 $('#info').html('<b>Loading status ...</b>');
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
		$('#info').html('<b>Loading food database ...</b>');
//		$.ajax('/api/v1/food/regular.json', {
		$.ajax('/api/v1/status.json', {
			success: function (records) {
//				records.forEach(function (r) {
//					foodlist.push(r);
//					if (r.category && !categories[r.category]) categories[r.category] = {};
//					if (r.category && r.subcategory) categories[r.category][r.subcategory] = true;
//				});
			}
		}).done(function() {
			$('.appName').text(app.name);
			$('.version').text(app.version);
			$('.head').text(app.head);
			if (app.apiEnabled) {
				$('.serverSettings').show();
			}
			$('#treatmentDrawerToggle').toggle(app.careportalEnabled);
			browserSettings = getBrowserSettings(browserStorage);
			var options = {
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
			$('#info').html('');
			loadData('2015-04-13',drawChart,options);
			loadData('2015-04-14',drawChart,options);
			loadData('2015-04-15',drawChart,options);
			loadData('2015-04-16',drawChart,options);
			loadData('2015-04-17',drawChart,options);
			loadData('2015-04-18',drawChart,options);
			loadData('2015-04-20',drawChart,options);
			});
    });

	var datastorage = {};
	
	function loadData(day,callback,options) {
		// check for loaded data
		if (datastorage[day]) {
			callback(day,data,options);
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
		
		$('#'+containerprefix+day).html('<b>Loading CGM data of '+day+' ...</b>');
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
			$('#'+containerprefix+day).html('<b>Loading treatments data of '+day+' ...</b>');
/*
?find[dateString][$gte]=2015-02-00&find[dateString][$lte]=2015-03-00&count=10000 to get month 02
so find[foo]=bar becomes {foo: 'bar'} while find[foo][]=bar becomes { foo: [ 'bar']}
so everything attached to find params gets passed as literal obj decoded via query string as object to mongo search

    return api().find({created_at: {$gte: new Date(from).toISOString(), $lt: new Date(to).toISOString()} }).sort({"created_at": 1}).toArray(fn);

*/			
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
				$('#'+containerprefix+day).html('<b>Precessing data of '+day+' ...</b>');
				processData(data,day,callback,options);
			});
				
		});
	}

	function processData(data,day,callback,options) {
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
		data.sgv.push({ date: from, y: 40, sgv: 40, color: 'transparent', type: 'sgv'});
		data.sgv.push({ date: to, y: 40, sgv: 40, color: 'transparent', type: 'sgv'});

		// clear error data. we don't need it to display them
		data.sgv = data.sgv.filter(function (d) {
			if (d.y < 39) return false;
			return true;
		});
		
		delete data.cal;
		delete data.mbg;
	  
        datastorage[day] = data;
	    callback(day,data,options);
	}
