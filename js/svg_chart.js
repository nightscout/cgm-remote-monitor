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

nv.addGraph(function () {
    chart = nv.models.scatterChart();

    var now = Date.now();

    chart.xAxis
        .orient("bottom")
        .tickValues([now])
        .axisLabel('Time(min)')
        .tickFormat(function (d) {
            return d3.time.format("%H:%M")(new Date(d))
        });

    chart.yAxis
        //.orient("right")
        .tickValues([80, 180]);
        //.axisLabel('mg/dL');

    chart.forceY([40,300]);

    //var y = d3.scale.log()
    //chart.yScale(y)

    d3.select('#chart').on("click", function () {
        socket.emit('update', 6);
    });

    nv.utils.windowResize(chart.update);

    return chart;
});

function redraw() {

    var newTime = new Date();

    d3.select('#chart svg')
        .datum(data)
        .transition().duration(500)
        .call(chart);

    chart.xAxis
        .tickValues([newTime.getTime()]);

    chart.tooltipContent(function(key, x, y) {return y + " mg/dL (" + key + ")";});

    $('#currentBG').text(data[0].values[data[0].values.length - 1].y + " mg/dL");
    $('#currentTime').text(d3.time.format("%H:%M")(newTime));
}

//If io server exists, connect, else use mock data
if(typeof(io) !== "undefined") {
    var socket = io.connect();
    socket.on('connect', function () {
        socket.emit('test', "C --> S: Client Connected.");
        console.log("Client connected.");
    });
    socket.on('sgv', function (d) {
        if(d.length > 1) {
            data[0].values = d[0].map(function(obj) { return {x: new Date(obj.x), y: obj.y} });
            data[1].values = d[1].map(function(obj) { return {x: new Date(obj.x), y: obj.y} });
            redraw();
            console.log("SGV data received.");
            socket.emit('test', "C --> S: Client received data as: " + d);
        }
    });

} else {
    data[0].values = getMockSGVData();
    data[1].values = getMockPredictedData();
    setInterval(function () {
        var sgv = data[0].values;
        var nextSVG = new Date(sgv[sgv.length - 1].x);
        var nextValue = sgv[sgv.length - 1].y;
        nextSVG.setTime(nextSVG.getTime() + 1000*60*5);
        sgv.shift();
        sgv.push({x:nextSVG, y: nextValue + Math.floor(Math.random()*10 - 5)});
        var predicted = data[1].values;
        var nextP = new Date(predicted[predicted.length - 1].x);
        nextP.setTime(nextP.getTime() + 1000*60*5);
        predicted.shift();
        predicted.push({x:nextP, y: nextValue + Math.floor(Math.random()*10 - 5)});
        redraw();
    }, 2000);
}
