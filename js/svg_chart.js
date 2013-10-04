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

    chart.forceY([40,250]);
    var now = Date.now();

    chart.xAxis
        .tickValues([now])
        .axisLabel('Time(min)')
        .tickFormat(function (d) {
            return d3.time.format("%H:%M")(new Date(d))
        });

    chart.yAxis
        .tickValues([80, 180])
        .axisLabel('mg/dL');

    nv.utils.windowResize(chart.update);

    return chart;
});

function redraw() {

    var newTime = data[0].values[data[0].values.length - 1].x;

    d3.select('#chart svg')
        .datum(data)
        .transition().duration(500)
        .call(chart);

    chart.xAxis
        .tickValues([newTime.getTime() + 1000*60*5]);  //for some reason the tickValues reports 5 mins less than inputted

    chart.tooltipContent(function(key, x, y) {return y + " mg/dL (" + key + ")";});

    document.getElementById("currentBG").innerText = data[0].values[data[0].values.length - 1].y + " mg/dL";
    document.getElementById("currentTime").innerText = newTime.toLocaleTimeString()
}

function getMockSGVData() {
    var arr = [];
    var initial = Math.floor(Math.random() * 50 + 100);
    var theDate = new Date(new Date().getTime() - 1000*60*60*3);
    for (var x = 0; x < 60*3/5 + 1; x++) {
        arr.push({x: new Date(theDate.getTime()), y: initial + Math.floor(Math.random()*10) - 5});
        theDate.setTime(theDate.getTime() + 1000 * 60 * 5);
    }
    return arr;
}

function getMockPredictedData() {
    var arr = [];
    var initial = data[0].values[data[0].values.length - 1].y;
    var theDate = new Date(new Date().getTime() + 1000 * 60 * 5);
    for (var x = 0; x < 60/5; x++) {
        arr.push({x: new Date(theDate.getTime()), y: initial + Math.floor(Math.random()*10) - 5});
        theDate.setTime(theDate.getTime() + 1000 * 60 * 5);
    }
    return arr;
}

//If io server exists, connect, else use mock data
if(typeof(io) !== "undefined") {
    data[0].values = getMockSGVData();
    data[1].values = getMockPredictedData();
    var socket = io.connect();
    socket.on('connect', function () {
        redraw();
    });
    socket.on('sgv', function (d) {
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
