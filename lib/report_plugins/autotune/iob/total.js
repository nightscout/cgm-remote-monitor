function iobTotal(opts, time) {

    var now = time.getTime();
    var iobCalc = opts.calculate;
    var treatments = opts.treatments;
    var profile_data = opts.profile;
    var iob = 0;
    var basaliob = 0;
    var bolusiob = 0;
    var netbasalinsulin = 0;
    var bolusinsulin = 0;
    //var bolussnooze = 0;
    var activity = 0;
    if (!treatments) return {};
    //if (typeof time === 'undefined') {
        //var time = new Date();
    //}

    treatments.forEach(function(treatment) {
        if( treatment.date <= now ) {
            var dia = profile_data.dia;
            // force minimum DIA of 3h
            if (dia < 3) {
                console.error("Warning; adjusting DIA from",dia,"to minimum of 3 hours");
                dia = 3;
            }
            var dia_ago = now - profile_data.dia*60*60*1000;
            if( treatment.date > dia_ago ) {
                // tIOB = total IOB
                var tIOB = iobCalc(treatment, time, dia, profile_data);
                if (tIOB && tIOB.iobContrib) { iob += tIOB.iobContrib; }
                if (tIOB && tIOB.activityContrib) { activity += tIOB.activityContrib; }
                // basals look like either of these:
                // {"insulin":-0.05,"date":1507265512363.6365,"created_at":"2017-10-06T04:51:52.363Z"}
                // {"insulin":0.05,"date":1507266530000,"created_at":"2017-10-06T05:08:50.000Z"}
                // boluses look like:
                // {"timestamp":"2017-10-05T22:06:31-07:00","started_at":"2017-10-06T05:06:31.000Z","date":1507266391000,"insulin":0.5}
                if (treatment.insulin && tIOB && tIOB.iobContrib) {
                    if (treatment.insulin < 0.1) {
                        basaliob += tIOB.iobContrib;
                        netbasalinsulin += treatment.insulin;
                    } else {
                        bolusiob += tIOB.iobContrib;
                        bolusinsulin += treatment.insulin;
                    }
                }
                //console.error(JSON.stringify(treatment));
            }
        } // else { console.error("ignoring future treatment:",treatment); }
    });

    var rval = {
        iob: Math.round(iob * 1000) / 1000,
        activity: Math.round(activity * 10000) / 10000,
        basaliob: Math.round(basaliob * 1000) / 1000,
        bolusiob: Math.round(bolusiob * 1000) / 1000,
        netbasalinsulin: Math.round(netbasalinsulin * 1000) / 1000,
        bolusinsulin: Math.round(bolusinsulin * 1000) / 1000,
        time: time
    };

    return rval;
}

exports = module.exports = iobTotal;
