function report_calibrations(datastorage,daystoshow,options) {
	var treatments = [];
	Object.keys(daystoshow).forEach(function (day) {
		treatments = treatments.concat(datastorage[day].treatments.filter(function (t) {
			if (t.eventType == "Sensor Start") return true;
			if (t.eventType == "Sensor Change") return true;
			return false;
		}));
	});

	var cals = [];
	Object.keys(daystoshow).forEach(function (day) {
		cals = cals.concat(datastorage[day].cal);
	});

	var sgvs = [];
	Object.keys(daystoshow).forEach(function (day) {
		sgvs = sgvs.concat(datastorage[day].sgv);
	});
		
	var mbgs = [];
	Object.keys(daystoshow).forEach(function (day) {
		mbgs = mbgs.concat(datastorage[day].mbg);
	});
	mbgs.forEach(function (mbg) { calibrations_calcmbg(mbg); });	
	

	var events = treatments.concat(cals).concat(mbgs).sort(function(a, b) { return a.x - b.x; });
	
	var colors = ['Aqua','Blue','Brown','Chartreuse','Coral','CornflowerBlue','DarkCyan','DarkMagenta','DarkOrange','Fuchsia','Green','Yellow'];
	var colorindex = 0;
	var html = '<table>';
	var lastmbg = null;
	for (var i=0; i<events.length; i++) {
		e = events[i];
		var currentcolor = 'White';
		if (typeof e.device !== 'undefined') colorindex = (colorindex+1)%colors.length;
		if (!e.eventType) currentcolor = colors[colorindex];
		html += '<tr>';
		html += '<td>' + localeDateTime(new Date(e.x)) + '</td><td style="background-color:'+currentcolor+'">';
		e.bgcolor = colors[colorindex];
		if (e.eventType)
			html += '<b style="text-decoration: underline;padding-left:0em">'+translate(e.eventType)+'</b>:<br>';
		else if (typeof e.device !== 'undefined') {
			html += '<input type="checkbox" index="'+i+'" class="calibrations-checkbox" id="calibrations-'+i+'"> ';
			html += '<b style="padding-left:2em">MBG</b>: ' + e.y + ' Raw: '+e.raw+'<br>';
			lastmbg = e;
			e.cals = [];
			e.checked = false;
		} else if (typeof e.scale !== 'undefined') {
			html += '<b style="padding-left:4em">CAL</b>: ' + ' Scale: ' + e.scale.toFixed(2) + ' Intercept: ' + e.intercept.toFixed(0) + ' Slope: ' + e.slope.toFixed(2) + '<br>';
			if (lastmbg) lastmbg.cals.push(e);
		} else html += JSON.stringify(e);
		html += '</td></tr>';
	};
	
	html += '</table>';

	$('#calibrations-list').html(html);
	
	// select last 3 mbgs
	var maxcals = 3;
	for (var i=events.length-1; i>0; i--) {
		if (typeof events[i].device !== 'undefined') {
			events[i].checked = true;
			$('#calibrations-'+i).prop('checked',true);
			if (--maxcals<1) break;
		}
	}
	calibrations_drawelements();

	$('.calibrations-checkbox').change(calibrations_checkboxevent);

	function calibrations_checkboxevent(event) {
		var index = $(this).attr('index');
		events[index].checked = $(this).is(':checked');
		calibrations_drawelements();
		event.preventDefault();
	}

	function calibrations_drawelements() {
		calibrations_drawChart();
		for (var i=0; i<events.length; i++) {
			e = events[i];
			if (e.checked) {
				calibrations_drawmbg(e,e.bgcolor);
				e.cals.forEach(function (cal) {
					calibrations_drawcal(cal,cal.bgcolor);
				});
			}
			
		}
	}
	
	var calibration_context,xScale2,yScale2 ;
	
	function calibrations_drawChart() {
		var padding = { top: 15, right: 15, bottom: 30, left: 70 };
		var maxBG = 500;

/*
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
*/
		$('#calibrations-chart').empty();
        var charts = d3.select('#calibrations-chart').append('svg');

		charts.append("rect")
			.attr("width", "100%")
			.attr("height", "100%")
			.attr("fill", "WhiteSmoke");
			
        calibration_context = charts.append('g');

		// define the parts of the axis that aren't dependent on width or height
        xScale2 = d3.scale.linear()
            .domain([0,maxBG]);

		yScale2 = d3.scale.linear()
				.domain([0,400000]);

		var xAxis2 = d3.svg.axis()
          .scale(xScale2)
//          .tickFormat(d3.time.format(getTimeFormat(true)))
          .ticks(10)
          .orient('bottom');

        yAxis2 = d3.svg.axis()
            .scale(yScale2)
//            .tickFormat(d3.format('d'))
//            .tickValues(tickValues)
//            .orient('right');
            .orient('left');

		// get current data range
        var dataRange = [0,maxBG];
		var width = 600;
		var height = 500;
		
        // get the entire container height and width subtracting the padding
        var chartWidth = width - padding.left - padding.right;
        var chartHeight = height - padding.top - padding.bottom;
 
 		//set the width and height of the SVG element
		charts.attr('width', width)
			.attr('height', height)
            /*.attr('transform', 'translate(' + padding.left + ',' + padding.top + ')')*/;
			
		// ranges are based on the width and height available so reset
		xScale2.range([0, chartWidth]);
		yScale2.range([chartHeight,0]);

        // create the x axis container
        calibration_context.append('g')
            .attr('class', 'x axis');

        // create the y axis container
        calibration_context.append('g')
            .attr('class', 'y axis');

		calibration_context.select('.y')
			.attr('transform', 'translate(' + (/*chartWidth + */ padding.left) + ',' + padding.top + ')')
			.style('stroke', 'black')
			.style('shape-rendering', 'crispEdges')
			.style('fill', 'none')
			.call(yAxis2);

		// if first run then just display axis with no transition
		calibration_context.select('.x')
			.attr('transform', 'translate(' + padding.left + ',' + (chartHeight + padding.top) + ')')
			.style('stroke', 'black')
			.style('shape-rendering', 'crispEdges')
			.style('fill', 'none')
			.call(xAxis2);

		[50000,100000,150000,200000,250000,300000,350000,400000].forEach(function (li) {
			calibration_context.append('line')
				.attr('class', 'high-line')
				.attr('x1', xScale2(dataRange[0])+padding.left)
				.attr('y1', yScale2(li)+padding.top)
				.attr('x2', xScale2(dataRange[1])+padding.left)
				.attr('y2', yScale2(li)+padding.top)
				.style('stroke-dasharray', ('3, 3'))
				.attr('stroke', 'grey');
		});
		[50,100,150,200,250,300,350,400,450,500].forEach(function (li) {
			calibration_context.append('line')
				.attr('class', 'high-line')
				.attr('x1', xScale2(li)+padding.left)
				.attr('y1', padding.top)
				.attr('x2', xScale2(li)+padding.left)
				.attr('y2', chartHeight+padding.top)
				.style('stroke-dasharray', ('3, 3'))
				.attr('stroke', 'grey');
		});
	}

	function calibrations_drawcal(cal,color) {
		var y1 = 50000;
		var x1 = cal.scale * (y1 - cal.intercept) / cal.slope;
		var y2 = 400000;
		var x2 = cal.scale * (y2 - cal.intercept) / cal.slope;
		calibration_context.append('line')
			//.attr('class', 'high-line')
			.attr('x1', xScale2(x1)+padding.left)
			.attr('y1', yScale2(y1)+padding.top)
			.attr('x2', xScale2(x2)+padding.left)
			.attr('y2', yScale2(y2)+padding.top)
			.style('stroke-width', 3)
			.attr('stroke', color);
	}
	
	function calibrations_calcmbg(mbg) {
		var lastsgv = calibrations_findlatest(new Date(mbg.x),sgvs);
//console.log(lastsgv);

		if (lastsgv) {
			if (mbg.x-lastsgv.x>5*60*1000) {
				console.log('Last SGV too old for MBG. Time diff: '+((mbg.x-lastsgv.x)/1000/60).toFixed(1)+' min',mbg);
			} else {
				mbg.raw = lastsgv.filtered || lastsgv.unfiltered;
			}
		} else {
			console.log('Last entry not found for MBG ',mbg);
		}
	}
	
	function calibrations_drawmbg(mbg,color) {
		if (mbg.raw) {
			calibration_context.append('circle')
				.attr('cx', xScale2(mbg.y) + padding.left)
				.attr('cy', yScale2(mbg.raw) + padding.top)
				.attr('fill', color)
				.style('opacity', 1)
				.attr('stroke-width', 1)
				.attr('stroke', 'black')
				.attr('r', 5);
		}
	}
	
	function calibrations_findlatest(date,storage) {
		var day = date.toDateInputValue();
		
		var last = null;
		var time = date.getTime();
		for (var i=0; i<storage.length; i++) {
			if (storage[i].x > time) 
				return last;
			last = storage[i];
		}
		return last;
	}

}
