(function(){

    var nv = window.nv || {};

    nv.version = '0.0.1a';

    window.nv = nv;

    nv.tooltip = {}; // For the tooltip system
    nv.utils = {}; // Utility subsystem
    nv.models = {}; //stores all the possible models/components
    nv.charts = {}; //stores all the ready to use charts
    nv.graphs = []; //stores all the graphs currently on the page
    nv.logs = {}; //stores some statistics and potential error messages

    nv.dispatch = d3.dispatch('render_start', 'render_end');

// ********************************************
//  Public Core NV functions

// Logs all arguments, and returns the last so you can test things in place
    nv.log = function() {
        if (nv.dev && console.log && console.log.apply) console.log.apply(console, arguments);
        return arguments[arguments.length - 1];
    };


    nv.render = function render(step) {
        step = step || 1; // number of graphs to generate in each timout loop

        render.active = true;
        nv.dispatch.render_start();

        setTimeout(function() {
            var chart;

            for (var i = 0; i < step && (graph = render.queue[i]); i++) {
                chart = graph.generate();
                if (typeof graph.callback == typeof(Function)) graph.callback(chart);
                nv.graphs.push(chart);
            }

            render.queue.splice(0, i);

            if (render.queue.length) setTimeout(arguments.callee, 0);
            else { nv.render.active = false; nv.dispatch.render_end(); }
        }, 0);
    };

    nv.render.active = false;
    nv.render.queue = [];

    nv.addGraph = function(obj) {
        if (typeof arguments[0] === typeof(Function))
            obj = {generate: arguments[0], callback: arguments[1]};

        nv.render.queue.push(obj);

        if (!nv.render.active) nv.render();
    };


    /*****
     * A no frills tooltip implementation.
     *****/
    (function() {

        var nvtooltip = window.nv.tooltip = {};

        nvtooltip.show = function(pos, content, gravity, dist, parentContainer, classes) {

            var container = document.createElement('div');
            container.className = 'nvtooltip ' + (classes ? classes : 'xy-tooltip');

            gravity = gravity || 's';
            dist = dist || 20;

            var body = parentContainer ? parentContainer : document.getElementsByTagName('body')[0];

            container.innerHTML = content;
            container.style.left = 0;
            container.style.top = 0;
            container.style.opacity = 0;

            body.appendChild(container);

            var height = parseInt(container.offsetHeight),
                width = parseInt(container.offsetWidth),
                windowWidth = nv.utils.windowSize().width,
                windowHeight = nv.utils.windowSize().height,
                scrollTop = body.scrollTop,
                scrollLeft = body.scrollLeft,
                left, top;


            switch (gravity) {
                case 'e':
                    left = pos[0] - width - dist;
                    top = pos[1] - (height / 2);
                    if (left < scrollLeft) left = pos[0] + dist;
                    if (top < scrollTop) top = scrollTop + 5;
                    if (top + height > scrollTop + windowHeight) top = scrollTop - height - 5;
                    break;
                case 'w':
                    left = pos[0] + dist;
                    top = pos[1] - (height / 2);
                    if (left + width > windowWidth) left = pos[0] - width - dist;
                    if (top < scrollTop) top = scrollTop + 5;
                    if (top + height > scrollTop + windowHeight) top = scrollTop - height - 5;
                    break;
                case 'n':
                    left = pos[0] - (width / 2);
                    top = pos[1] + dist;
                    if (left < scrollLeft) left = scrollLeft + 5;
                    if (left + width > windowWidth) left = windowWidth - width - 5;
                    if (top + height > scrollTop + windowHeight) top = pos[1] - height - dist;
                    break;
                case 's':
                    left = pos[0] - (width / 2);
                    top = pos[1] - height - dist;
                    if (left < scrollLeft) left = scrollLeft + 5;
                    if (left + width > windowWidth) left = windowWidth - width - 5;
                    if (scrollTop > top) top = pos[1] + 20;
                    break;
            }

            container.style.left = left+'px';
            container.style.top = top+'px';
            container.style.opacity = 1;
            container.style.position = 'absolute'; //fix scroll bar issue
            container.style.pointerEvents = 'none'; //fix scroll bar issue

            return container;
        };

        nvtooltip.cleanup = function() {

            // Find the tooltips, mark them for removal by this class (so others cleanups won't find it)
            var tooltips = document.getElementsByClassName('nvtooltip');
            var purging = [];
            while(tooltips.length) {
                purging.push(tooltips[0]);
                tooltips[0].style.transitionDelay = '0 !important';
                tooltips[0].style.opacity = 0;
                tooltips[0].className = 'nvtooltip-pending-removal';
            }


            setTimeout(function() {

                while (purging.length) {
                    var removeMe = purging.pop();
                    removeMe.parentNode.removeChild(removeMe);
                }
            }, 500);
        };


    })();

    nv.utils.windowSize = function() {
        // Sane defaults
        var size = {width: 640, height: 480};

        // Earlier IE uses Doc.body
        if (document.body && document.body.offsetWidth) {
            size.width = document.body.offsetWidth;
            size.height = document.body.offsetHeight;
        }

        // IE can use depending on mode it is in
        if (document.compatMode=='CSS1Compat' &&
            document.documentElement &&
            document.documentElement.offsetWidth ) {
            size.width = document.documentElement.offsetWidth;
            size.height = document.documentElement.offsetHeight;
        }

        // Most recent browsers use
        if (window.innerWidth && window.innerHeight) {
            size.width = window.innerWidth;
            size.height = window.innerHeight;
        }
        return (size);
    };

// Easy way to bind multiple functions to window.onresize
// TODO: give a way to remove a function after its bound, other than removing all of them
    nv.utils.windowResize = function(fun){
        var oldresize = window.onresize;

        window.onresize = function(e) {
            if (typeof oldresize == 'function') oldresize(e);
            fun(e);
        }
    };

// Backwards compatible way to implement more d3-like coloring of graphs.
// If passed an array, wrap it in a function which implements the old default
// behaviour
    nv.utils.getColor = function(color) {
        if (!arguments.length) return nv.utils.defaultColor(); //if you pass in nothing, get default colors back

        if( Object.prototype.toString.call( color ) === '[object Array]' )
            return function(d, i) { return d.color || color[i % color.length]; };
        else
            return color;
        //can't really help it if someone passes rubish as color
    };

// Default color chooser uses the index of an object as before.
    nv.utils.defaultColor = function() {
        var colors = d3.scale.category20().range();
        return function(d, i) { return d.color || colors[i % colors.length] };
    };

    nv.models.axis = function() {

        //============================================================
        // Public Variables with Default Settings
        //------------------------------------------------------------

        var axis = d3.svg.axis()
            ;

        var margin = {top: 0, right: 0, bottom: 0, left: 0}
            , width = 60 //only used for tickLabel currently
            , height = 60 //only used for tickLabel currently
            , scale = d3.scale.linear()
            , axisLabelText = null
            , showMaxMin = true //TODO: showMaxMin should be disabled on all ordinal scaled axes
            , highlightZero = true
            , rotateLabels = 0
            , rotateYLabel = true
            , staggerLabels = false
            , ticks = null
            ;

        axis
            .scale(scale)
            .orient('bottom')
            .tickFormat(function(d) { return d })
        ;

        //============================================================


        //============================================================
        // Private Variables
        //------------------------------------------------------------

        var scale0;

        //============================================================


        function chart(selection) {
            selection.each(function(data) {
                var container = d3.select(this);


                //------------------------------------------------------------
                // Setup containers and skeleton of chart

                var wrap = container.selectAll('g.nv-wrap.nv-axis').data([data]);
                var wrapEnter = wrap.enter().append('g').attr('class', 'nvd3 nv-wrap nv-axis');
                var gEnter = wrapEnter.append('g');
                var g = wrap.select('g');

                //------------------------------------------------------------


                if (ticks !== null)
                    axis.ticks(ticks);
                else if (axis.orient() == 'top' || axis.orient() == 'bottom')
                    axis.ticks(Math.abs(scale.range()[1] - scale.range()[0]) / 100);


                //TODO: consider calculating width/height based on whether or not label is added, for reference in charts using this component


                d3.transition(g)
                    .call(axis);

                scale0 = scale0 || axis.scale();

                var fmt = axis.tickFormat();
                if (fmt == null) {
                    fmt = scale0.tickFormat();
                }

                var axisLabel = g.selectAll('text.nv-axislabel')
                    .data([axisLabelText || null]);
                axisLabel.exit().remove();
                switch (axis.orient()) {
                    case 'top':
                        axisLabel.enter().append('text').attr('class', 'nv-axislabel')
                            .attr('text-anchor', 'middle')
                            .attr('y', 0);
                        var w = (scale.range().length==2) ? scale.range()[1] : (scale.range()[scale.range().length-1]+(scale.range()[1]-scale.range()[0]));
                        axisLabel
                            .attr('x', w/2);
                        if (showMaxMin) {
                            var axisMaxMin = wrap.selectAll('g.nv-axisMaxMin')
                                .data(scale.domain());
                            axisMaxMin.enter().append('g').attr('class', 'nv-axisMaxMin').append('text');
                            axisMaxMin.exit().remove();
                            axisMaxMin
                                .attr('transform', function(d,i) {
                                    return 'translate(' + scale(d) + ',0)'
                                })
                                .select('text')
                                .attr('dy', '0em')
                                .attr('y', -axis.tickPadding())
                                .attr('text-anchor', 'middle')
                                .text(function(d,i) {
                                    var v = fmt(d);
                                    return ('' + v).match('NaN') ? '' : v;
                                });
                            d3.transition(axisMaxMin)
                                .attr('transform', function(d,i) {
                                    return 'translate(' + scale.range()[i] + ',0)'
                                });
                        }
                        break;
                    case 'bottom':
                        var xLabelMargin = 30;
                        var maxTextWidth = 30;
                        var xTicks = g.selectAll('g').select("text");
                        if (rotateLabels%360) {
                            //Calculate the longest xTick width
                            xTicks.each(function(d,i){
                                var width = this.getBBox().width;
                                if(width > maxTextWidth) maxTextWidth = width;
                            });
                            //Convert to radians before calculating sin. Add 30 to margin for healthy padding.
                            var sin = Math.abs(Math.sin(rotateLabels*Math.PI/180));
                            var xLabelMargin = (sin ? sin*maxTextWidth : maxTextWidth)+30;
                            //Rotate all xTicks
                            xTicks
                                .attr('transform', function(d,i,j) { return 'rotate(' + rotateLabels + ' 0,0)' })
                                .attr('text-anchor', rotateLabels%360 > 0 ? 'start' : 'end');
                        }
                        axisLabel.enter().append('text').attr('class', 'nv-axislabel')
                            .attr('text-anchor', 'middle')
                            .attr('y', xLabelMargin);
                        var w = (scale.range().length==2) ? scale.range()[1] : (scale.range()[scale.range().length-1]+(scale.range()[1]-scale.range()[0]));
                        axisLabel
                            .attr('x', w/2);
                        if (showMaxMin) {
                            var axisMaxMin = wrap.selectAll('g.nv-axisMaxMin')
                                .data(scale.domain());
                            axisMaxMin.enter().append('g').attr('class', 'nv-axisMaxMin').append('text');
                            axisMaxMin.exit().remove();
                            axisMaxMin
                                .attr('transform', function(d,i) {
                                    return 'translate(' + scale(d) + ',0)'
                                })
                                .select('text')
                                .attr('dy', '.71em')
                                .attr('y', axis.tickPadding())
                                .attr('transform', function(d,i,j) { return 'rotate(' + rotateLabels + ' 0,0)' })
                                .attr('text-anchor', rotateLabels ? (rotateLabels%360 > 0 ? 'start' : 'end') : 'middle')
                                .text(function(d,i) {
                                    var v = fmt(d);
                                    return ('' + v).match('NaN') ? '' : v;
                                });
                            d3.transition(axisMaxMin)
                                .attr('transform', function(d,i) {
                                    return 'translate(' + scale.range()[i] + ',0)'
                                });
                        }
                        if (staggerLabels)
                            xTicks
                                .attr('transform', function(d,i) { return 'translate(0,' + (i % 2 == 0 ? '0' : '12') + ')' });

                        break;
                    case 'right':
                        axisLabel.enter().append('text').attr('class', 'nv-axislabel')
                            .attr('text-anchor', rotateYLabel ? 'middle' : 'begin')
                            .attr('transform', rotateYLabel ? 'rotate(90)' : '')
                            .attr('y', rotateYLabel ? (-Math.max(margin.right,width) - 12) : -10); //TODO: consider calculating this based on largest tick width... OR at least expose this on chart
                        axisLabel
                            .attr('x', rotateYLabel ? (scale.range()[0] / 2) : axis.tickPadding());
                        if (showMaxMin) {
                            var axisMaxMin = wrap.selectAll('g.nv-axisMaxMin')
                                .data(scale.domain());
                            axisMaxMin.enter().append('g').attr('class', 'nv-axisMaxMin').append('text')
                                .style('opacity', 0);
                            axisMaxMin.exit().remove();
                            axisMaxMin
                                .attr('transform', function(d,i) {
                                    return 'translate(0,' + scale(d) + ')'
                                })
                                .select('text')
                                .attr('dy', '.32em')
                                .attr('y', 0)
                                .attr('x', axis.tickPadding())
                                .attr('text-anchor', 'start')
                                .text(function(d,i) {
                                    var v = fmt(d);
                                    return ('' + v).match('NaN') ? '' : v;
                                });
                            d3.transition(axisMaxMin)
                                .attr('transform', function(d,i) {
                                    return 'translate(0,' + scale.range()[i] + ')'
                                })
                                .select('text')
                                .style('opacity', 1);
                        }
                        break;
                    case 'left':
                        axisLabel.enter().append('text').attr('class', 'nv-axislabel')
                            .attr('text-anchor', rotateYLabel ? 'middle' : 'end')
                            .attr('transform', rotateYLabel ? 'rotate(-90)' : '')
                            .attr('y', rotateYLabel ? (-Math.max(margin.left,width) + 12) : -10); //TODO: consider calculating this based on largest tick width... OR at least expose this on chart
                        axisLabel
                            .attr('x', rotateYLabel ? (-scale.range()[0] / 2) : -axis.tickPadding());
                        if (showMaxMin) {
                            var axisMaxMin = wrap.selectAll('g.nv-axisMaxMin')
                                .data(scale.domain());
                            axisMaxMin.enter().append('g').attr('class', 'nv-axisMaxMin').append('text')
                                .style('opacity', 0);
                            axisMaxMin.exit().remove();
                            axisMaxMin
                                .attr('transform', function(d,i) {
                                    return 'translate(0,' + scale0(d) + ')'
                                })
                                .select('text')
                                .attr('dy', '.32em')
                                .attr('y', 0)
                                .attr('x', -axis.tickPadding())
                                .attr('text-anchor', 'end')
                                .text(function(d,i) {
                                    var v = fmt(d);
                                    return ('' + v).match('NaN') ? '' : v;
                                });
                            d3.transition(axisMaxMin)
                                .attr('transform', function(d,i) {
                                    return 'translate(0,' + scale.range()[i] + ')'
                                })
                                .select('text')
                                .style('opacity', 1);
                        }
                        break;
                }
                axisLabel
                    .text(function(d) { return d });


                //check if max and min overlap other values, if so, hide the values that overlap
                if (showMaxMin && (axis.orient() === 'left' || axis.orient() === 'right')) {
                    g.selectAll('g') // the g's wrapping each tick
                        .each(function(d,i) {
                            if (scale(d) < scale.range()[1] + 10 || scale(d) > scale.range()[0] - 10) { // 10 is assuming text height is 16... if d is 0, leave it!
                                if (d > 1e-10 || d < -1e-10) // accounts for minor floating point errors... though could be problematic if the scale is EXTREMELY SMALL
                                    d3.select(this).remove();
                                else
                                    d3.select(this).select('text').remove(); // Don't remove the ZERO line!!
                            }
                        });
                }

                if (showMaxMin && (axis.orient() === 'top' || axis.orient() === 'bottom')) {
                    var maxMinRange = [];
                    wrap.selectAll('g.nv-axisMaxMin')
                        .each(function(d,i) {
                            if (i) // i== 1, max position
                                maxMinRange.push(scale(d) - this.getBBox().width - 4)  //assuming the max and min labels are as wide as the next tick (with an extra 4 pixels just in case)
                            else // i==0, min position
                                maxMinRange.push(scale(d) + this.getBBox().width + 4)
                        });
                    g.selectAll('g') // the g's wrapping each tick
                        .each(function(d,i) {
                            if (scale(d) < maxMinRange[0] || scale(d) > maxMinRange[1]) {
                                if (d > 1e-10 || d < -1e-10) // accounts for minor floating point errors... though could be problematic if the scale is EXTREMELY SMALL
                                    d3.select(this).remove();
                                else
                                    d3.select(this).select('text').remove(); // Don't remove the ZERO line!!
                            }
                        });
                }


                //highlight zero line ... Maybe should not be an option and should just be in CSS?
                if (highlightZero)
                    g.selectAll('line.tick')
                        .filter(function(d) { return !parseFloat(Math.round(d*100000)/1000000) }) //this is because sometimes the 0 tick is a very small fraction, TODO: think of cleaner technique
                        .classed('zero', true);

                //store old scales for use in transitions on update
                scale0 = scale.copy();

            });

            return chart;
        }


        //============================================================
        // Expose Public Variables
        //------------------------------------------------------------

        // expose chart's sub-components
        chart.axis = axis;

        d3.rebind(chart, axis, 'orient', 'tickValues', 'tickSubdivide', 'tickSize', 'tickPadding', 'tickFormat');
        d3.rebind(chart, scale, 'domain', 'range', 'rangeBand', 'rangeBands'); //these are also accessible by chart.scale(), but added common ones directly for ease of use

        chart.margin = function(_) {
            if(!arguments.length) return margin;
            margin.top    = typeof _.top    != 'undefined' ? _.top    : margin.top;
            margin.right  = typeof _.right  != 'undefined' ? _.right  : margin.right;
            margin.bottom = typeof _.bottom != 'undefined' ? _.bottom : margin.bottom;
            margin.left   = typeof _.left   != 'undefined' ? _.left   : margin.left;
            return chart;
        };

        chart.width = function(_) {
            if (!arguments.length) return width;
            width = _;
            return chart;
        };

        chart.ticks = function(_) {
            if (!arguments.length) return ticks;
            ticks = _;
            return chart;
        };

        chart.height = function(_) {
            if (!arguments.length) return height;
            height = _;
            return chart;
        };

        chart.axisLabel = function(_) {
            if (!arguments.length) return axisLabelText;
            axisLabelText = _;
            return chart;
        };

        chart.showMaxMin = function(_) {
            if (!arguments.length) return showMaxMin;
            showMaxMin = _;
            return chart;
        };

        chart.highlightZero = function(_) {
            if (!arguments.length) return highlightZero;
            highlightZero = _;
            return chart;
        };

        chart.scale = function(_) {
            if (!arguments.length) return scale;
            scale = _;
            axis.scale(scale);
            d3.rebind(chart, scale, 'domain', 'range', 'rangeBand', 'rangeBands');
            return chart;
        };

        chart.rotateYLabel = function(_) {
            if(!arguments.length) return rotateYLabel;
            rotateYLabel = _;
            return chart;
        };

        chart.rotateLabels = function(_) {
            if(!arguments.length) return rotateLabels;
            rotateLabels = _;
            return chart;
        };

        chart.staggerLabels = function(_) {
            if (!arguments.length) return staggerLabels;
            staggerLabels = _;
            return chart;
        };


        //============================================================


        return chart;
    };

    nv.models.distribution = function() {

        //============================================================
        // Public Variables with Default Settings
        //------------------------------------------------------------

        var margin = {top: 0, right: 0, bottom: 0, left: 0}
            , width = 400 //technically width or height depending on x or y....
            , size = 8
            , axis = 'x' // 'x' or 'y'... horizontal or vertical
            , getData = function(d) { return d[axis] }  // defaults d.x or d.y
            , color = nv.utils.defaultColor()
            , scale = d3.scale.linear()
            , domain
            ;

        //============================================================


        //============================================================
        // Private Variables
        //------------------------------------------------------------

        var scale0;

        //============================================================


        function chart(selection) {
            selection.each(function(data) {
                var availableLength = width - (axis === 'x' ? margin.left + margin.right : margin.top + margin.bottom),
                    naxis = axis == 'x' ? 'y' : 'x',
                    container = d3.select(this);


                //------------------------------------------------------------
                // Setup Scales

                scale0 = scale0 || scale;

                //------------------------------------------------------------


                //------------------------------------------------------------
                // Setup containers and skeleton of chart

                var wrap = container.selectAll('g.nv-distribution').data([data]);
                var wrapEnter = wrap.enter().append('g').attr('class', 'nvd3 nv-distribution');
                var gEnter = wrapEnter.append('g');
                var g = wrap.select('g');

                wrap.attr('transform', 'translate(' + margin.left + ',' + margin.top + ')')

                //------------------------------------------------------------


                var distWrap = g.selectAll('g.nv-dist')
                    .data(function(d) { return d }, function(d) { return d.key });

                distWrap.enter().append('g');
                distWrap
                    .attr('class', function(d,i) { return 'nv-dist nv-series-' + i })
                    .style('stroke', function(d,i) { return color(d, i) });

                var dist = distWrap.selectAll('line.nv-dist' + axis)
                    .data(function(d) { return d.values })
                dist.enter().append('line')
                    .attr(axis + '1', function(d,i) { return scale0(getData(d,i)) })
                    .attr(axis + '2', function(d,i) { return scale0(getData(d,i)) })
                d3.transition(distWrap.exit().selectAll('line.nv-dist' + axis))
                    .attr(axis + '1', function(d,i) { return scale(getData(d,i)) })
                    .attr(axis + '2', function(d,i) { return scale(getData(d,i)) })
                    .style('stroke-opacity', 0)
                    .remove();
                dist
                    .attr('class', function(d,i) { return 'nv-dist' + axis + ' nv-dist' + axis + '-' + i })
                    .attr(naxis + '1', 0)
                    .attr(naxis + '2', size);
                d3.transition(dist)
                    .attr(axis + '1', function(d,i) { return scale(getData(d,i)) })
                    .attr(axis + '2', function(d,i) { return scale(getData(d,i)) })


                scale0 = scale.copy();

            });

            return chart;
        }


        //============================================================
        // Expose Public Variables
        //------------------------------------------------------------

        chart.margin = function(_) {
            if (!arguments.length) return margin;
            margin.top    = typeof _.top    != 'undefined' ? _.top    : margin.top;
            margin.right  = typeof _.right  != 'undefined' ? _.right  : margin.right;
            margin.bottom = typeof _.bottom != 'undefined' ? _.bottom : margin.bottom;
            margin.left   = typeof _.left   != 'undefined' ? _.left   : margin.left;
            return chart;
        };

        chart.width = function(_) {
            if (!arguments.length) return width;
            width = _;
            return chart;
        };

        chart.axis = function(_) {
            if (!arguments.length) return axis;
            axis = _;
            return chart;
        };

        chart.size = function(_) {
            if (!arguments.length) return size;
            size = _;
            return chart;
        };

        chart.getData = function(_) {
            if (!arguments.length) return getData;
            getData = d3.functor(_);
            return chart;
        };

        chart.scale = function(_) {
            if (!arguments.length) return scale;
            scale = _;
            return chart;
        };

        chart.color = function(_) {
            if (!arguments.length) return color;
            color = nv.utils.getColor(_);
            return chart;
        };

        //============================================================


        return chart;
    }

    nv.models.legend = function() {

        //============================================================
        // Public Variables with Default Settings
        //------------------------------------------------------------

        var margin = {top: 5, right: 0, bottom: 5, left: 0}
            , width = 400
            , height = 20
            , getKey = function(d) { return d.key }
            , color = nv.utils.defaultColor()
            , align = true
            , dispatch = d3.dispatch('legendClick', 'legendDblclick', 'legendMouseover', 'legendMouseout')
            ;

        //============================================================


        function chart(selection) {
            selection.each(function(data) {
                var availableWidth = width - margin.left - margin.right,
                    container = d3.select(this);


                //------------------------------------------------------------
                // Setup containers and skeleton of chart

                var wrap = container.selectAll('g.nv-legend').data([data]);
                var gEnter = wrap.enter().append('g').attr('class', 'nvd3 nv-legend').append('g');
                var g = wrap.select('g');

                wrap.attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

                //------------------------------------------------------------


                var series = g.selectAll('.nv-series')
                    .data(function(d) { return d });
                var seriesEnter = series.enter().append('g').attr('class', 'nv-series')
                    .on('mouseover', function(d,i) {
                        dispatch.legendMouseover(d,i);  //TODO: Make consistent with other event objects
                    })
                    .on('mouseout', function(d,i) {
                        dispatch.legendMouseout(d,i);
                    })
                    .on('click', function(d,i) {
                        dispatch.legendClick(d,i);
                    })
                    .on('dblclick', function(d,i) {
                        dispatch.legendDblclick(d,i);
                    });
                seriesEnter.append('circle')
                    .style('stroke-width', 2)
                    .attr('r', 5);
                seriesEnter.append('text')
                    .attr('text-anchor', 'start')
                    .attr('dy', '.32em')
                    .attr('dx', '8');
                series.classed('disabled', function(d) { return d.disabled });
                series.exit().remove();
                series.select('circle')
                    .style('fill', function(d,i) { return d.color || color(d,i)})
                    .style('stroke', function(d,i) { return d.color || color(d, i) });
                series.select('text').text(getKey);


                //TODO: implement fixed-width and max-width options (max-width is especially useful with the align option)

                // NEW ALIGNING CODE, TODO: clean up
                if (align) {
                    var seriesWidths = [];
                    series.each(function(d,i) {
                        seriesWidths.push(d3.select(this).select('text').node().getComputedTextLength() + 28); // 28 is ~ the width of the circle plus some padding
                    });

                    //nv.log('Series Widths: ', JSON.stringify(seriesWidths));

                    var seriesPerRow = 0;
                    var legendWidth = 0;
                    var columnWidths = [];

                    while ( legendWidth < availableWidth && seriesPerRow < seriesWidths.length) {
                        columnWidths[seriesPerRow] = seriesWidths[seriesPerRow];
                        legendWidth += seriesWidths[seriesPerRow++];
                    }


                    while ( legendWidth > availableWidth && seriesPerRow > 1 ) {
                        columnWidths = [];
                        seriesPerRow--;

                        for (k = 0; k < seriesWidths.length; k++) {
                            if (seriesWidths[k] > (columnWidths[k % seriesPerRow] || 0) )
                                columnWidths[k % seriesPerRow] = seriesWidths[k];
                        }

                        legendWidth = columnWidths.reduce(function(prev, cur, index, array) {
                            return prev + cur;
                        });
                    }
                    //console.log(columnWidths, legendWidth, seriesPerRow);

                    var xPositions = [];
                    for (var i = 0, curX = 0; i < seriesPerRow; i++) {
                        xPositions[i] = curX;
                        curX += columnWidths[i];
                    }

                    series
                        .attr('transform', function(d, i) {
                            return 'translate(' + xPositions[i % seriesPerRow] + ',' + (5 + Math.floor(i / seriesPerRow) * 20) + ')';
                        });

                    //position legend as far right as possible within the total width
                    g.attr('transform', 'translate(' + (width - margin.right - legendWidth) + ',' + margin.top + ')');

                    height = margin.top + margin.bottom + (Math.ceil(seriesWidths.length / seriesPerRow) * 20);

                } else {

                    var ypos = 5,
                        newxpos = 5,
                        maxwidth = 0,
                        xpos;
                    series
                        .attr('transform', function(d, i) {
                            var length = d3.select(this).select('text').node().getComputedTextLength() + 28;
                            xpos = newxpos;

                            if (width < margin.left + margin.right + xpos + length) {
                                newxpos = xpos = 5;
                                ypos += 20;
                            }

                            newxpos += length;
                            if (newxpos > maxwidth) maxwidth = newxpos;

                            return 'translate(' + xpos + ',' + ypos + ')';
                        });

                    //position legend as far right as possible within the total width
                    g.attr('transform', 'translate(' + (width - margin.right - maxwidth) + ',' + margin.top + ')');

                    height = margin.top + margin.bottom + ypos + 15;

                }

            });

            return chart;
        }


        //============================================================
        // Expose Public Variables
        //------------------------------------------------------------

        chart.dispatch = dispatch;

        chart.margin = function(_) {
            if (!arguments.length) return margin;
            margin.top    = typeof _.top    != 'undefined' ? _.top    : margin.top;
            margin.right  = typeof _.right  != 'undefined' ? _.right  : margin.right;
            margin.bottom = typeof _.bottom != 'undefined' ? _.bottom : margin.bottom;
            margin.left   = typeof _.left   != 'undefined' ? _.left   : margin.left;
            return chart;
        };

        chart.width = function(_) {
            if (!arguments.length) return width;
            width = _;
            return chart;
        };

        chart.height = function(_) {
            if (!arguments.length) return height;
            height = _;
            return chart;
        };

        chart.key = function(_) {
            if (!arguments.length) return getKey;
            getKey = _;
            return chart;
        };

        chart.color = function(_) {
            if (!arguments.length) return color;
            color = nv.utils.getColor(_);
            return chart;
        };

        chart.align = function(_) {
            if (!arguments.length) return align;
            align = _;
            return chart;
        };

        //============================================================


        return chart;
    }

    nv.models.scatter = function() {

        //============================================================
        // Public Variables with Default Settings
        //------------------------------------------------------------

        var margin      = {top: 0, right: 0, bottom: 0, left: 0}
            , width       = 960
            , height      = 500
            , color       = nv.utils.defaultColor() // chooses color
            , id          = Math.floor(Math.random() * 100000) //Create semi-unique ID incase user doesn't selet one
            , x           = d3.scale.linear()
            , y           = d3.scale.log()
            , z           = d3.scale.linear() //linear because d3.svg.shape.size is treated as area
            , getX        = function(d) { return d.x } // accessor to get the x value
            , getY        = function(d) { return d.y } // accessor to get the y value
            , getSize     = function(d) { return d.size || 1} // accessor to get the point size
            , getShape    = function(d) { return d.shape || 'circle' } // accessor to get point shape
            , forceX      = [] // List of numbers to Force into the X scale (ie. 0, or a max / min, etc.)
            , forceY      = [] // List of numbers to Force into the Y scale
            , forceSize   = [] // List of numbers to Force into the Size scale
            , interactive = true // If true, plots a voronoi overlay for advanced point interection
            , pointActive = function(d) { return !d.notActive } // any points that return false will be filtered out
            , clipEdge    = false // if true, masks points within x and y scale
            , clipVoronoi = true // if true, masks each point with a circle... can turn off to slightly increase performance
            , clipRadius  = function() { return 25 } // function to get the radius for voronoi point clips
            , xDomain     = null // Override x domain (skips the calculation from data)
            , yDomain     = null // Override y domain
            , sizeDomain  = null // Override point size domain
            , sizeRange   = null
            , singlePoint = false
            , dispatch    = d3.dispatch('elementClick', 'elementMouseover', 'elementMouseout')
            , useVoronoi  = true
            ;

        //============================================================


        //============================================================
        // Private Variables
        //------------------------------------------------------------

        var x0, y0, z0 // used to store previous scales
            , timeoutID
            ;

        //============================================================


        function chart(selection) {
            selection.each(function(data) {
                var availableWidth = width - margin.left - margin.right,
                    availableHeight = height - margin.top - margin.bottom,
                    container = d3.select(this);

                //add series index to each data point for reference
                data = data.map(function(series, i) {
                    series.values = series.values.map(function(point) {
                        point.series = i;
                        return point;
                    });
                    return series;
                });

                //------------------------------------------------------------
                // Setup Scales

                // remap and flatten the data for use in calculating the scales' domains
                var seriesData = (xDomain && yDomain && sizeDomain) ? [] : // if we know xDomain and yDomain and sizeDomain, no need to calculate.... if Size is constant remember to set sizeDomain to speed up performance
                    d3.merge(
                        data.map(function(d) {
                            return d.values.map(function(d,i) {
                                return { x: getX(d,i), y: getY(d,i), size: getSize(d,i) }
                            })
                        })
                    );

                x   .domain(xDomain || d3.extent(seriesData.map(function(d) { return d.x }).concat(forceX)))
                    .range([0, availableWidth]);

                y   .domain(yDomain || d3.extent(seriesData.map(function(d) { return d.y }).concat(forceY)))
                    .range([availableHeight, 0]);

                z   .domain(sizeDomain || d3.extent(seriesData.map(function(d) { return d.size }).concat(forceSize)))
                    .range(sizeRange || [16, 256]);

                // If scale's domain don't have a range, slightly adjust to make one... so a chart can show a single data point
                if (x.domain()[0] === x.domain()[1] || y.domain()[0] === y.domain()[1]) singlePoint = true;
                if (x.domain()[0] === x.domain()[1])
                    x.domain()[0] ?
                        x.domain([x.domain()[0] - x.domain()[0] * 0.01, x.domain()[1] + x.domain()[1] * 0.01])
                        : x.domain([-1,1]);

                if (y.domain()[0] === y.domain()[1])
                    y.domain()[0] ?
                        y.domain([y.domain()[0] + y.domain()[0] * 0.01, y.domain()[1] - y.domain()[1] * 0.01])
                        : y.domain([-1,1]);


                x0 = x0 || x;
                y0 = y0 || y;
                z0 = z0 || z;

                //------------------------------------------------------------


                //------------------------------------------------------------
                // Setup containers and skeleton of chart

                var wrap = container.selectAll('g.nv-wrap.nv-scatter').data([data]);
                var wrapEnter = wrap.enter().append('g').attr('class', 'nvd3 nv-wrap nv-scatter nv-chart-' + id + (singlePoint ? ' nv-single-point' : ''));
                var defsEnter = wrapEnter.append('defs');
                var gEnter = wrapEnter.append('g');
                var g = wrap.select('g');

                gEnter.append('g').attr('class', 'nv-groups');
                gEnter.append('g').attr('class', 'nv-point-paths');

                wrap.attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

                //------------------------------------------------------------


                defsEnter.append('clipPath')
                    .attr('id', 'nv-edge-clip-' + id)
                    .append('rect');

                wrap.select('#nv-edge-clip-' + id + ' rect')
                    .attr('width', availableWidth)
                    .attr('height', availableHeight);

                g   .attr('clip-path', clipEdge ? 'url(#nv-edge-clip-' + id + ')' : '');


                function updateInteractiveLayer() {

                    if (!interactive) return false;

                    var eventElements;

                    var vertices = d3.merge(data.map(function(group, groupIndex) {
                        return group.values
                            .map(function(point, pointIndex) {
                                // *Adding noise to make duplicates very unlikely
                                // **Injecting series and point index for reference
                                return [x(getX(point,pointIndex)) * (Math.random() / 1e12 + 1)  , y(getY(point,pointIndex)) * (Math.random() / 1e12 + 1), groupIndex, pointIndex, point]; //temp hack to add noise untill I think of a better way so there are no duplicates
                            })
                            .filter(function(pointArray, pointIndex) {
                                return pointActive(pointArray[4], pointIndex); // Issue #237.. move filter to after map, so pointIndex is correct!
                            })
                    })
                    );


                    if (clipVoronoi) {
                        defsEnter.append('clipPath').attr('id', 'nv-points-clip-' + id);

                        var pointClips = wrap.select('#nv-points-clip-' + id).selectAll('circle')
                            .data(vertices);
                        pointClips.enter().append('circle')
                            .attr('r', clipRadius);
                        pointClips.exit().remove();
                        pointClips
                            .attr('cx', function(d) { return d[0] })
                            .attr('cy', function(d) { return d[1] });

                        wrap.select('.nv-point-paths')
                            .attr('clip-path', 'url(#nv-points-clip-' + id + ')');
                    }


                    //inject series and point index for reference into voronoi
                    if (useVoronoi === true) {
                        var voronoi = d3.geom.voronoi(vertices).map(function(d, i) {
                            return {
                                'data': d,
                                'series': vertices[i][2],
                                'point': vertices[i][3]
                            }
                        });


                        var pointPaths = wrap.select('.nv-point-paths').selectAll('path')
                            .data(voronoi);
                        pointPaths.enter().append('path')
                            .attr('class', function(d,i) { return 'nv-path-'+i; });
                        pointPaths.exit().remove();
                        pointPaths
                            .attr('d', function(d) { return 'M' + d.data.join(',') + 'Z'; });

                        eventElements = pointPaths;

                    } else {
                        // bring data in form needed for click handlers
                        var dataWithPoints = vertices.map(function(d, i) {
                            return {
                                'data': d,
                                'series': vertices[i][2],
                                'point': vertices[i][3]
                            }
                        });

                        // add event handlers to points instead voronoi paths
                        eventElements = wrap.select('.nv-groups').selectAll('.nv-group')
                            .selectAll('path.nv-point')
                            .data(dataWithPoints)
                            .style('pointer-events', 'auto'); // recativate events, disabled by css
                    }

                    eventElements
                        .on('click', function(d) {
                            var series = data[d.series],
                                point  = series.values[d.point];

                            dispatch.elementClick({
                                point: point,
                                series: series,
                                pos: [x(getX(point, d.point)) + margin.left, y(getY(point, d.point)) + margin.top],
                                seriesIndex: d.series,
                                pointIndex: d.point
                            });
                        })
                        .on('mouseover', function(d) {
                            var series = data[d.series],
                                point  = series.values[d.point];

                            dispatch.elementMouseover({
                                point: point,
                                series: series,
                                pos: [x(getX(point, d.point)) + margin.left, y(getY(point, d.point)) + margin.top],
                                seriesIndex: d.series,
                                pointIndex: d.point
                            });
                        })
                        .on('mouseout', function(d, i) {
                            var series = data[d.series],
                                point  = series.values[d.point];

                            dispatch.elementMouseout({
                                point: point,
                                series: series,
                                seriesIndex: d.series,
                                pointIndex: d.point
                            });
                        });

                }



                var groups = wrap.select('.nv-groups').selectAll('.nv-group')
                    .data(function(d) { return d }, function(d) { return d.key });
                groups.enter().append('g')
                    .style('stroke-opacity', 1e-6)
                    .style('fill-opacity', 1e-6);
                d3.transition(groups.exit())
                    .style('stroke-opacity', 1e-6)
                    .style('fill-opacity', 1e-6)
                    .remove();
                groups
                    .attr('class', function(d,i) { return 'nv-group nv-series-' + i })
                    .classed('hover', function(d) { return d.hover });
                d3.transition(groups)
                    .style('fill', function(d,i) { return color(d, i) })
                    .style('stroke', function(d,i) { return color(d, i) })
                    .style('stroke-opacity', 1)
                    .style('fill-opacity', .5);


                var points = groups.selectAll('path.nv-point')
                    .data(function(d) { return d.values });
                points.enter().append('path')
                    .attr('transform', function(d,i) {
                        return 'translate(' + x0(getX(d,i)) + ',' + y0(getY(d,i)) + ')'
                    })
                    .attr('d',
                        d3.svg.symbol()
                            .type(getShape)
                            .size(function(d,i) { return z(getSize(d,i)) })
                    );
                points.exit().remove();
                d3.transition(groups.exit().selectAll('path.nv-point'))
                    .attr('transform', function(d,i) {
                        return 'translate(' + x(getX(d,i)) + ',' + y(getY(d,i)) + ')'
                    })
                    .remove();
                points.attr('class', function(d,i) { return 'nv-point nv-point-' + i });
                d3.transition(points)
                    .attr('transform', function(d,i) {
                        return 'translate(' + x(getX(d,i)) + ',' + y(getY(d,i)) + ')'
                    })
                    .attr('d',
                        d3.svg.symbol()
                            .type(getShape)
                            .size(function(d,i) { return z(getSize(d,i)) })
                    );


                // Delay updating the invisible interactive layer for smoother animation
                clearTimeout(timeoutID); // stop repeat calls to updateInteractiveLayer
                timeoutID = setTimeout(updateInteractiveLayer, 1000);

                //store old scales for use in transitions on update
                x0 = x.copy();
                y0 = y.copy();
                z0 = z.copy();

            });

            return chart;
        }


        //============================================================
        // Event Handling/Dispatching (out of chart's scope)
        //------------------------------------------------------------

        dispatch.on('elementMouseover.point', function(d) {
            if (interactive)
                d3.select('.nv-chart-' + id + ' .nv-series-' + d.seriesIndex + ' .nv-point-' + d.pointIndex)
                    .classed('hover', true);
        });

        dispatch.on('elementMouseout.point', function(d) {
            if (interactive)
                d3.select('.nv-chart-' + id + ' .nv-series-' + d.seriesIndex + ' .nv-point-' + d.pointIndex)
                    .classed('hover', false);
        });

        //============================================================


        //============================================================
        // Expose Public Variables
        //------------------------------------------------------------

        chart.dispatch = dispatch;

        chart.x = function(_) {
            if (!arguments.length) return getX;
            getX = d3.functor(_);
            return chart;
        };

        chart.y = function(_) {
            if (!arguments.length) return getY;
            getY = d3.functor(_);
            return chart;
        };

        chart.size = function(_) {
            if (!arguments.length) return getSize;
            getSize = d3.functor(_);
            return chart;
        };

        chart.margin = function(_) {
            if (!arguments.length) return margin;
            margin.top    = typeof _.top    != 'undefined' ? _.top    : margin.top;
            margin.right  = typeof _.right  != 'undefined' ? _.right  : margin.right;
            margin.bottom = typeof _.bottom != 'undefined' ? _.bottom : margin.bottom;
            margin.left   = typeof _.left   != 'undefined' ? _.left   : margin.left;
            return chart;
        };

        chart.width = function(_) {
            if (!arguments.length) return width;
            width = _;
            return chart;
        };

        chart.height = function(_) {
            if (!arguments.length) return height;
            height = _;
            return chart;
        };

        chart.xScale = function(_) {
            if (!arguments.length) return x;
            x = _;
            return chart;
        };

        chart.yScale = function(_) {
            if (!arguments.length) return y;
            y = _;
            return chart;
        };

        chart.zScale = function(_) {
            if (!arguments.length) return z;
            z = _;
            return chart;
        };

        chart.xDomain = function(_) {
            if (!arguments.length) return xDomain;
            xDomain = _;
            return chart;
        };

        chart.yDomain = function(_) {
            if (!arguments.length) return yDomain;
            yDomain = _;
            return chart;
        };

        chart.sizeDomain = function(_) {
            if (!arguments.length) return sizeDomain;
            sizeDomain = _;
            return chart;
        };

        chart.sizeRange = function(_) {
            if (!arguments.length) return sizeRange;
            sizeRange = _;
            return chart;
        };

        chart.forceX = function(_) {
            if (!arguments.length) return forceX;
            forceX = _;
            return chart;
        };

        chart.forceY = function(_) {
            if (!arguments.length) return forceY;
            forceY = _;
            return chart;
        };

        chart.forceSize = function(_) {
            if (!arguments.length) return forceSize;
            forceSize = _;
            return chart;
        };

        chart.interactive = function(_) {
            if (!arguments.length) return interactive;
            interactive = _;
            return chart;
        };

        chart.pointActive = function(_) {
            if (!arguments.length) return pointActive;
            pointActive = _;
            return chart;
        };

        chart.clipEdge = function(_) {
            if (!arguments.length) return clipEdge;
            clipEdge = _;
            return chart;
        };

        chart.clipVoronoi= function(_) {
            if (!arguments.length) return clipVoronoi;
            clipVoronoi = _;
            return chart;
        };

        chart.useVoronoi= function(_) {
            if (!arguments.length) return useVoronoi;
            useVoronoi = _;
            if (useVoronoi === false) {
                clipVoronoi = false;
            }
            return chart;
        };

        chart.clipRadius = function(_) {
            if (!arguments.length) return clipRadius;
            clipRadius = _;
            return chart;
        };

        chart.color = function(_) {
            if (!arguments.length) return color;
            color = nv.utils.getColor(_);
            return chart;
        };

        chart.shape = function(_) {
            if (!arguments.length) return getShape;
            getShape = _;
            return chart;
        };

        chart.id = function(_) {
            if (!arguments.length) return id;
            id = _;
            return chart;
        };

        chart.singlePoint = function(_) {
            if (!arguments.length) return singlePoint;
            singlePoint = _;
            return chart;
        };

        //============================================================


        return chart;
    }

    nv.models.scatterChart = function() {

        //============================================================
        // Public Variables with Default Settings
        //------------------------------------------------------------

        var scatter      = nv.models.scatter()
            , xAxis        = nv.models.axis()
            , yAxis        = nv.models.axis()
            , legend       = nv.models.legend()
            , controls     = nv.models.legend()
            , distX        = nv.models.distribution()
            , distY        = nv.models.distribution()
            ;

        var margin       = {top: 30, right: 20, bottom: 50, left: 60}
            , width        = null
            , height       = null
            , color        = nv.utils.defaultColor()
            , x            = d3.fisheye ? d3.fisheye.scale(d3.scale.linear).distortion(0) : scatter.xScale()
            , y            = d3.fisheye ? d3.fisheye.scale(d3.scale.linear).distortion(0) : scatter.yScale()
            , xPadding     = 0
            , yPadding     = 0
            , showDistX    = false
            , showDistY    = false
            , showLegend   = true
            , showControls = !!d3.fisheye
            , fisheye      = 0
            , pauseFisheye = false
            , tooltips     = true
            , tooltipX     = function(key, x, y) { return '<strong>' + x + '</strong>' }
            , tooltipY     = function(key, x, y) { return '<strong>' + y + '</strong>' }
        //, tooltip      = function(key, x, y) { return '<h3>' + key + '</h3>' }
            , tooltip      = null
            , dispatch     = d3.dispatch('tooltipShow', 'tooltipHide')
            , noData       = "No Data Available."
            ;

        scatter
            .xScale(x)
            .yScale(y)
        ;
        xAxis
            .orient('bottom')
            .tickPadding(10)
        ;
        yAxis
            .orient('left')
            .tickPadding(10)
        ;
        distX
            .axis('x')
        ;
        distY
            .axis('y')
        ;

        //============================================================


        //============================================================
        // Private Variables
        //------------------------------------------------------------

        var x0, y0;

        var showTooltip = function(e, offsetElement) {
            //TODO: make tooltip style an option between single or dual on axes (maybe on all charts with axes?)

            var left = e.pos[0] + ( offsetElement.offsetLeft || 0 ),
                top = e.pos[1] + ( offsetElement.offsetTop || 0),
                leftX = e.pos[0] + ( offsetElement.offsetLeft || 0 ),
                topX = y.range()[0] + margin.top + ( offsetElement.offsetTop || 0),
                leftY = x.range()[0] + margin.left + ( offsetElement.offsetLeft || 0 ),
                topY = e.pos[1] + ( offsetElement.offsetTop || 0),
                xVal = xAxis.tickFormat()(scatter.x()(e.point, e.pointIndex)),
                yVal = yAxis.tickFormat()(scatter.y()(e.point, e.pointIndex));

            if( tooltipX != null )
                nv.tooltip.show([leftX, topX], tooltipX(e.series.key, xVal, yVal, e, chart), 'n', 1, offsetElement, 'x-nvtooltip');
            if( tooltipY != null )
                nv.tooltip.show([leftY, topY], tooltipY(e.series.key, xVal, yVal, e, chart), 'e', 1, offsetElement, 'y-nvtooltip');
            if( tooltip != null )
                nv.tooltip.show([left, top], tooltip(e.series.key, xVal, yVal, e, chart), e.value < 0 ? 'n' : 's', null, offsetElement);
        };

        var controlsData = [
            { key: 'Magnify', disabled: true }
        ];

        //============================================================


        function chart(selection) {
            selection.each(function(data) {
                var container = d3.select(this),
                    that = this;

                var availableWidth = (width  || parseInt(container.style('width')) || 960)
                        - margin.left - margin.right,
                    availableHeight = (height || parseInt(container.style('height')) || 400)
                        - margin.top - margin.bottom;

                chart.update = function() { chart(selection) };
                chart.container = this;


                //------------------------------------------------------------
                // Display noData message if there's nothing to show.

                if (!data || !data.length || !data.filter(function(d) { return d.values.length }).length) {
                    var noDataText = container.selectAll('.nv-noData').data([noData]);

                    noDataText.enter().append('text')
                        .attr('class', 'nvd3 nv-noData')
                        .attr('dy', '-.7em')
                        .style('text-anchor', 'middle');

                    noDataText
                        .attr('x', margin.left + availableWidth / 2)
                        .attr('y', margin.top + availableHeight / 2)
                        .text(function(d) { return d });

                    return chart;
                } else {
                    container.selectAll('.nv-noData').remove();
                }

                //------------------------------------------------------------


                //------------------------------------------------------------
                // Setup Scales

                x0 = x0 || x;
                y0 = y0 || y;

                //------------------------------------------------------------


                //------------------------------------------------------------
                // Setup containers and skeleton of chart

                var wrap = container.selectAll('g.nv-wrap.nv-scatterChart').data([data]);
                var wrapEnter = wrap.enter().append('g').attr('class', 'nvd3 nv-wrap nv-scatterChart nv-chart-' + scatter.id());
                var gEnter = wrapEnter.append('g');
                var g = wrap.select('g')

                // background for pointer events
                gEnter.append('rect').attr('class', 'nvd3 nv-background')

                gEnter.append('g').attr('class', 'nv-x nv-axis');
                gEnter.append('g').attr('class', 'nv-y nv-axis');
                gEnter.append('g').attr('class', 'nv-scatterWrap');
                gEnter.append('g').attr('class', 'nv-distWrap');
                gEnter.append('g').attr('class', 'nv-legendWrap');
                gEnter.append('g').attr('class', 'nv-controlsWrap');

                //------------------------------------------------------------


                //------------------------------------------------------------
                // Legend

                if (showLegend) {
                    legend.width( availableWidth / 2 );

                    wrap.select('.nv-legendWrap')
                        .datum(data)
                        .call(legend);

                    if ( margin.top != legend.height()) {
                        margin.top = legend.height();
                        availableHeight = (height || parseInt(container.style('height')) || 400)
                            - margin.top - margin.bottom;
                    }

                    wrap.select('.nv-legendWrap')
                        .attr('transform', 'translate(' + (availableWidth / 2) + ',' + (-margin.top) +')');
                }

                //------------------------------------------------------------


                //------------------------------------------------------------
                // Controls

                if (showControls) {
                    controls.width(180).color(['#444']);
                    g.select('.nv-controlsWrap')
                        .datum(controlsData)
                        .attr('transform', 'translate(0,' + (-margin.top) +')')
                        .call(controls);
                }

                //------------------------------------------------------------


                wrap.attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');


                //------------------------------------------------------------
                // Main Chart Component(s)

                scatter
                    .width(availableWidth)
                    .height(availableHeight)
                    .color(data.map(function(d,i) {
                        return d.color || color(d, i);
                    }).filter(function(d,i) { return !data[i].disabled }))

                wrap.select('.nv-scatterWrap')
                    .datum(data.filter(function(d) { return !d.disabled }))
                    .call(scatter);


                //Adjust for x and y padding
                if (xPadding) {
                    var xRange = x.domain()[1] - x.domain()[0];
                    x.domain([x.domain()[0] - (xPadding * xRange), x.domain()[1] + (xPadding * xRange)]);
                }

                if (yPadding) {
                    var yRange = y.domain()[1] - y.domain()[0];
                    y.domain([y.domain()[0] - (yPadding * yRange), y.domain()[1] + (yPadding * yRange)]);
                }

                //------------------------------------------------------------


                //------------------------------------------------------------
                // Setup Axes

                xAxis
                    .scale(x)
                    .ticks( xAxis.ticks() && xAxis.ticks().length ? xAxis.ticks() : availableWidth / 100 )
                    .tickSize( -availableHeight , 0);

                g.select('.nv-x.nv-axis')
                    .attr('transform', 'translate(0,' + y.range()[0] + ')')
                    .call(xAxis);


                yAxis
                    .scale(y)
                    .ticks( yAxis.ticks() && yAxis.ticks().length ? yAxis.ticks() : availableHeight / 36 )
                    .tickSize( -availableWidth, 0);

                g.select('.nv-y.nv-axis')
                    .call(yAxis);


                if (showDistX) {
                    distX
                        .getData(scatter.x())
                        .scale(x)
                        .width(availableWidth)
                        .color(data.map(function(d,i) {
                            return d.color || color(d, i);
                        }).filter(function(d,i) { return !data[i].disabled }));
                    gEnter.select('.nv-distWrap').append('g')
                        .attr('class', 'nv-distributionX');
                    g.select('.nv-distributionX')
                        .attr('transform', 'translate(0,' + y.range()[0] + ')')
                        .datum(data.filter(function(d) { return !d.disabled }))
                        .call(distX);
                }

                if (showDistY) {
                    distY
                        .getData(scatter.y())
                        .scale(y)
                        .width(availableHeight)
                        .color(data.map(function(d,i) {
                            return d.color || color(d, i);
                        }).filter(function(d,i) { return !data[i].disabled }));
                    gEnter.select('.nv-distWrap').append('g')
                        .attr('class', 'nv-distributionY');
                    g.select('.nv-distributionY')
                        .attr('transform', 'translate(-' + distY.size() + ',0)')
                        .datum(data.filter(function(d) { return !d.disabled }))
                        .call(distY);
                }

                //------------------------------------------------------------




                if (d3.fisheye) {
                    g.select('.nv-background')
                        .attr('width', availableWidth)
                        .attr('height', availableHeight);

                    g.select('.nv-background').on('mousemove', updateFisheye);
                    g.select('.nv-background').on('click', function() { pauseFisheye = !pauseFisheye;});
                    scatter.dispatch.on('elementClick.freezeFisheye', function() {
                        pauseFisheye = !pauseFisheye;
                    });
                }


                function updateFisheye() {
                    if (pauseFisheye) {
                        g.select('.nv-point-paths').style('pointer-events', 'all');
                        return false;
                    }

                    g.select('.nv-point-paths').style('pointer-events', 'none' );

                    var mouse = d3.mouse(this);
                    x.distortion(fisheye).focus(mouse[0]);
                    y.distortion(fisheye).focus(mouse[1]);

                    g.select('.nv-scatterWrap')
                        .call(scatter);

                    g.select('.nv-x.nv-axis').call(xAxis);
                    g.select('.nv-y.nv-axis').call(yAxis);
                    g.select('.nv-distributionX')
                        .datum(data.filter(function(d) { return !d.disabled }))
                        .call(distX);
                    g.select('.nv-distributionY')
                        .datum(data.filter(function(d) { return !d.disabled }))
                        .call(distY);
                }



                //============================================================
                // Event Handling/Dispatching (in chart's scope)
                //------------------------------------------------------------

                controls.dispatch.on('legendClick', function(d,i) {
                    d.disabled = !d.disabled;

                    fisheye = d.disabled ? 0 : 2.5;
                    g.select('.nv-background') .style('pointer-events', d.disabled ? 'none' : 'all');
                    g.select('.nv-point-paths').style('pointer-events', d.disabled ? 'all' : 'none' );

                    if (d.disabled) {
                        x.distortion(fisheye).focus(0);
                        y.distortion(fisheye).focus(0);

                        g.select('.nv-scatterWrap').call(scatter);
                        g.select('.nv-x.nv-axis').call(xAxis);
                        g.select('.nv-y.nv-axis').call(yAxis);
                    } else {
                        pauseFisheye = false;
                    }

                    chart(selection);
                });

                legend.dispatch.on('legendClick', function(d,i, that) {
                    d.disabled = !d.disabled;

                    if (!data.filter(function(d) { return !d.disabled }).length) {
                        data.map(function(d) {
                            d.disabled = false;
                            wrap.selectAll('.nv-series').classed('disabled', false);
                            return d;
                        });
                    }

                    chart(selection);
                });

                scatter.dispatch.on('elementMouseover.tooltip', function(e) {
                    d3.select('.nv-chart-' + scatter.id() + ' .nv-series-' + e.seriesIndex + ' .nv-distx-' + e.pointIndex)
                        .attr('y1', e.pos[1] - availableHeight);
                    d3.select('.nv-chart-' + scatter.id() + ' .nv-series-' + e.seriesIndex + ' .nv-disty-' + e.pointIndex)
                        .attr('x2', e.pos[0] + distX.size());

                    e.pos = [e.pos[0] + margin.left, e.pos[1] + margin.top];
                    dispatch.tooltipShow(e);
                });

                dispatch.on('tooltipShow', function(e) {
                    if (tooltips) showTooltip(e, that.parentNode);
                });

                //============================================================


                //store old scales for use in transitions on update
                x0 = x.copy();
                y0 = y.copy();


            });

            return chart;
        }


        //============================================================
        // Event Handling/Dispatching (out of chart's scope)
        //------------------------------------------------------------

        scatter.dispatch.on('elementMouseout.tooltip', function(e) {
            dispatch.tooltipHide(e);

            d3.select('.nv-chart-' + scatter.id() + ' .nv-series-' + e.seriesIndex + ' .nv-distx-' + e.pointIndex)
                .attr('y1', 0);
            d3.select('.nv-chart-' + scatter.id() + ' .nv-series-' + e.seriesIndex + ' .nv-disty-' + e.pointIndex)
                .attr('x2', distY.size());
        });
        dispatch.on('tooltipHide', function() {
            if (tooltips) nv.tooltip.cleanup();
        });

        //============================================================


        //============================================================
        // Expose Public Variables
        //------------------------------------------------------------

        // expose chart's sub-components
        chart.dispatch = dispatch;
        chart.scatter = scatter;
        chart.legend = legend;
        chart.controls = controls;
        chart.xAxis = xAxis;
        chart.yAxis = yAxis;
        chart.distX = distX;
        chart.distY = distY;

        d3.rebind(chart, scatter, 'id', 'interactive', 'pointActive', 'x', 'y', 'shape', 'size', 'xScale', 'yScale', 'zScale', 'xDomain', 'yDomain', 'sizeDomain', 'sizeRange', 'forceX', 'forceY', 'forceSize', 'clipVoronoi', 'clipRadius', 'useVoronoi');

        chart.margin = function(_) {
            if (!arguments.length) return margin;
            margin.top    = typeof _.top    != 'undefined' ? _.top    : margin.top;
            margin.right  = typeof _.right  != 'undefined' ? _.right  : margin.right;
            margin.bottom = typeof _.bottom != 'undefined' ? _.bottom : margin.bottom;
            margin.left   = typeof _.left   != 'undefined' ? _.left   : margin.left;
            return chart;
        };

        chart.width = function(_) {
            if (!arguments.length) return width;
            width = _;
            return chart;
        };

        chart.height = function(_) {
            if (!arguments.length) return height;
            height = _;
            return chart;
        };

        chart.color = function(_) {
            if (!arguments.length) return color;
            color = nv.utils.getColor(_);
            legend.color(color);
            distX.color(color);
            distY.color(color);
            return chart;
        };

        chart.showDistX = function(_) {
            if (!arguments.length) return showDistX;
            showDistX = _;
            return chart;
        };

        chart.showDistY = function(_) {
            if (!arguments.length) return showDistY;
            showDistY = _;
            return chart;
        };

        chart.showControls = function(_) {
            if (!arguments.length) return showControls;
            showControls = _;
            return chart;
        };

        chart.showLegend = function(_) {
            if (!arguments.length) return showLegend;
            showLegend = _;
            return chart;
        };

        chart.fisheye = function(_) {
            if (!arguments.length) return fisheye;
            fisheye = _;
            return chart;
        };

        chart.xPadding = function(_) {
            if (!arguments.length) return xPadding;
            xPadding = _;
            return chart;
        };

        chart.yPadding = function(_) {
            if (!arguments.length) return yPadding;
            yPadding = _;
            return chart;
        };

        chart.tooltips = function(_) {
            if (!arguments.length) return tooltips;
            tooltips = _;
            return chart;
        };

        chart.tooltipContent = function(_) {
            if (!arguments.length) return tooltip;
            tooltip = _;
            return chart;
        };

        chart.tooltipXContent = function(_) {
            if (!arguments.length) return tooltipX;
            tooltipX = _;
            return chart;
        };

        chart.tooltipYContent = function(_) {
            if (!arguments.length) return tooltipY;
            tooltipY = _;
            return chart;
        };

        chart.noData = function(_) {
            if (!arguments.length) return noData;
            noData = _;
            return chart;
        };

        //============================================================


        return chart;
    }

})();