'use strict';

function iobTotal(treatments, profile, time) {

    console.info(">>>>treatments:", treatments);
    console.info(">>>>profile:", profile);
    console.info(">>>>time:", time);

    var iob= 0;
    var activity = 0;
    if (!treatments) return {};
    if (typeof time === 'undefined') {
        time = new Date();
    }

    treatments.forEach(function(treatment) {
        if(new Date(treatment.created_at) < time) {
            var tIOB = iobCalc(treatment, profile, time);
            if (tIOB && tIOB.iobContrib) iob += tIOB.iobContrib;
            if (tIOB && tIOB.activityContrib) activity += tIOB.activityContrib;
        }
    });
    return {
        iob: iob,
        display: Math.round(iob * 10) / 10,
        activity: activity
    };
}

function iobCalc(treatment, profile, time) {

    var dia=profile.dia;
    var scaleFactor = 3.0/dia;
    var peak = 75;
    var sens=profile.sens;
    var iobContrib, activityContrib;
    var t = time;
    if (typeof t === 'undefined') {
        t = new Date();
    }


    if (treatment.insulin) {
        var bolusTime=new Date(treatment.created_at);
        var minAgo=scaleFactor*(t-bolusTime)/1000/60;

        if (minAgo < 0) {
            iobContrib=0;
            activityContrib=0;
        }
        if (minAgo < peak) {
            var x = minAgo/5+1;
            iobContrib=treatment.insulin*(1-0.001852*x*x+0.001852*x);
            activityContrib=sens*treatment.insulin*(2/dia/60/peak)*minAgo;

        }
        else if (minAgo < 180) {
            var x = (minAgo-75)/5;
            iobContrib=treatment.insulin*(0.001323*x*x - .054233*x + .55556);
            activityContrib=sens*treatment.insulin*(2/dia/60-(minAgo-peak)*2/dia/60/(60*dia-peak));
        }
        else {
            iobContrib=0;
            activityContrib=0;
        }
        return {
            iobContrib: iobContrib,
            activityContrib: activityContrib
        };
    } else {
        return '';
    }
}

function IOB(opts) {

    var IOB = {
        calcTotal: iobTotal
    };

    return IOB;

}

module.exports = IOB;