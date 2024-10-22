$(document).foundation()
	$('#myModal').foundation('open');

	
/**
 * Created by radical on 2016-04-17.
 */
var WebApp = (function () {
    function WebApp(gridElement) {
        var _this = this;
        this.gridElement = gridElement;
        // Config
        this.expandedItem = null;
        this.menuOpen = false;
        this.setBindings = function () {
            $(window).resize(_this.resizeGrid);
            // Menu binding
            $('.static-menu-trigger').on('click', _this.handleMenu);
        };
        this.handleMenu = function (e) {
            _this.menuOpen = !_this.menuOpen;
            if (_this.menuOpen) {
                $('.header-menu-items.mobile').addClass('open');
            }
            else {
                $('.header-menu-items.mobile').removeClass('open');
            }
        };
        // this.setFilters = function () {
        //     $('.filters-desktop').on('click', '.button', _this.handleDesktopFilter);
        //     $('.filters-mobile').on('change', _this.handleMobileFilter);
        // };
        this.baseRatio = this.baseHeight / this.baseWidth;
        this.setBindings();
        this.setInteractions();
        this.initGrid();
        this.initPackery();
        this.setFilters();
    }
    return WebApp;
}());
//# sourceMappingURL=app.js.map
