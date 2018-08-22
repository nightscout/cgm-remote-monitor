var _ = require('lodash');
var timeRef = new Date();

// from: https://stackoverflow.com/a/14873282
function erf(x) {
    // save the sign of x
    var sign = (x >= 0) ? 1 : -1;
    x = Math.abs(x);

    // constants
    var a1 = 0.254829592;
    var a2 = -0.284496736;
    var a3 = 1.421413741;
    var a4 = -1.453152027;
    var a5 = 1.061405429;
    var p = 0.3275911;

    // A&S formula 7.1.26
    var t = 1.0 / (1.0 + p * x);
    var y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y; // erf(-x) = -erf(x);
}

// This is the old bilinear IOB curve model

function iobCalcBiLinear(treatment, time, dia) {
    var diaratio = 3.0 / dia;
    var peak = 75;
    var end = 180;
    if (typeof time === 'undefined') {
        time = new Date();
    }

    var results = {};

    if (treatment.insulin) {
        var bolusTime = new Date(treatment.date);
        var minAgo = diaratio * (time - bolusTime) / 1000 / 60;
        var iobContrib = 0;
        var activityContrib = 0;

        if (minAgo < peak) {
            var x = (minAgo / 5 + 1);
            iobContrib = treatment.insulin * (1 - 0.001852 * x * x + 0.001852 * x);
            activityContrib = treatment.insulin * (2 / dia / 60 / peak) * minAgo;
        } else if (minAgo < end) {
            var y = (minAgo - peak) / 5;
            iobContrib = treatment.insulin * (0.001323 * y * y - .054233 * y + .55556);
            activityContrib = treatment.insulin * (2 / dia / 60 - (minAgo - peak) * 2 / dia / 60 / (60 * 3 - peak));
        }

        results = {
            iobContrib: iobContrib,
            activityContrib: activityContrib
        };
    }

    return results;
}


function iobCalc(treatment, time, dia, profile) {

    if (!treatment.insulin) return {};

    var curve = 'bilinear';

    if (profile.curve !== undefined) {
        curve = profile.curve.toLowerCase();
    }

    var curveDefaults = {
        'bilinear': {
            requireLongDia: false
        },
        'rapid-acting': {
            requireLongDia: true,
            peak: 75,
            tdMin: 300
        },
        'ultra-rapid': {
            requireLongDia: true,
            peak: 55,
            tdMin: 300
        },
    };

    if (!(curve in curveDefaults)) {
        console.error('Unsupported curve function: "' + curve + '". Supported curves: "bilinear", "rapid-acting" (Novolog, Novorapid, Humalog, Apidra) and "ultra-rapid" (Fiasp). Defaulting to "rapid-acting".');
        curve = 'bilinear';
    }

    if (curve == 'bilinear') {
        return iobCalcBiLinear(treatment, time, dia);
    }

    var defaults = curveDefaults[curve];

    var usePeakTime = false;

    var td = dia * 60;

    if (defaults.requireLongDia && dia < 5) {
        //console.error('Pump DIA must be set to 5 hours or more with the new curves, please adjust your pump. Defaulting to 5 hour DIA.');
        td = 300;
    }

    var tp = defaults.peak;

    if (profile.useCustomPeakTime && profile.insulinPeakTime !== undefined) {
        if (profile.insulinPeakTime < 35 || profile.insulinPeakTime > 120) {
            console.error('Insulin Peak Time is only supported for values between 35 to 120 minutes');

        } else {
            tp = profile.insulinPeakTime;
        }
    }

    if (typeof time === 'undefined') {
        time = timeRef;
    }

    var bolusTime = new Date(treatment.date);
    var t = Math.round((time - bolusTime) / 1000 / 60);

    var activityContrib = 0;
    var iobContrib = 0;
    var biobContrib = 0;

    // force the IOB to 0 if over 5 hours have passed
    if (t < td) {

        var tau = tp * (1 - tp / td) / (1 - 2 * tp / td);
        var a = 2 * tau / td;
        var S = 1 / (1 - a + (1 + a) * Math.exp(-td / tau));

        activityContrib = treatment.insulin * (S / Math.pow(tau, 2)) * t * (1 - t / td) * Math.exp(-t / tau);
        iobContrib = treatment.insulin * (1 - S * (1 - a) * ((Math.pow(t, 2) / (tau * td * (1 - a)) - t / tau - 1) * Math.exp(-t / tau) + 1));
        // calculate bolus snooze insulin in the same pass
        //t = t * profile.bolussnooze_dia_divisor;
        //biobContrib = treatment.insulin * (1 - S * (1 - a) * ((Math.pow(t, 2) / (tau * td * (1 - a)) - t / tau - 1) * Math.exp(-t / tau) + 1));

        //console.error('DIA: ' + dia + ' t: ' + t + ' td: ' + td + ' tp: ' + tp + ' tau: ' + tau + ' a: ' + a + ' S: ' + S + ' activityContrib: ' + activityContrib + ' iobContrib: ' + iobContrib);

    }

    results = {
        iobContrib: iobContrib,
        activityContrib: activityContrib,
        //biobContrib: biobContrib
    };

    return results;
}

exports = module.exports = iobCalc;
