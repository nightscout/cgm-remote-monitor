
function iobCalc(treatment, time, dia) {
    var diaratio = 3.0 / dia;
    var peak = 75 ;
    var end = 180 ;
    //var sens = profile_data.sens;
    if (typeof time === 'undefined') {
        time = new Date();
    }

    var results = {};

    if (treatment.insulin) {
        var bolusTime = new Date(treatment.date);
        var minAgo = diaratio * (time-bolusTime) / 1000 / 60;
        var iobContrib = 0;
        var activityContrib = 0;

        if (minAgo < peak) {
            var x = (minAgo/5 + 1);
            iobContrib = treatment.insulin * (1 - 0.001852 * x * x + 0.001852 * x);
            //activityContrib=sens*treatment.insulin*(2/dia/60/peak)*minAgo;
            activityContrib = treatment.insulin * (2 / dia / 60 / peak) * minAgo;
        } else if (minAgo < end) {
            var y = (minAgo-peak)/5;
            iobContrib = treatment.insulin * (0.001323 * y * y - .054233 * y + .55556);
            //activityContrib=sens*treatment.insulin*(2/dia/60-(minAgo-peak)*2/dia/60/(60*dia-peak));
            activityContrib = treatment.insulin * (2 / dia / 60 - (minAgo - peak) * 2 / dia / 60 / (60 * 3 - peak));
        }

        results = {
            iobContrib: iobContrib,
            activityContrib: activityContrib
        };
    }

    return results;
}

exports = module.exports = iobCalc;
