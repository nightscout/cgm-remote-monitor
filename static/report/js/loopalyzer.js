function loopalyzerBackward() {
    var moment = window.moment;
    var from = moment($("#rp_from").val()).subtract(1,'day');
    var to = moment($("#rp_to").val()).subtract(1,'day');
    $("#rp_from").val(from.format('YYYY-MM-DD'));
    $("#rp_to").val(to.format('YYYY-MM-DD'));
    $("#rp_show").click();
}

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
 