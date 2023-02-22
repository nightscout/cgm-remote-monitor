// Moves backward one day
function loopalyzerBackward() {
    var moment = window.moment;
    var from = moment($("#rp_from").val()).subtract(1,'day');
    var to = moment($("#rp_to").val()).subtract(1,'day');
    $("#rp_from").val(from.format('YYYY-MM-DD'));
    $("#rp_to").val(to.format('YYYY-MM-DD'));
    $("#rp_show").click();
}

// Moves backward same amount as shown (e.g. whole week)
function loopalyzerMoreBackward() {
    var moment = window.moment;
    var from = moment($("#rp_from").val())
    var to = moment($("#rp_to").val())
    var diff = to.diff(from, 'days') + 1;
    from.subtract(diff, 'days');
    to.subtract(diff, 'days');
    $("#rp_from").val(from.format('YYYY-MM-DD'));
    $("#rp_to").val(to.format('YYYY-MM-DD'));
    $("#rp_show").click();
}

// Moves forward one day
function loopalyzerForward() {
    var moment = window.moment;
    var from = moment($("#rp_from").val()).add(1,'day');
    var to = moment($("#rp_to").val()).add(1,'day');
    if (to <= moment()) {
        $("#rp_from").val(from.format('YYYY-MM-DD'));
        $("#rp_to").val(to.format('YYYY-MM-DD'));
        $("#rp_show").click();
    }
}

// Moves forward same amount as shown (e.g. whole week)
function loopalyzerMoreForward() {
    var moment = window.moment;
    var from = moment($("#rp_from").val())
    var to = moment($("#rp_to").val())
    var diff = to.diff(from, 'days') + 1;
    from.add(diff, 'days');
    to.add(diff, 'days');
    if (to > moment()) {
        to = moment();
        from = moment();
        from.subtract(diff-1, 'days');
    }
    $("#rp_from").val(from.format('YYYY-MM-DD'));
    $("#rp_to").val(to.format('YYYY-MM-DD'));
    $("#rp_show").click();
}
