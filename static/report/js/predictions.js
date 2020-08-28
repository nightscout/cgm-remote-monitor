
var predictedOffset = 0;

function predictForward() {
    predictedOffset += 5;
    $("#rp_predictedOffset").html(predictedOffset);
    $("#rp_show").click();
}

function predictMoreForward() {
    predictedOffset += 30;
    $("#rp_predictedOffset").html(predictedOffset);
    $("#rp_show").click();
}

function predictBackward() {
    predictedOffset -= 5;
    $("#rp_predictedOffset").html(predictedOffset);
    $("#rp_show").click();
}

function predictMoreBackward() {
    predictedOffset -= 30;
    $("#rp_predictedOffset").html(predictedOffset);
    $("#rp_show").click();
}

function predictResetToZero() {
    predictedOffset = 0;
    $("#rp_predictedOffset").html(predictedOffset);
    $("#rp_show").click();
}

$(document).on('change', '#rp_optionspredicted', function() {
    if (this.checked)
        $("#rp_predictedSettings").show();
    else
        $("#rp_predictedSettings").hide();
    predictResetToZero();
});
