(function ($) {
    var options = {
        series: { candle: null } // or number/string
    };
    var offset, x, y;

    function init(plot) {
        plot.hooks.processOptions.push(processOptions);
        function processOptions(plot,options){
            if(options.series.candle){
                //plot.hooks.processRawData.push(processRawData);
                plot.hooks.drawSeries.push(drawSeries);
            }
        }
        /*function processRawData(plot,s,data,datapoints){
            if(s.candle){
            }
        }*/
        function drawSeries(plot, ctx, serie){
            if (serie.candle) {
                offset = plot.getPlotOffset();
                offset.left = offset.left;
                var x1 = serie.xaxis.p2c(serie.data[0][0]);
                var x2 = serie.xaxis.p2c(serie.data[1][0]);
                var width = (x2 - x1) * 4 / 5;
                for (var j = 0; j < serie.data.length; j++) { getAndDrawCandle(ctx, serie, width, serie.data[j]);}
            }
        }
        function getAndDrawCandle(ctx, serie, width, data){
            var dt = data[0];
            var open = data[1];
            var close = data[2];
            var low = data[3];
            var high = data[4];
            drawCandle(ctx, serie, width, dt, open, low, close, high);
        }
        function drawCandle(ctx, serie, width, dt, open, low, close, high){
            var height;
            if (open < close){ //Rising 
                y = offset.top + serie.yaxis.p2c(open);
                height = serie.yaxis.p2c(close) - serie.yaxis.p2c(open);  
                ctx.fillStyle = '#51FF21';
            } else { //Decending
                y = offset.top + serie.yaxis.p2c(close);
                height = serie.yaxis.p2c(open) - serie.yaxis.p2c(close); 
                ctx.fillStyle = '#FF0000';
            }
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 0;
            x = offset.left + serie.xaxis.p2c(dt);
            
            //body
            ctx.fillRect (x, y, width, height);
            ctx.strokeRect(x, y, width, height);
            
            var highY = serie.yaxis.p2c(high); 
            var lowY = serie.yaxis.p2c(low); 
            
            //top
            var lineX;
            if (highY < y + height){
                ctx.beginPath();
                lineX = x + (width /2);
                ctx.moveTo(lineX,y + height);
                ctx.lineTo(lineX,highY);
                ctx.closePath();
                ctx.stroke();
            }
            
            //bottom
            if (lowY > y){
                ctx.beginPath();
                ctx.moveTo(lineX,y);
                ctx.lineTo(lineX,lowY);
                ctx.closePath();
                ctx.stroke();
            }
        }
    }

    $.plot.plugins.push({
        init: init,
        options: options,
        name: 'candle',
        version: '1.0'
    });
})($);
