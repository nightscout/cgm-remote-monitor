function insulinDosed(opts) {

    var start = opts.start.getTime();
    var end = opts.end.getTime();
    var treatments = opts.treatments;
    var profile_data = opts.profile;
    var insulinDosed = 0;
    if (!treatments) {
        console.error("No treatments to process.");
        return {};
    }

    treatments.forEach(function(treatment) {
        //console.error(treatment);
        if(treatment.insulin && treatment.date > start && treatment.date <= end) {
            insulinDosed += treatment.insulin;
        }
    });
    //console.error(insulinDosed);

    var rval = {
        insulin: Math.round( insulinDosed * 1000 ) / 1000
    };

    return rval;
}

exports = module.exports = insulinDosed;
