function openDrawer()  {
    $("#container").animate({marginLeft: "-200px"}, 300);
    $("#drawer").css("display", "block");
    $("#drawer").animate({right: "0"}, 300);
}
function closeDrawer() {
    $("#container").animate({marginLeft: "0px"}, 300);
    $("#drawer").animate({right: "-200px"}, 300, function() {
        $("#drawer").css("display", "none");
    });
}
var drawerIsOpen = false;

$("#drawerToggle").click(function(event) {
    if(drawerIsOpen) {
        closeDrawer();
        drawerIsOpen = false;
    }  else {
        openDrawer();
        drawerIsOpen = true;
    }
    event.preventDefault();
});

$('.tip').tipsy();
$.fn.tipsy.defaults = {
    fade: true,
    gravity: "n",
    opacity: 0.75
}
