function Dropdown(el) {
    this.ddmenuitem = 0;

    this.$el = $(el);
    var that = this;

    $(document).click(function() { that.close(); });
}

Dropdown.prototype.close = function () {
    if (this.ddmenuitem) {
        this.ddmenuitem.css('visibility', 'hidden');
        this.ddmenuitem = 0;
    }
};

Dropdown.prototype.open = function (e) {
    this.close();
    this.ddmenuitem = $(this.$el).css('visibility', 'visible');
    e.stopPropagation();
};


