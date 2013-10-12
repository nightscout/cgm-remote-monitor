var data = [
    {
        "key": "SGV",
        "values": [],
        "color": "#808080"
    },
    {
        "key": "Predicted",
        "values": [],
        "color": "#0000FF"
    }
];

var chart;
var rangeIndex = 1;
var hours = [3, 6, 12, 24];

nv.addGraph(function () {
    chart = nv.models.scatterChart();

    var now = Date.now();

    chart.showLegend(false);

    chart.xAxis
        .tickValues([now])
        .axisLabel('Time(min)')
        .tickFormat(function (d) {
            return d3.time.format("%H:%M")(new Date(d))
        });

    chart.yAxis
        .tickValues([80, 180])
        .axisLabel('mg/dL');

    chart.forceY([40,300]);

    d3.select('#chart').on("click", function () {
        socket.emit('update', hours[rangeIndex]);
        rangeIndex = rangeIndex + 1 > 3 ? 0 : rangeIndex + 1;
    });

    nv.utils.windowResize(chart.update);

    chart.tooltipContent(function(key, x, y) {return y + " mg/dL (" + key + ")" + "\n@" + x;});
    chart.tooltipXContent(null);
    chart.tooltipYContent(null);

    return chart;
});

function refresh() {

    var newTime = new Date();

    chart.forceX(newTime - hours[rangeIndex - 1]*3600*1000);

    d3.select('#chart svg')
        .datum(data)
        .transition().duration(500)
        .call(chart);

    chart.xAxis
        .tickValues([newTime.getTime()]);

    $('#currentTime').text(d3.time.format("%H:%M")(newTime));
    if(data[0].values.length) { $('#currentBG').text(data[0].values[data[0].values.length - 1].y + " mg/dL"); }
}

var socket = io.connect();

socket.on('connect', function () {
    console.log("Client connected.");
    refresh()
});

socket.on('sgv', function (d) {
    if(d.length > 1) {
        data[0].values = d[0].map(function(obj) { return {x: new Date(obj.x), y: obj.y} });
        data[1].values = d[1].map(function(obj) { return {x: new Date(obj.x), y: obj.y} });
        refresh();
    }
});