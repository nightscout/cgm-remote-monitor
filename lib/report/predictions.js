var predictions = {
    offset: 0,
    backward: function () {
        this.offset -= 5;
        this.updateOffsetHtml();
    },
    forward: function () {
        this.offset += 5;
        this.updateOffsetHtml();
    },
    moreBackward: function () {
        this.offset -= 30;
        this.updateOffsetHtml();
    },
    moreForward: function () {
        this.offset += 30;
        this.updateOffsetHtml();
    },
    reset: function () {
        this.offset = 0;
        this.updateOffsetHtml();
    },
    updateOffsetHtml: function () {
        $('#rp_predictedOffset').html(this.offset);
    }
};

$(document).on('change', '#rp_optionspredicted', function() {
    $('#rp_predictedSettings').toggle(this.checked);
    predictions.reset();
});

module.exports = predictions;
