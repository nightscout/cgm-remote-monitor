function Dropdown(el) {
    this.ddmenuitem = 0;

    var $el = $(el), that = this;
    $el.find('>li').bind('mouseover', function(e) { that.open(e); });
    $el.find('>li').bind('mouseout', function() { that.close(); });

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
    this.ddmenuitem = $(e.currentTarget).find('ul').eq(0).css('visibility', 'visible');
};


