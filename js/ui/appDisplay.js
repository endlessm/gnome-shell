// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const { Clutter, Gio, GLib, GObject, Meta, Shell, St } = imports.gi;
const Signals = imports.signals;
const Mainloop = imports.mainloop;

const AppActivation = imports.ui.appActivation;
const AppFavorites = imports.ui.appFavorites;
const BackgroundMenu = imports.ui.backgroundMenu;
const BoxPointer = imports.ui.boxpointer;
const DND = imports.ui.dnd;
const GrabHelper = imports.ui.grabHelper;
const EditableLabelMode = imports.ui.editableLabel.EditableLabelMode;
const IconGrid = imports.ui.iconGrid;
const IconGridLayout = imports.ui.iconGridLayout;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const PageIndicators = imports.ui.pageIndicators;
const PopupMenu = imports.ui.popupMenu;
const Tweener = imports.ui.tweener;
const ViewSelector = imports.ui.viewSelector;
const Search = imports.ui.search;
const Params = imports.misc.params;
const Util = imports.misc.util;
const SystemActions = imports.misc.systemActions;

const { loadInterfaceXML } = imports.misc.fileUtils;

var MAX_APPLICATION_WORK_MILLIS = 75;
var MENU_POPUP_TIMEOUT = 600;
var MAX_COLUMNS = 7;
var MIN_COLUMNS = 4;
var MIN_ROWS = 1;

var INACTIVE_GRID_OPACITY = 77;
// This time needs to be less than IconGrid.EXTRA_SPACE_ANIMATION_TIME
// to not clash with other animations
var INACTIVE_GRID_OPACITY_ANIMATION_TIME = 0.24;
var FOLDER_SUBICON_FRACTION = .4;

var MIN_FREQUENT_APPS_COUNT = 3;

var INDICATORS_BASE_TIME = 0.25;
var INDICATORS_ANIMATION_DELAY = 0.125;
var INDICATORS_ANIMATION_MAX_TIME = 0.75;

var VIEWS_SWITCH_TIME = 0.4;
var VIEWS_SWITCH_ANIMATION_DELAY = 0.1;

// Follow iconGrid animations approach and divide by 2 to animate out to
// not annoy the user when the user wants to quit appDisplay.
// Also, make sure we don't exceed iconGrid animation total time or
// views switch time.
var INDICATORS_BASE_TIME_OUT = 0.125;
var INDICATORS_ANIMATION_DELAY_OUT = 0.0625;
var INDICATORS_ANIMATION_MAX_TIME_OUT =
    Math.min (VIEWS_SWITCH_TIME,
              IconGrid.ANIMATION_TIME_OUT + IconGrid.ANIMATION_MAX_DELAY_OUT_FOR_ITEM);

var PAGE_SWITCH_TIME = 0.3;

const SWITCHEROO_BUS_NAME = 'net.hadess.SwitcherooControl';
const SWITCHEROO_OBJECT_PATH = '/net/hadess/SwitcherooControl';

const SwitcherooProxyInterface = loadInterfaceXML('net.hadess.SwitcherooControl');
const SwitcherooProxy = Gio.DBusProxy.makeProxyWrapper(SwitcherooProxyInterface);
let discreteGpuAvailable = false;

// Endless-specific definitions below this point

const EOS_DESKTOP_MIN_ROWS = 2;

const EOS_LINK_PREFIX = 'eos-link-';

const EOS_ENABLE_APP_CENTER_KEY = 'enable-app-center';
const EOS_APP_CENTER_ID = 'org.gnome.Software.desktop';

var EOS_INACTIVE_GRID_OPACITY = 96;
var EOS_ACTIVE_GRID_OPACITY = 255;

var EOS_INACTIVE_GRID_TRANSITION = 'easeOutQuad';
var EOS_ACTIVE_GRID_TRANSITION = 'easeInQuad';

var EOS_INACTIVE_GRID_SATURATION = 1;
var EOS_ACTIVE_GRID_SATURATION = 0;

const EOS_DRAG_OVER_FOLDER_OPACITY = 128;

const EOS_REPLACED_BY_KEY = 'X-Endless-Replaced-By';

function _getCategories(info) {
    let categoriesStr = info.get_categories();
    if (!categoriesStr)
        return [];
    return categoriesStr.split(';');
}

function _listsIntersect(a, b) {
    for (let itemA of a)
        if (b.indexOf(itemA) >= 0)
            return true;
    return false;
}

function _getFolderName(folder) {
    let name = folder.get_string('name');

    if (folder.get_boolean('translate')) {
        let keyfile = new GLib.KeyFile();
        let path = 'desktop-directories/' + name;

        try {
            keyfile.load_from_data_dirs(path, GLib.KeyFileFlags.NONE);
            name = keyfile.get_locale_string('Desktop Entry', 'Name', null);
        } catch(e) {
            return name;
        }
    }

    return name;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

class BaseAppView {
    constructor(params, gridParams) {
        if (new.target === BaseAppView)
            throw new TypeError('Cannot instantiate abstract class ' + new.target.name);

        gridParams = Params.parse(gridParams, { xAlign: St.Align.MIDDLE,
                                                columnLimit: MAX_COLUMNS,
                                                minRows: MIN_ROWS,
                                                minColumns: MIN_COLUMNS,
                                                fillParent: false,
                                                padWithSpacing: true });
        params = Params.parse(params, { usePagination: false });

        if(params.usePagination)
            this._grid = new IconGrid.PaginatedIconGrid(gridParams);
        else
            this._grid = new IconGrid.IconGrid(gridParams);

        this._grid.connect('child-focused', (grid, actor) => {
            this._childFocused(actor);
        });
        // Standard hack for ClutterBinLayout
        this._grid.x_expand = true;

        this._items = {};
        this._allItems = [];
    }

    _childFocused(actor) {
        // Nothing by default
    }

    removeAll() {
        this._grid.destroyAll();
        this._items = {};
        this._allItems = [];
    }

    _redisplay() {
        this.removeAll();
        this._loadApps();
    }

    getAllItems() {
        return this._allItems;
    }

    addItem(icon) {
        let id = icon.id;
        if (this._items[id] !== undefined)
            return;

        this._allItems.push(icon);
        this._items[id] = icon;
    }

    _compareItems(a, b) {
        return a.name.localeCompare(b.name);
    }

    loadGrid() {
        this._allItems.forEach(item => { this._grid.addItem(item); });
        this.emit('view-loaded');
    }

    indexOf(icon) {
        return this._grid.indexOf(icon.actor);
    }

    getIconForIndex(index) {
        if (index < 0 || index >= this._allItems.length)
            return null;

        return this._allItems[index];
    }

    nudgeItemsAtIndex(index, location) {
        this._grid.nudgeItemsAtIndex(index, location);
    }

    removeNudgeTransforms() {
        this._grid.removeNudgeTransforms();
    }

    canDropAt(x, y, canDropPastEnd) {
        return this._grid.canDropAt(x, y, canDropPastEnd);
    }

    _selectAppInternal(id) {
        if (this._items[id])
            this._items[id].actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
        else
            log('No such application ' + id);
    }

    selectApp(id) {
        this.selectAppWithLabelMode(id, null);
    }

    selectAppWithLabelMode(id, labelMode) {
        if (this._items[id] && this._items[id].actor.mapped) {
            this._selectAppInternal(id);
            if (labelMode !== null)
                this._items[id].icon.setLabelMode(labelMode);
        } else if (this._items[id]) {
            // Need to wait until the view is mapped
            let signalId = this._items[id].actor.connect('notify::mapped',
                actor => {
                    if (actor.mapped) {
                        actor.disconnect(signalId);
                        this._selectAppInternal(id);
                        if (labelMode !== null)
                            this._items[id].icon.setLabelMode(labelMode);
                    }
                });
        } else {
            // Need to wait until the view is built
            let signalId = this.connect('view-loaded', () => {
                this.disconnect(signalId);
                this.selectAppWithLabelMode(id, labelMode);
            });
        }
    }

    _doSpringAnimation(animationDirection) {
        this._grid.actor.opacity = 255;

        // We don't do the icon grid animations on Endless, but we still need
        // to call this method so that the animation-done signal gets emitted,
        // in order not to break the transitoins.
        this._grid.animateSpring(animationDirection, null);
    }

    animate(animationDirection, onComplete) {
        if (onComplete) {
            let animationDoneId = this._grid.connect('animation-done', () => {
                this._grid.disconnect(animationDoneId);
                onComplete();
            });
        }

        if (animationDirection == IconGrid.AnimationDirection.IN) {
            let id = this._grid.connect('paint', () => {
                this._grid.disconnect(id);
                this._doSpringAnimation(animationDirection);
            });
        } else {
            this._doSpringAnimation(animationDirection);
        }
    }

    animateSwitch(animationDirection) {
        Tweener.removeTweens(this.actor);
        Tweener.removeTweens(this._grid);

        let params = { time: VIEWS_SWITCH_TIME,
                       transition: 'easeOutQuad' };
        if (animationDirection == IconGrid.AnimationDirection.IN) {
            this.actor.show();
            params.opacity = 255;
            params.delay = VIEWS_SWITCH_ANIMATION_DELAY;
        } else {
            params.opacity = 0;
            params.delay = 0;
            params.onComplete = () => { this.actor.hide(); };
        }

        Tweener.addTween(this._grid, params);
    }

    get gridActor() {
        return this._grid;
    }
};
Signals.addSignalMethods(BaseAppView.prototype);

var AllViewContainer = GObject.registerClass(
class AllViewContainer extends St.Widget {
    _init(gridActor, params) {
        params = Params.parse(params, { allowScrolling: true });

        super._init({ layout_manager: new Clutter.BinLayout(),
                      x_expand: true,
                      y_expand: true });

        this.gridActor = gridActor;

        gridActor.y_expand = true;
        gridActor.y_align = Clutter.ActorAlign.START;

        this.scrollView = new St.ScrollView({ style_class: 'all-apps-scroller',
                                              x_expand: true,
                                              y_expand: true,
                                              x_fill: true,
                                              y_fill: false,
                                              reactive: params.allowScrolling,
                                              hscrollbar_policy: St.PolicyType.NEVER,
                                              vscrollbar_policy: St.PolicyType.EXTERNAL,
                                              y_align: Clutter.ActorAlign.START });

        this.stack = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        this.stackBox = new St.BoxLayout({ vertical: true });

        this.stack.add_child(gridActor);
        this.stackBox.add_child(this.stack);

        // For some reason I couldn't investigate yet using add_child()
        // here makes the icon grid not to show up on the desktop.
        this.scrollView.add_actor(this.stackBox);

        this.add_child(this.scrollView);
    }
});

var AllView = class AllView extends BaseAppView {
    constructor() {
        super({ usePagination: true },
              { minRows: EOS_DESKTOP_MIN_ROWS });
        this.actor = new AllViewContainer(this._grid.actor);
        this.actor._delegate = this;

        this._scrollView = this.actor.scrollView;
        this._stack = this.actor.stack;
        this._stackBox = this.actor.stackBox;

        this._adjustment = this._scrollView.vscroll.adjustment;

        this._pageIndicators = new PageIndicators.AnimatedPageIndicators();
        this._pageIndicators.connect('page-activated',
            (indicators, pageIndex) => {
                this.goToPage(pageIndex);
            });
        this._pageIndicators.connect('scroll-event', this._onScroll.bind(this));
        this.actor.add_actor(this._pageIndicators);

        this.folderIcons = [];

        this._grid.currentPage = 0;
        this._eventBlocker = new St.Widget({ x_expand: true, y_expand: true });
        this._stack.add_actor(this._eventBlocker);

        this._scrollView.connect('scroll-event', this._onScroll.bind(this));

        let panAction = new Clutter.PanAction({ interpolate: false });
        panAction.connect('pan', this._onPan.bind(this));
        panAction.connect('gesture-cancel', this._onPanEnd.bind(this));
        panAction.connect('gesture-end', this._onPanEnd.bind(this));
        this._panAction = panAction;
        this._panning = false;

        this._clickAction = new Clutter.ClickAction();
        this._clickAction.connect('clicked', () => {
            if (!this._currentPopup)
                return;

            let [x, y] = this._clickAction.get_coords();
            let actor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);
            if (!this._currentPopup.actor.contains(actor))
                this._currentPopup.popdown();
        });
        Main.overview.addAction(this._clickAction, false);
        this._eventBlocker.bind_property('reactive', this._clickAction, 'enabled', GObject.BindingFlags.SYNC_CREATE);

        this._bgAction = new Clutter.ClickAction();
        Main.overview.addAction(this._bgAction, true);
        BackgroundMenu.addBackgroundMenuForAction(this._bgAction, Main.layoutManager);
        this._clickAction.bind_property('enabled', this._bgAction, 'enabled',
                                        GObject.BindingFlags.SYNC_CREATE | GObject.BindingFlags.INVERT_BOOLEAN);
        this.actor.bind_property('mapped', this._bgAction, 'enabled',
                                 GObject.BindingFlags.SYNC_CREATE);

        this._appCenterIcon = null;

        this._displayingPopup = false;

        this._currentPopup = null;

        this._dragView = null;
        this._dragIcon = null;
        this._insertIdx = -1;
        this._onIconIdx = -1;
        this._lastCursorLocation = -1;

        this._availWidth = 0;
        this._availHeight = 0;

        Main.overview.connect('item-drag-begin', this._onDragBegin.bind(this));
        Main.overview.connect('item-drag-end', this._onDragEnd.bind(this));
        this._grid.connect('space-opened', () => {
            let fadeEffect = this._scrollView.get_effect('fade');
            if (fadeEffect)
                fadeEffect.enabled = false;

            this.emit('space-ready');
        });
        this._grid.connect('space-closed', () => {
            this._displayingPopup = false;
        });

        this.actor.connect('notify::mapped', () => {
            if (this.actor.mapped) {
                this._keyPressEventId =
                    global.stage.connect('key-press-event',
                                         this._onKeyPressEvent.bind(this));
            } else {
                if (this._keyPressEventId)
                    global.stage.disconnect(this._keyPressEventId);
                this._keyPressEventId = 0;
            }
        });

        this._redisplayWorkId = Main.initializeDeferredWork(this.actor, this._redisplay.bind(this));

        Shell.AppSystem.get_default().connect('installed-changed', () => {
            Main.queueDeferredWork(this._redisplayWorkId);
        });
        IconGridLayout.layout.connect('changed', () => {
            Main.queueDeferredWork(this._redisplayWorkId);
        });
        global.settings.connect('changed::' + EOS_ENABLE_APP_CENTER_KEY, () => {
            Main.queueDeferredWork(this._redisplayWorkId);
        });

        this._addedFolderId = null;
        IconGridLayout.layout.connect('folder-added', (iconGridLayout, id) => {
            // Go to last page; ideally the grid should know in
            // which page the change took place and show it automatically
            // which would avoid us having to navigate there directly
            this.goToPage(this._grid.nPages() - 1);

            // Save the folder ID so we know which one was added
            // and set it to edit mode
            this._addedFolderId = id;
        });

        this._loadApps();
    }

    removeAll() {
        this.folderIcons = [];
        this._appCenterIcon = null;
        super.removeAll();
    }

    _itemNameChanged(item) {
        // If an item's name changed, we can pluck it out of where it's
        // supposed to be and reinsert it where it's sorted.
        let oldIdx = this._allItems.indexOf(item);
        this._allItems.splice(oldIdx, 1);
        let newIdx = Util.insertSorted(this._allItems, item, this._compareItems);

        this._grid.removeItem(item);
        this._grid.addItem(item, newIdx);
    }

    getAppInfos() {
        return this._appInfoList;
    }

    _loadApps() {
        let desktopIds = IconGridLayout.layout.getIcons(IconGridLayout.DESKTOP_GRID_ID);

        let items = [];
        for (let idx in desktopIds) {
            let itemId = desktopIds[idx];
            items.push(itemId);
        }

        let appSys = Shell.AppSystem.get_default();

        items.forEach((itemId) => {
            let icon = null;

            if (IconGridLayout.layout.iconIsFolder(itemId)) {
                let item = Shell.DesktopDirInfo.new(itemId);
                icon = new FolderIcon(item, this);
                icon.connect('name-changed', this._itemNameChanged.bind(this));
                this.folderIcons.push(icon);
                if (this._addedFolderId == itemId) {
                    this.selectAppWithLabelMode(this._addedFolderId, EditableLabelMode.EDIT);
                    this._addedFolderId = null;
                }
            } else {
                let app = appSys.lookup_app(itemId);
                if (app)
                    icon = new AppIcon(app,
                                       { isDraggable: true,
                                         parentView: this },
                                       null);
            }

            // Some apps defined by the icon grid layout might not be installed
            if (icon)
                this.addItem(icon);
        });

        // Add the App Center icon if it is enabled (and installed)
        this._maybeAddAppCenterIcon();

        this.loadGrid();
    }

    _maybeAddAppCenterIcon() {
        if (this._appCenterIcon)
            return;

        if (!global.settings.get_boolean(EOS_ENABLE_APP_CENTER_KEY))
            return;

        let appSys = Shell.AppSystem.get_default();
        if (!appSys.lookup_app(EOS_APP_CENTER_ID)) {
            log('App center ' + EOS_APP_CENTER_ID + ' is not installed');
            return;
        }

        this._appCenterIcon = new AppCenterIcon(this);
        this.addItem(this._appCenterIcon);
    }

    // Overriden from BaseAppView
    animate(animationDirection, onComplete) {
        this._scrollView.reactive = false;
        let completionFunc = () => {
            this._scrollView.reactive = true;
            if (onComplete)
                onComplete();
        };

        if (animationDirection == IconGrid.AnimationDirection.OUT &&
            this._displayingPopup && this._currentPopup) {
            this._currentPopup.popdown();
            let spaceClosedId = this._grid.connect('space-closed', () => {
                this._grid.disconnect(spaceClosedId);
                super.animate(animationDirection, completionFunc);
            });
        } else {
            super.animate(animationDirection, completionFunc);
            if (animationDirection == IconGrid.AnimationDirection.OUT)
                this._pageIndicators.animateIndicators(animationDirection);
        }
    }

    animateSwitch(animationDirection) {
        super.animateSwitch(animationDirection);

        if (this._currentPopup && this._displayingPopup &&
            animationDirection == IconGrid.AnimationDirection.OUT)
            Tweener.addTween(this._currentPopup.actor,
                             { time: VIEWS_SWITCH_TIME,
                               transition: 'easeOutQuad',
                               opacity: 0,
                               onComplete() {
                                  this.opacity = 255;
                               } });

        if (animationDirection == IconGrid.AnimationDirection.OUT)
            this._pageIndicators.animateIndicators(animationDirection);
    }

    getCurrentPageY() {
        return this._grid.getPageY(this._grid.currentPage);
    }

    goToPage(pageNumber) {
        pageNumber = clamp(pageNumber, 0, this._grid.nPages() - 1);

        if (this._grid.currentPage == pageNumber && this._displayingPopup && this._currentPopup)
            return;
        if (this._displayingPopup && this._currentPopup)
            this._currentPopup.popdown();

        let velocity;
        if (!this._panning)
            velocity = 0;
        else
            velocity = Math.abs(this._panAction.get_velocity(0)[2]);
        // Tween the change between pages.
        // If velocity is not specified (i.e. scrolling with mouse wheel),
        // use the same speed regardless of original position
        // if velocity is specified, it's in pixels per milliseconds
        let diffToPage = this._diffToPage(pageNumber);
        let childBox = this._scrollView.get_allocation_box();
        let totalHeight = childBox.y2 - childBox.y1;
        let time;
        // Only take the velocity into account on page changes, otherwise
        // return smoothly to the current page using the default velocity
        if (this._grid.currentPage != pageNumber) {
            let minVelocity = totalHeight / (PAGE_SWITCH_TIME * 1000);
            velocity = Math.max(minVelocity, velocity);
            time = (diffToPage / velocity) / 1000;
        } else {
            time = PAGE_SWITCH_TIME * diffToPage / totalHeight;
        }
        // When changing more than one page, make sure to not take
        // longer than PAGE_SWITCH_TIME
        time = Math.min(time, PAGE_SWITCH_TIME);

        this._grid.currentPage = pageNumber;
        Tweener.addTween(this._adjustment,
                         { value: this._grid.getPageY(this._grid.currentPage),
                           time: time,
                           transition: 'easeOutQuad' });
        this._pageIndicators.setCurrentPage(pageNumber);
    }

    _diffToPage(pageNumber) {
        let currentScrollPosition = this._adjustment.value;
        return Math.abs(currentScrollPosition - this._grid.getPageY(pageNumber));
    }

    openSpaceForPopup(item, side, nRows) {
        this._updateIconOpacities(true);
        this._displayingPopup = true;
        this._grid.openExtraSpace(item, side, nRows);
    }

    _closeSpaceForPopup() {
        this._updateIconOpacities(false);

        let fadeEffect = this._scrollView.get_effect('fade');
        if (fadeEffect)
            fadeEffect.enabled = true;

        this._grid.closeExtraSpace();
    }

    _onScroll(actor, event) {
        if (this._displayingPopup || !this._scrollView.reactive)
            return Clutter.EVENT_STOP;

        let direction = event.get_scroll_direction();
        if (direction == Clutter.ScrollDirection.UP)
            this.goToPage(this._grid.currentPage - 1);
        else if (direction == Clutter.ScrollDirection.DOWN)
            this.goToPage(this._grid.currentPage + 1);

        return Clutter.EVENT_STOP;
    }

    _onPan(action) {
        if (this._displayingPopup)
            return false;
        this._panning = true;
        this._clickAction.release();
        let [dist, dx, dy] = action.get_motion_delta(0);
        let adjustment = this._adjustment;
        adjustment.value -= (dy / this._scrollView.height) * adjustment.page_size;
        return false;
    }

    _onPanEnd(action) {
         if (this._displayingPopup)
            return;

        let pageHeight = this._grid.getPageHeight();

        // Calculate the scroll value we'd be at, which is our current
        // scroll plus any velocity the user had when they released
        // their finger.

        let velocity = -action.get_velocity(0)[2];
        let endPanValue = this._adjustment.value + velocity;

        let closestPage = Math.round(endPanValue / pageHeight);
        this.goToPage(closestPage);

        this._panning = false;
    }

    _onKeyPressEvent(actor, event) {
        if (this._displayingPopup)
            return Clutter.EVENT_STOP;

        if (event.get_key_symbol() == Clutter.Page_Up) {
            this.goToPage(this._grid.currentPage - 1);
            return Clutter.EVENT_STOP;
        } else if (event.get_key_symbol() == Clutter.Page_Down) {
            this.goToPage(this._grid.currentPage + 1);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    getViewId() {
        return IconGridLayout.DESKTOP_GRID_ID;
    }

    _positionReallyMoved() {
        if (this._insertIdx == -1)
            return false;

        // If we're immediately right of the original position,
        // we didn't really move
        if ((this._insertIdx == this._originalIdx ||
             this._insertIdx == this._originalIdx + 1) &&
            this._dragView == this._dragIcon.parentView)
            return false;

        return true;
    }

    _resetNudgeState() {
        if (this._dragView)
            this._dragView.removeNudgeTransforms();
    }

    _resetDragViewState() {
        this._resetNudgeState();

        this._insertIdx = -1;
        this._onIconIdx = -1;
        this._lastCursorLocation = -1;
        this._dragView = null;
    }

    _setupDragState(source) {
        if (!source || !source.parentView)
            return;

        if (!source.handleViewDragBegin)
            return;

        this._dragIcon = source;
        this._originalIdx = source.parentView.indexOf(source);

        this._dragMonitor = {
            dragMotion: this._onDragMotion.bind(this)
        };
        DND.addDragMonitor(this._dragMonitor);

        this._resetDragViewState();

        source.handleViewDragBegin();
        if (this._appCenterIcon && (source.canDragOver(this._appCenterIcon)))
            this._appCenterIcon.handleViewDragBegin();
    }

    _clearDragState(source) {
        if (!source || !source.parentView)
            return;

        if (!source.handleViewDragEnd)
            return;

        this._dragIcon = null;
        this._originalIdx = -1;

        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }

        this._resetDragViewState();

        source.handleViewDragEnd();
        if (this._appCenterIcon && (source.canDragOver(this._appCenterIcon)))
            this._appCenterIcon.handleViewDragEnd();
    }

    _onDragBegin(overview, source) {
        // Save the currently dragged item info
        this._setupDragState(source);
    }

    _onDragEnd(overview, source) {
        this._clearDragState(source);
    }

    _onDragMotion(dragEvent) {
        // If the icon is dragged to the top or the bottom of the grid,
        // we want to scroll it, if possible
        if (this._handleDragOvershoot(dragEvent)) {
            this._resetDragViewState();
            return DND.DragMotionResult.CONTINUE;
        }

        // Handle motion over grid
        let dragView = null;

        if (this._dragIcon.parentView.actor.contains(dragEvent.targetActor))
            dragView = this._dragIcon.parentView;
        else if (this.actor.contains(dragEvent.targetActor))
            dragView = this;

        if (dragView != this._dragView) {
            if (this._dragView && this._onIconIdx > -1)
                this._setDragHoverState(false);

            this._resetDragViewState();
            this._dragView = dragView;
        }

        if (!this._dragView)
            return DND.DragMotionResult.CONTINUE;

        let draggingWithinFolder =
            this._currentPopup && (this._dragView == this._dragIcon.parentView);
        let canDropPastEnd = draggingWithinFolder || !this._appCenterIcon;

        // Ask grid can we drop here
        let [idx, cursorLocation] = this._dragView.canDropAt(dragEvent.x,
                                                             dragEvent.y,
                                                             canDropPastEnd);

        let onIcon = (cursorLocation == IconGrid.CursorLocation.ON_ICON);
        let isNewPosition = (!onIcon && idx != this._insertIdx) ||
            (cursorLocation != this._lastCursorLocation);

        // If we are not over our last hovered icon, remove its hover state
        if (this._onIconIdx != -1 &&
            ((idx != this._onIconIdx) || !onIcon)) {
            this._setDragHoverState(false);
            dragEvent.dragActor.opacity = EOS_ACTIVE_GRID_OPACITY;
        }

        // If we are in a new spot, remove the previous nudges
        if (isNewPosition)
            this._resetNudgeState();

        // Update our insert/hover index and the last cursor location
        this._lastCursorLocation = cursorLocation;
        if (onIcon) {
            this._onIconIdx = idx;
            this._insertIdx = -1;

            let hoverResult = this._getDragHoverResult();
            if (hoverResult == DND.DragMotionResult.MOVE_DROP) {
                // If we are hovering over a drop target, set its hover state
                this._setDragHoverState(true);
                dragEvent.dragActor.opacity = EOS_DRAG_OVER_FOLDER_OPACITY;
            }

            return hoverResult;
        }

        // Dropping in a space between icons
        this._onIconIdx = -1;
        this._insertIdx = idx;

        if (this._shouldNudgeItems(isNewPosition))
            this._dragView.nudgeItemsAtIndex(this._insertIdx, cursorLocation);

        // Propagate the signal in any case when moving icons
        return DND.DragMotionResult.CONTINUE;
    }

    _handleDragOvershoot(dragEvent) {
        let [ gridX, gridY ] = this.actor.get_transformed_position();
        let [ gridW, gridH ] = this.actor.get_transformed_size();
        let gridBottom = gridY + gridH;

        if (dragEvent.y > gridY && dragEvent.y < gridBottom) {
            // We're within the grid boundaries - cancel any existing
            // scrolling
            if (Tweener.isTweening(this._adjustment))
                Tweener.removeTweens(this._adjustment);

            return false;
        }

        if (dragEvent.y <= gridY &&
            this._adjustment.value > 0) {
            this.goToPage(this._grid.currentPage - 1);
            return true;
        }

        let maxAdjust = this._adjustment.upper - this._adjustment.page_size;
        if (dragEvent.y >= gridBottom &&
            this._adjustment.value < maxAdjust) {
            this.goToPage(this._grid.currentPage + 1);
            return true;
        }

        return false;
    }

    _shouldNudgeItems(isNewPosition) {
        return (isNewPosition && this._positionReallyMoved());
    }

    _setDragHoverState(state) {
        let viewIcon = this._dragView.getIconForIndex(this._onIconIdx);

        if (viewIcon && this._dragIcon.canDragOver(viewIcon))
            viewIcon.setDragHoverState(state);
    }

    _getDragHoverResult() {
        // If we are hovering over our own icon placeholder, ignore it
        if (this._onIconIdx == this._originalIdx &&
            this._dragView == this._dragIcon.parentView)
            return DND.DragMotionResult.NO_DROP;

        let validHoverDrop = false;
        let viewIcon = this._dragView.getIconForIndex(this._onIconIdx);

        // We can only move applications into folders or the app store
        if (viewIcon)
            validHoverDrop = viewIcon.canDrop && this._dragIcon.canDragOver(viewIcon);

        if (validHoverDrop)
            return DND.DragMotionResult.MOVE_DROP;

        return DND.DragMotionResult.CONTINUE;
    }

    acceptDrop(source, actor, x, y, time) {
        let position = [x, y];

        // This makes sure that if we dropped an icon outside of the grid,
        // we use the root grid as our target. This can only happen when
        // dragging an icon out of a folder
        if (this._dragView == null)
            this._dragView = this;

        let droppedOutsideOfFolder = this._currentPopup && (this._dragView != this._dragIcon.parentView);
        let dropIcon = this._dragView.getIconForIndex(this._onIconIdx);
        let droppedOnAppOutsideOfFolder = droppedOutsideOfFolder && dropIcon && !dropIcon.canDrop;

        if (this._onIconIdx != -1 && !droppedOnAppOutsideOfFolder) {
            // Find out what icon the drop is under
            if (!dropIcon || !dropIcon.canDrop)
                return false;

            if (!source.canDragOver(dropIcon))
                return false;

            let accepted  = dropIcon.handleIconDrop(source);
            if (!accepted)
                return false;

            if (this._currentPopup) {
                this._eventBlocker.reactive = false;
                this._currentPopup.popdown();
            }

            return true;
        }

        // If we are not dropped outside of a folder (allowed move) and we're
        // outside of the grid area, or didn't actually change position, ignore
        // the request to move
        if (!this._positionReallyMoved() && !droppedOutsideOfFolder)
            return false;

        // If we are not over an icon but within the grid, shift the
        // grid around to accomodate it
        let icon = this._dragView.getIconForIndex(this._insertIdx);
        let insertId = icon ? icon.getId() : null;
        let folderId = this._dragView.getViewId();

        // If we dropped the icon outside of the folder, close the popup and
        // add the icon to the main view
        if (droppedOutsideOfFolder) {
            source.blockHandler = true;
            this._eventBlocker.reactive = false;
            this._currentPopup.popdown();

            // Append the inserted app to the end of the grid
            let appSystem = Shell.AppSystem.get_default();
            let app  = appSystem.lookup_app(source.getId());
            let icon = new AppIcon(app,
                                   { isDraggable: true,
                                     parentView: this },
                                   null);
            this.addItem(icon);
        }

        IconGridLayout.layout.repositionIcon(source.getId(), insertId, folderId);
        return true;
    }

    addFolderPopup(popup) {
        this._stack.add_actor(popup.actor);
        popup.connect('open-state-changed', (popup, isOpen) => {
            this._eventBlocker.reactive = isOpen;
            this._currentPopup = isOpen ? popup : null;
            this._updateIconOpacities(isOpen);
            if(!isOpen)
                this._closeSpaceForPopup();
        });
    }

    _childFocused(icon) {
        let itemPage = this._grid.getItemPage(icon);
        this.goToPage(itemPage);
    }

    _updateIconOpacities(folderOpen) {
        for (let id in this._items) {
            let params, opacity;
            if (folderOpen && !this._items[id].actor.checked)
                opacity =  INACTIVE_GRID_OPACITY;
            else
                opacity = 255;
            params = { opacity: opacity,
                       time: INACTIVE_GRID_OPACITY_ANIMATION_TIME,
                       transition: 'easeOutQuad' };
            Tweener.addTween(this._items[id].actor, params);
        }
    }

    // Called before allocation to calculate dynamic spacing
    adaptToSize(width, height) {
        let box = new Clutter.ActorBox();
        box.x1 = 0;
        box.x2 = width;
        box.y1 = 0;
        box.y2 = height;
        box = this.actor.get_theme_node().get_content_box(box);
        box = this._scrollView.get_theme_node().get_content_box(box);
        box = this._stackBox.get_theme_node().get_content_box(box);
        box = this._stack.get_theme_node().get_content_box(box);
        box = this._grid.get_theme_node().get_content_box(box);
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        let oldNPages = this._grid.nPages();

        this._grid.adaptToSize(availWidth, availHeight);

        let fadeOffset = Math.min(this._grid.topPadding,
                                  this._grid.bottomPadding);
        this._scrollView.update_fade_effect(fadeOffset, 0);
        if (fadeOffset > 0)
            this._scrollView.get_effect('fade').fade_edges = true;

        if (this._availWidth != availWidth || this._availHeight != availHeight || oldNPages != this._grid.nPages()) {
            this._adjustment.value = 0;
            this._grid.currentPage = 0;
            Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
                this._pageIndicators.setNPages(this._grid.nPages());
                this._pageIndicators.setCurrentPage(0);
            });
        }

        this._availWidth = availWidth;
        this._availHeight = availHeight;
        // Update folder views
        for (let i = 0; i < this.folderIcons.length; i++)
            this.folderIcons[i].adaptToSize(availWidth, availHeight);

        // Enable panning depending on the number of pages
        this._scrollView.remove_action(this._panAction);
        if (this._grid.nPages() > 1)
            this._scrollView.add_action(this._panAction);
    }
};
Signals.addSignalMethods(AllView.prototype);

var FrequentView = class FrequentView extends BaseAppView {
    constructor() {
        super(null, { fillParent: true });

        this.actor = new St.Widget({ style_class: 'frequent-apps',
                                     layout_manager: new Clutter.BinLayout(),
                                     x_expand: true, y_expand: true });

        this._noFrequentAppsLabel = new St.Label({ text: _("Frequently used applications will appear here"),
                                                   style_class: 'no-frequent-applications-label',
                                                   x_align: Clutter.ActorAlign.CENTER,
                                                   x_expand: true,
                                                   y_align: Clutter.ActorAlign.CENTER,
                                                   y_expand: true });

        this._grid.y_expand = true;

        this.actor.add_actor(this._grid);
        this.actor.add_actor(this._noFrequentAppsLabel);
        this._noFrequentAppsLabel.hide();

        this._usage = Shell.AppUsage.get_default();

        this.actor.connect('notify::mapped', () => {
            if (this.actor.mapped)
                this._redisplay();
        });
    }

    hasUsefulData() {
        return this._usage.get_most_used().length >= MIN_FREQUENT_APPS_COUNT;
    }

    _loadApps() {
        let mostUsed = this._usage.get_most_used();
        let hasUsefulData = this.hasUsefulData();
        this._noFrequentAppsLabel.visible = !hasUsefulData;
        if(!hasUsefulData)
            return;

        for (let i = 0; i < mostUsed.length; i++) {
            if (!mostUsed[i].get_app_info().should_show())
                continue;
            let appIcon = new AppIcon(mostUsed[i],
                                      { isDraggable: true },
                                      null);
            this._grid.addItem(appIcon, -1);
        }
    }

    // Called before allocation to calculate dynamic spacing
    adaptToSize(width, height) {
        let box = new Clutter.ActorBox();
        box.x1 = box.y1 = 0;
        box.x2 = width;
        box.y2 = height;
        box = this.actor.get_theme_node().get_content_box(box);
        box = this._grid.get_theme_node().get_content_box(box);
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        this._grid.adaptToSize(availWidth, availHeight);
    }
};

var Views = {
    ALL: 0
};

var ControlsBoxLayout = GObject.registerClass(
class ControlsBoxLayout extends Clutter.BoxLayout {
    /**
     * Override the BoxLayout behavior to use the maximum preferred width of all
     * buttons for each child
     */
    vfunc_get_preferred_width(container, forHeight) {
        let maxMinWidth = 0;
        let maxNaturalWidth = 0;
        for (let child = container.get_first_child();
             child;
             child = child.get_next_sibling()) {
             let [minWidth, natWidth] = child.get_preferred_width(forHeight);
             maxMinWidth = Math.max(maxMinWidth, minWidth);
             maxNaturalWidth = Math.max(maxNaturalWidth, natWidth);
        }
        let childrenCount = container.get_n_children();
        let totalSpacing = this.spacing * (childrenCount - 1);
        return [maxMinWidth * childrenCount + totalSpacing,
                maxNaturalWidth * childrenCount + totalSpacing];
    }
});

var AppDisplay = class AppDisplay {
    constructor() {
        this._privacySettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.privacy' });
        this._allView = new AllView();

        this.actor = new St.Widget({ style_class: 'all-apps',
                                     x_expand: true,
                                     y_expand: true,
                                     layout_manager: new Clutter.BinLayout() });

        this.actor.add_actor(this._allView.actor);
        this._showView();
    }

    animate(animationDirection, onComplete) {
        this._allView.animate(animationDirection, onComplete);
    }

    _showView(activeIndex) {
        this._allView.animateSwitch(IconGrid.AnimationDirection.IN);
    }

    selectApp(id) {
        this._showView(Views.ALL);
        this._views[Views.ALL].view.selectApp(id);
    }

    adaptToSize(width, height) {
        return this._allView.adaptToSize(width, height);
    }

    get gridContainer() {
        return this._allView.actor;
    }

    get gridActor() {
        return this._allView.gridActor;
    }
};

var AppSearchProvider = class AppSearchProvider {
    constructor() {
        this._appSys = Shell.AppSystem.get_default();
        this.id = 'applications';
        this.isRemoteProvider = false;
        this.canLaunchSearch = false;

        this._systemActions = new SystemActions.getDefault();
    }

    getResultMetas(apps, callback) {
        let metas = [];
        for (let id of apps) {
            if (id.endsWith('.desktop')) {
                let app = this._appSys.lookup_app(id);

                metas.push({ 'id': app.get_id(),
                             'name': app.get_name(),
                             'createIcon'(size) {
                                 return app.create_icon_texture(size);
                           }
                });
            } else {
                let name = this._systemActions.getName(id);
                let iconName = this._systemActions.getIconName(id);

                let createIcon = size => new St.Icon({ icon_name: iconName,
                                                       width: size,
                                                       height: size,
                                                       style_class: 'system-action-icon' });

                metas.push({ id, name, createIcon });
            }
        }

        callback(metas);
    }

    filterResults(results, maxNumber) {
        return results.slice(0, maxNumber);
    }

    getInitialResultSet(terms, callback, cancellable) {
        let query = terms.join(' ');
        let groups = Shell.AppSystem.search(query);
        let usage = Shell.AppUsage.get_default();
        let results = [];
        let replacementMap = {};

        groups.forEach(group => {
            group = group.filter(appID => {
                let app = Gio.DesktopAppInfo.new(appID);
                let isLink = appID.startsWith(EOS_LINK_PREFIX);
                let isOnDesktop = IconGridLayout.layout.hasIcon(appID);

                // exclude links that are not part of the desktop grid
                if (!(app && app.should_show() && !(isLink && !isOnDesktop)))
                    return false;

                if (app && app.should_show()) {
                    let replacedByID = app.get_string(EOS_REPLACED_BY_KEY);
                    if (replacedByID)
                        replacementMap[appID] = replacedByID;

                    return true;
                }

                return false;
            });
            results = results.concat(group.sort(
                (a, b) => usage.compare(a, b)
            ));
        });

        results = results.concat(this._systemActions.getMatchingActions(terms));

        // resort to keep results on the desktop grid before the others
        results = results.sort(function(a, b) {
            let hasA = a === EOS_APP_CENTER_ID || IconGridLayout.layout.hasIcon(a);
            let hasB = b === EOS_APP_CENTER_ID || IconGridLayout.layout.hasIcon(b);

            return hasB - hasA;
        });

        // perform replacements by removing replaceable apps
        results = results.filter(function(appID) {
            let replacedByID = replacementMap[appID];

            // this app does not specify any replacements, show it
            if (!replacedByID)
                return true;

            // the specified replacement is not installed, show it
            let replacedByApp = Gio.DesktopAppInfo.new(replacedByID);
            if (!replacedByApp)
                return true;

            // the specified replacement is installed, hide it
            return false;
        });

        callback(results);
    }

    getSubsearchResultSet(previousResults, terms, callback, cancellable) {
        this.getInitialResultSet(terms, callback, cancellable);
    }

    activateResult(appId) {
        let event = Clutter.get_current_event();
        let app = this._appSys.lookup_app(appId);
        let activationContext = new AppActivation.AppActivationContext(app);
        activationContext.activate(event);
    }

    createResultObject(resultMeta) {
        // We only use this code path for SystemActions which, from the point
        // of view of this method, are those NOT referenced with desktop IDs.
        if (!resultMeta.id.endsWith('.desktop'))
            return new SystemActionIcon(this, resultMeta);
    }
};

var FolderView = class FolderView extends BaseAppView {
    constructor(folderIcon, dirInfo) {
        super(null, null);

        this._folderIcon = folderIcon;
        this._dirInfo = dirInfo;

        // If it not expand, the parent doesn't take into account its preferred_width when allocating
        // the second time it allocates, so we apply the "Standard hack for ClutterBinLayout"
        this._grid.x_expand = true;

        this.actor = new St.ScrollView({ overlay_scrollbars: true });
        this.actor.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        let scrollableContainer = new St.BoxLayout({ vertical: true, reactive: true });
        this._noAppsLabel = new St.Label({ text: _("No apps in this folder! To add an app, drag it onto the folder."),
                                           style_class: 'folder-no-apps-label'});
        scrollableContainer.add_actor(this._noAppsLabel);
        scrollableContainer.add_actor(this._grid);
        this.actor.add_actor(scrollableContainer);

        let action = new Clutter.PanAction({ interpolate: true });
        action.connect('pan', this._onPan.bind(this));
        this.actor.add_action(action);

        this._redisplay();
    }

    _loadApps() {
        let appSys = Shell.AppSystem.get_default();
        let addAppId = (function addAppId(appId) {
            let app = appSys.lookup_app(appId);
            if (!app)
                return;

            if (!app.get_app_info().should_show())
                return;

            let icon = new AppIcon(app,
                                   { isDraggable: true,
                                     parentView: this.view },
                                   null);
            this.addItem(icon);
        }).bind(this);

        let folderApps = IconGridLayout.layout.getIcons(this._dirInfo.get_id());
        folderApps.forEach(addAppId);

        this.loadGrid();
        this.updateNoAppsLabelVisibility();
    }

    updateNoAppsLabelVisibility() {
        this._noAppsLabel.visible = this._grid.visibleItemsCount() == 0;
    }

    _childFocused(actor) {
        Util.ensureActorVisibleInScrollView(this.actor, actor);
    }

    createFolderIcon(size) {
        let layout = new Clutter.GridLayout();
        let icon = new St.Widget({ layout_manager: layout,
                                   style_class: 'app-folder-icon' });
        layout.hookup_style(icon);
        let subSize = Math.floor(FOLDER_SUBICON_FRACTION * size);
        let scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;

        let numItems = this._allItems.length;
        let rtl = icon.get_text_direction() == Clutter.TextDirection.RTL;
        for (let i = 0; i < 4; i++) {
            let bin = new St.Bin({ width: subSize * scale, height: subSize * scale });
            if (i < numItems)
                bin.child = this._allItems[i].app.create_icon_texture(subSize);
            layout.attach(bin, rtl ? (i + 1) % 2 : i % 2, Math.floor(i / 2), 1, 1);
        }

        return icon;
    }

    _onPan(action) {
        let [dist, dx, dy] = action.get_motion_delta(0);
        let adjustment = this.actor.vscroll.adjustment;
        adjustment.value -= (dy / this.actor.height) * adjustment.page_size;
        return false;
    }

    adaptToSize(width, height) {
        this._parentAvailableWidth = width;
        this._parentAvailableHeight = height;

        this._grid.adaptToSize(width, height);

        // To avoid the fade effect being applied to the unscrolled grid,
        // the offset would need to be applied after adjusting the padding;
        // however the final padding is expected to be too small for the
        // effect to look good, so use the unadjusted padding
        let fadeOffset = Math.min(this._grid.topPadding,
                                  this._grid.bottomPadding);
        this.actor.update_fade_effect(fadeOffset, 0);

        // Set extra padding to avoid popup or close button being cut off
        this._grid.topPadding = Math.max(this._grid.topPadding - this._offsetForEachSide, 0);
        this._grid.bottomPadding = Math.max(this._grid.bottomPadding - this._offsetForEachSide, 0);
        this._grid.leftPadding = Math.max(this._grid.leftPadding - this._offsetForEachSide, 0);
        this._grid.rightPadding = Math.max(this._grid.rightPadding - this._offsetForEachSide, 0);

        this.actor.set_width(this.usedWidth());
        this.actor.set_height(this.usedHeight());
    }

    _getPageAvailableSize() {
        let pageBox = new Clutter.ActorBox();
        pageBox.x1 = pageBox.y1 = 0;
        pageBox.x2 = this._parentAvailableWidth;
        pageBox.y2 = this._parentAvailableHeight;

        let contentBox = this.actor.get_theme_node().get_content_box(pageBox);
        // We only can show icons inside the collection view boxPointer
        // so we have to substract the required padding etc of the boxpointer
        return [(contentBox.x2 - contentBox.x1) - 2 * this._offsetForEachSide, (contentBox.y2 - contentBox.y1) - 2 * this._offsetForEachSide];
    }

    usedWidth() {
        let [availWidthPerPage, availHeightPerPage] = this._getPageAvailableSize();
        return this._grid.usedWidth(availWidthPerPage);
    }

    usedHeight() {
        return this._grid.usedHeightForNRows(this.nRowsDisplayedAtOnce());
    }

    nRowsDisplayedAtOnce() {
        let [availWidthPerPage, availHeightPerPage] = this._getPageAvailableSize();
        let maxRows = this._grid.rowsForHeight(availHeightPerPage) - 1;
        return Math.min(this._grid.nRows(availWidthPerPage), maxRows);
    }

    setPaddingOffsets(offset) {
        this._offsetForEachSide = offset;
    }

    getViewId() {
        return this._folderIcon.getId();
    }
};

const ViewIconState = {
    NORMAL: 0,
    DND_PLACEHOLDER: 1,
    NUM_STATES: 2
};

var ViewIcon = GObject.registerClass(
class ViewIcon extends GObject.Object {
    _init(params, buttonParams, iconParams) {
        super._init();

        params = Params.parse(params,
                              { isDraggable: true,
                                showMenu: true,
                                parentView: null },
                              true);
        buttonParams = Params.parse(buttonParams,
                                    { style_class: 'app-well-app',
                                      button_mask: St.ButtonMask.ONE |
                                                   St.ButtonMask.TWO |
                                                   St.ButtonMask.THREE,
                                      toggle_mode: false,
                                      can_focus: true,
                                      x_fill: true,
                                      y_fill: true
                                    },
                                    true);
        iconParams = Params.parse(iconParams,
                                  { editable: false,
                                    showLabel: true },
                                  true);

        this.showMenu = params.showMenu;
        this.parentView = params.parentView;

        this.canDrop = false;
        this.blockHandler = false;

        // Might be changed once the createIcon() method is called.
        this._iconSize = IconGrid.ICON_SIZE;
        this._iconState = ViewIconState.NORMAL;

        this.actor = new St.Button(buttonParams);
        this.actor._delegate = this;
        this.actor.connect('destroy', this._onDestroy.bind(this));

        this._createIconFunc = iconParams['createIcon'];
        iconParams['createIcon'] = this._createIconBase.bind(this);

        // Used to save the text when setting up the DnD placeholder.
        this._origText = null;

        this.icon = new IconGrid.BaseIcon(this.getName(), iconParams);
        if (iconParams['showLabel'] && iconParams['editable']) {
            this.icon.label.connect('label-edit-update', this._onLabelUpdate.bind(this));
            this.icon.label.connect('label-edit-cancel', this._onLabelCancel.bind(this));
        }

        this.actor.label_actor = this.icon.label;

        if (params.isDraggable) {
            this._draggable = DND.makeDraggable(this.actor);
            this._draggable.connect('drag-begin', () => {
                this.prepareForDrag();
                Main.overview.beginItemDrag(this);
            });
            this._draggable.connect('drag-cancelled', () => {
                Main.overview.cancelledItemDrag(this);
            });
            this._draggable.connect('drag-end', () => {
                Main.overview.endItemDrag(this);
            });
        }
    }

    getId() {
        throw new Error('Not implemented');
    }

    getName() {
        throw new Error('Not implemented');
    }

    getIcon() {
        throw new Error('Not implemented');
    }

    _onLabelUpdate() {
        // Do nothing by default
    }

    _onLabelCancel() {
        this.icon.actor.sync_hover();
    }

    _onDestroy() {
        this.actor._delegate = null;
    }

    _createIconBase(iconSize) {
        if (this._iconSize != iconSize)
            this._iconSize = iconSize;

        // Replace the original icon with an empty placeholder
        if (this._iconState == ViewIconState.DND_PLACEHOLDER)
            return new St.Icon({ icon_size: this._iconSize });

        return this._createIconFunc(this._iconSize);
    }

    remove() {
        this.blockHandler = true;
        IconGridLayout.layout.removeIcon(this.getId(), true);
        this.blockHandler = false;

        this.handleViewDragEnd();
        this.actor.hide();
    }

    replaceText(newText) {
        if (!this.icon.label)
            return;

        this._origText = this.icon.label.text;
        this.icon.label.text = newText;
    }

    restoreText() {
        if (!this._origText)
            return;

        this.icon.label.text = this._origText;
        this._origText = null;
    }

    prepareDndPlaceholder() {
        this.replaceText('');
    }

    resetDnDPlaceholder() {
        this.restoreText();
    }

    handleViewDragBegin() {
        this.iconState = ViewIconState.DND_PLACEHOLDER;
        this.prepareDndPlaceholder();
    }

    handleViewDragEnd() {
        if (!this.blockHandler) {
            this.iconState = ViewIconState.NORMAL;
            this.resetDnDPlaceholder();
        }
    }

    prepareForDrag() {
        throw new Error('Not implemented');
    }

    setDragHoverState(state) {
        this.icon.actor.set_hover(state);
    }

    canDragOver(dest) {
        return false;
    }

    handleIconDrop(source) {
        throw new Error('Not implemented');
    }

    getDragActor() {
        let iconParams = { createIcon: this._createIcon.bind(this),
                           showLabel: (this.icon.label != null),
                           setSizeManually: false };

        let icon = new IconGrid.BaseIcon(this.getName(), iconParams);
        icon.add_style_class_name('dnd');
        return icon;
    }

    // Returns the original actor that should align with the actor
    // we show as the item is being dragged.
    getDragActorSource() {
        return this.icon.icon;
    }

    set iconState(iconState) {
        if (this._iconState == iconState)
            return;

        this._iconState = iconState;
        this.icon.reloadIcon();
    }

    get iconState() {
        return this._iconState;
    }
});

var FolderIcon = GObject.registerClass({
    Signals: { 'name-changed': {} },
}, class FolderIcon extends ViewIcon {
    _init(dirInfo, parentView) {
        let viewIconParams = { isDraggable: true,
                               parentView: parentView };
        let buttonParams = { button_mask: St.ButtonMask.ONE,
                             toggle_mode: true };
        let iconParams = { createIcon: this._createIcon.bind(this),
                           setSizeManually: false,
                           editable: true };
        this.name = dirInfo.get_name();
        this._parentView = parentView;

        this.id = dirInfo.get_id();
        this._dirInfo = dirInfo;

        super._init(viewIconParams, buttonParams, iconParams);
        this.actor.add_style_class_name('app-folder');
        this.actor.set_child(this.icon.actor);

        // whether we need to update arrow side, position etc.
        this._popupInvalidated = false;

        this.canDrop = true;

        this.view = new FolderView(this, this._dirInfo);

        this.actor.connect('clicked', () => {
            this._ensurePopup();
            this.view.actor.vscroll.adjustment.value = 0;
            this._openSpaceForPopup();
        });

        this._updateName();

        this.actor.connect('notify::mapped', () => {
            if (!this.actor.mapped && this._popup)
                this._popup.popdown();
        });
    }

    getId() {
        return this._dirInfo.get_id();
    }

    getName() {
        return this.name;
    }

    getIcon() {
        return this._dirInfo.get_icon();
    }

    getAppIds() {
        return this.view.getAllItems().map(item => {
            return item.id;
        });
    }

    getAppIds() {
        return this.view.getAllItems().map(item => item.id);
    }

    _onLabelUpdate(label, newText) {
        try {
            this._dirInfo.create_custom_with_name(newText);
            this.name = newText;
        } catch(e) {
            logError(e, 'error while creating a custom dirInfo for: '
                      + this.name
                      + ' using new name: '
                      + newText);
        }
    }

    _updateName() {
        let name = this._dirInfo.get_name();
        if (this.name == name)
            return;

        this.name = name;
        this.icon.label.text = this.name;
        this.emit('name-changed');
    }

    _createIcon(iconSize) {
        return this.view.createFolderIcon(iconSize, this);
    }

    _popupHeight() {
        let usedHeight = this.view.usedHeight() + this._popup.getOffset(St.Side.TOP) + this._popup.getOffset(St.Side.BOTTOM);
        return usedHeight;
    }

    _openSpaceForPopup() {
        let id = this._parentView.connect('space-ready', () => {
            this._parentView.disconnect(id);
            this._popup.popup();
            this._updatePopupPosition();
        });
        this._parentView.openSpaceForPopup(this, this._boxPointerArrowside,
                                           Math.max(this.view.nRowsDisplayedAtOnce(), 1));
    }

    _calculateBoxPointerArrowSide() {
        let spaceTop = this.actor.y - this._parentView.getCurrentPageY();
        let spaceBottom = this._parentView.actor.height - (spaceTop + this.actor.height);

        return spaceTop > spaceBottom ? St.Side.BOTTOM : St.Side.TOP;
    }

    _updatePopupSize() {
        // StWidget delays style calculation until needed, make sure we use the correct values
        this.view._grid.ensure_style();

        let offsetForEachSide = Math.ceil((this._popup.getOffset(St.Side.TOP) +
                                           this._popup.getOffset(St.Side.BOTTOM) -
                                           this._popup.getCloseButtonOverlap()) / 2);
        // Add extra padding to prevent boxpointer decorations and close button being cut off
        this.view.setPaddingOffsets(offsetForEachSide);
        this.view.adaptToSize(this._parentAvailableWidth, this._parentAvailableHeight);
    }

    _updatePopupPosition() {
        if (!this._popup)
            return;

        if (this._boxPointerArrowside == St.Side.BOTTOM)
            this._popup.actor.y = this.actor.allocation.y1 + this.actor.translation_y - this._popupHeight();
        else
            this._popup.actor.y = this.actor.allocation.y1 + this.actor.translation_y + this.actor.height;
    }

    _ensurePopup() {
        if (this._popup && !this._popupInvalidated)
            return;
        this._boxPointerArrowside = this._calculateBoxPointerArrowSide();
        if (!this._popup) {
            this._popup = new AppFolderPopup(this, this._boxPointerArrowside);
            this._parentView.addFolderPopup(this._popup);
            this._popup.connect('open-state-changed', (popup, isOpen) => {
                if (!isOpen)
                    this.actor.checked = false;
            });
        } else {
            this._popup.updateArrowSide(this._boxPointerArrowside);
        }
        this._updatePopupSize();
        this._updatePopupPosition();
        this._popupInvalidated = false;
    }

    adaptToSize(width, height) {
        this._parentAvailableWidth = width;
        this._parentAvailableHeight = height;
        if(this._popup)
            this.view.adaptToSize(width, height);
        this._popupInvalidated = true;
    }

    prepareForDrag() {
    }

    canDragOver(dest) {
        // Can't drag folders over other folders
        if (dest.folder)
            return false;

        return true;
    }

    handleIconDrop(source) {
        // Move the source icon into this folder
        IconGridLayout.layout.appendIcon(source.getId(), this.getId());
        return true;
    }

    get folder() {
        return this._dirInfo;
    }
});

var AppFolderPopup = class AppFolderPopup {
    constructor(source, side) {
        this._source = source;
        this._view = source.view;
        this._arrowSide = side;

        this._isOpen = false;
        this.parentOffset = 0;

        this.actor = new St.Widget({ layout_manager: new Clutter.BinLayout(),
                                     visible: false,
                                     // We don't want to expand really, but look
                                     // at the layout manager of our parent...
                                     //
                                     // DOUBLE HACK: if you set one, you automatically
                                     // get the effect for the other direction too, so
                                     // we need to set the y_align
                                     x_expand: true,
                                     y_expand: true,
                                     x_align: Clutter.ActorAlign.CENTER,
                                     y_align: Clutter.ActorAlign.START });
        this._boxPointer = new BoxPointer.BoxPointer(this._arrowSide,
                                                     { style_class: 'app-folder-popup-bin',
                                                       x_fill: true,
                                                       y_fill: true,
                                                       x_expand: true,
                                                       x_align: St.Align.START });

        this._boxPointer.actor.style_class = 'app-folder-popup';
        this.actor.add_actor(this._boxPointer.actor);
        this._boxPointer.bin.set_child(this._view.actor);

        this.closeButton = Util.makeCloseButton(this._boxPointer);
        this.closeButton.connect('clicked', this.popdown.bind(this));
        this.actor.add_actor(this.closeButton);

        this._boxPointer.actor.bind_property('opacity', this.closeButton, 'opacity',
                                             GObject.BindingFlags.SYNC_CREATE);

        global.focus_manager.add_group(this.actor);

        source.actor.connect('destroy', () => { this.actor.destroy(); });
        this._grabHelper = new GrabHelper.GrabHelper(this.actor, {
            actionMode: Shell.ActionMode.POPUP
        });
        this._grabHelper.addActor(Main.layoutManager.overviewGroup);
        this.actor.connect('key-press-event', this._onKeyPress.bind(this));
    }

    _onKeyPress(actor, event) {
        if (global.stage.get_key_focus() != actor)
            return Clutter.EVENT_PROPAGATE;

        // Since we need to only grab focus on one item child when the user
        // actually press a key we don't use navigate_focus when opening
        // the popup.
        // Instead of that, grab the focus on the AppFolderPopup actor
        // and actually moves the focus to a child only when the user
        // actually press a key.
        // It should work with just grab_key_focus on the AppFolderPopup
        // actor, but since the arrow keys are not wrapping_around the focus
        // is not grabbed by a child when the widget that has the current focus
        // is the same that is requesting focus, so to make it works with arrow
        // keys we need to connect to the key-press-event and navigate_focus
        // when that happens using TAB_FORWARD or TAB_BACKWARD instead of arrow
        // keys

        // Use TAB_FORWARD for down key and right key
        // and TAB_BACKWARD for up key and left key on ltr
        // languages
        let direction;
        let isLtr = Clutter.get_default_text_direction() == Clutter.TextDirection.LTR;
        switch (event.get_key_symbol()) {
            case Clutter.Down:
                direction = St.DirectionType.TAB_FORWARD;
                break;
            case Clutter.Right:
                direction = isLtr ? St.DirectionType.TAB_FORWARD :
                                    St.DirectionType.TAB_BACKWARD;
                break;
            case Clutter.Up:
                direction = St.DirectionType.TAB_BACKWARD;
                break;
            case Clutter.Left:
                direction = isLtr ? St.DirectionType.TAB_BACKWARD :
                                    St.DirectionType.TAB_FORWARD;
                break;
            default:
                return Clutter.EVENT_PROPAGATE;
        }
        return actor.navigate_focus(null, direction, false);
    }

    toggle() {
        if (this._isOpen)
            this.popdown();
        else
            this.popup();
    }

    popup() {
        if (this._isOpen)
            return;

        this._isOpen = this._grabHelper.grab({ actor: this.actor,
                                               onUngrab: this.popdown.bind(this) });

        if (!this._isOpen)
            return;

        this.actor.show();

        this._boxPointer.setArrowActor(this._source.actor);
        // We need to hide the icons of the view until the boxpointer animation
        // is completed so we can animate the icons after as we like without
        // showing them while boxpointer is animating.
        this._view.actor.opacity = 0;
        this._boxPointer.open(BoxPointer.PopupAnimation.FADE |
                              BoxPointer.PopupAnimation.SLIDE,
                              () => {
                this._view.actor.opacity = 255;
                this._view.animate(IconGrid.AnimationDirection.IN);
            });

        this.emit('open-state-changed', true);
    }

    popdown() {
        if (!this._isOpen)
            return;

        this._grabHelper.ungrab({ actor: this.actor });

        this._boxPointer.close(BoxPointer.PopupAnimation.FADE |
                               BoxPointer.PopupAnimation.SLIDE);
        this._isOpen = false;
        this.emit('open-state-changed', false);
    }

    getCloseButtonOverlap() {
        return this.closeButton.get_theme_node().get_length('-shell-close-overlap-y');
    }

    getOffset(side) {
        let offset = this._boxPointer.getPadding(side);
        if (this._arrowSide == side)
            offset += this._boxPointer.getArrowHeight();
        return offset;
    }

    updateArrowSide(side) {
        this._arrowSide = side;
        this._boxPointer.updateArrowSide(side);
    }
};
Signals.addSignalMethods(AppFolderPopup.prototype);

var AppIconSourceActor = GObject.registerClass(
class AppIconSourceActor extends MessageTray.SourceActor {
    _init(source, size) {
        super._init(source, size);
        this.setIcon(new St.Bin());
    }

    _shouldShowCount() {
        // Always show the counter when there's at least one notification
        return this.source.count > 0;
    }
});

var AppIcon = GObject.registerClass({
    Signals: { 'menu-state-changed': { param_types: [GObject.TYPE_BOOLEAN] },
               'sync-tooltip': {} },
}, class AppDisplayIcon extends ViewIcon {
    _init(app, viewIconParams, iconParams) {
        this.app = app;
        this.id = app.get_id();
        this.name = app.get_name();

        let buttonParams = { button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO };
        iconParams = Params.parse(iconParams, { createIcon: this._createIcon.bind(this),
                                                createExtraIcons: this._createExtraIcons.bind(this) },
                                  true);
        if (!iconParams)
            iconParams = {};

        super._init(viewIconParams, buttonParams, iconParams);

        this._dot = new St.Widget({ style_class: 'app-well-app-running-dot',
                                    layout_manager: new Clutter.BinLayout(),
                                    x_expand: true, y_expand: true,
                                    x_align: Clutter.ActorAlign.CENTER,
                                    y_align: Clutter.ActorAlign.END });

        this._iconContainer = new St.Widget({ layout_manager: new Clutter.BinLayout(),
                                              x_expand: true, y_expand: true });
        this._iconContainer.add_child(this.icon.actor);

        this.actor.set_child(this._iconContainer);
        this._iconContainer.add_child(this._dot);

        this.actor.connect('leave-event', this._onLeaveEvent.bind(this));
        this.actor.connect('button-press-event', this._onButtonPress.bind(this));
        this.actor.connect('touch-event', this._onTouchEvent.bind(this));
        this.actor.connect('clicked', this._onClicked.bind(this));
        this.actor.connect('popup-menu', this._onKeyboardPopupMenu.bind(this));

        this._menu = null;
        this._menuManager = new PopupMenu.PopupMenuManager(this);

        this.actor.connect('destroy', this._onDestroy.bind(this));

        this._menuTimeoutId = 0;
        this._stateChangedId = this.app.connect('notify::state', () => {
            this._updateRunningStyle();
        });
        this._updateRunningStyle();
    }

    getId() {
        return this.app.get_id();
    }

    getName() {
        return this.name;
    }

    getIcon() {
        return this.app.get_icon();
    }

    _onDestroy() {
        if (this._stateChangedId > 0)
            this.app.disconnect(this._stateChangedId);
        this._stateChangedId = 0;
        this._removeMenuTimeout();
    }

    _createIcon(iconSize) {
        return this.app.create_icon_texture(iconSize);
    }

    _createExtraIcons(iconSize) {
        if (!this._notificationSource)
            return [];

        let sourceActor = new AppIconSourceActor(this._notificationSource, iconSize);
        return [sourceActor.actor];
    }

    _removeMenuTimeout() {
        if (this._menuTimeoutId > 0) {
            Mainloop.source_remove(this._menuTimeoutId);
            this._menuTimeoutId = 0;
        }
    }

    _updateRunningStyle() {
        if (this.app.state != Shell.AppState.STOPPED)
            this._dot.show();
        else
            this._dot.hide();
    }

    _setPopupTimeout() {
        this._removeMenuTimeout();
        this._menuTimeoutId = Mainloop.timeout_add(MENU_POPUP_TIMEOUT, () => {
            this._menuTimeoutId = 0;
            this.popupMenu();
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._menuTimeoutId, '[gnome-shell] this.popupMenu');
    }

    _onLeaveEvent(actor, event) {
        this.actor.fake_release();
        this._removeMenuTimeout();
    }

    _onButtonPress(actor, event) {
        let button = event.get_button();
        if (button == 1) {
            this._setPopupTimeout();
        } else if (button == 3) {
            this.popupMenu();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onTouchEvent(actor, event) {
        if (event.type() == Clutter.EventType.TOUCH_BEGIN)
            this._setPopupTimeout();

        return Clutter.EVENT_PROPAGATE;
    }

    _onClicked(actor, button) {
        this._removeMenuTimeout();
        this.activate(button);
    }

    _onKeyboardPopupMenu() {
        this.popupMenu();
        this._menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }

    popupMenu() {
        this._removeMenuTimeout();

        if (!this.showMenu)
            return true;

        this.actor.fake_release();

        if (this._draggable)
            this._draggable.fakeRelease();

        if (!this._menu) {
            this._menu = new AppIconMenu(this);
            this._menu.connect('activate-window', (menu, window) => {
                this.activateWindow(window);
            });
            this._menu.connect('open-state-changed', (menu, isPoppedUp) => {
                if (!isPoppedUp)
                    this._onMenuPoppedDown();
            });
            let id = Main.overview.connect('hiding', () => {
                this._menu.close();
            });
            this.actor.connect('destroy', () => {
                Main.overview.disconnect(id);
            });

            this._menuManager.addMenu(this._menu);
        }

        this.emit('menu-state-changed', true);

        this.actor.set_hover(true);
        this._menu.popup();
        this._menuManager.ignoreRelease();
        this.emit('sync-tooltip');

        return false;
    }

    activateWindow(metaWindow) {
        if (metaWindow) {
            Main.activateWindow(metaWindow);
        } else {
            Main.overview.hide();
        }
    }

    _onMenuPoppedDown() {
        this.actor.sync_hover();
        this.emit('menu-state-changed', false);
    }

    activate(button) {
        let event = Clutter.get_current_event();
        let activationContext = new AppActivation.AppActivationContext(this.app);
        activationContext.activate(event);
    }

    animateLaunch() {
        this.icon.animateZoomOut();
    }

    shellWorkspaceLaunch(params) {
        params = Params.parse(params, { workspace: -1,
                                        timestamp: 0 });

        this.app.open_new_window(params.workspace);
    }

    prepareForDrag() {
        this._removeMenuTimeout();
    }

    prepareDndPlaceholder() {
        super.prepareDndPlaceholder();
        this._dot.hide();
    }

    resetDnDPlaceholder() {
        super.resetDnDPlaceholder();

        if (this.app.state != Shell.AppState.STOPPED)
            this._dot.show();
        else
            this._dot.hide();
    }

    canDragOver(dest) {
        return true;
    }

    shouldShowTooltip() {
        return this.actor.hover && (!this._menu || !this._menu.isOpen);
    }
});

var AppIconMenu = class AppIconMenu extends PopupMenu.PopupMenu {
    constructor(source) {
        let side = St.Side.LEFT;
        if (Clutter.get_default_text_direction() == Clutter.TextDirection.RTL)
            side = St.Side.RIGHT;

        super(source.actor, 0.5, side);

        // We want to keep the item hovered while the menu is up
        this.blockSourceEvents = true;

        this._source = source;

        this.actor.add_style_class_name('app-well-menu');

        // Chain our visibility and lifecycle to that of the source
        this._sourceMappedId = source.actor.connect('notify::mapped', () => {
            if (!source.actor.mapped)
                this.close();
        });
        source.actor.connect('destroy', () => {
            source.actor.disconnect(this._sourceMappedId);
            this.destroy();
        });

        Main.uiGroup.add_actor(this.actor);
    }

    _redisplay() {
        this.removeAll();

        let windows = this._source.app.get_windows().filter(
            w => !w.skip_taskbar
        );

        // Display the app windows menu items and the separator between windows
        // of the current desktop and other windows.
        let workspaceManager = global.workspace_manager;
        let activeWorkspace = workspaceManager.get_active_workspace();
        let separatorShown = windows.length > 0 && windows[0].get_workspace() != activeWorkspace;

        for (let i = 0; i < windows.length; i++) {
            let window = windows[i];
            if (!separatorShown && window.get_workspace() != activeWorkspace) {
                this._appendSeparator();
                separatorShown = true;
            }
            let title = window.title ? window.title
                                     : this._source.app.get_name();
            let item = this._appendMenuItem(title);
            item.connect('activate', () => {
                this.emit('activate-window', window);
            });
        }

        if (!this._source.app.is_window_backed()) {
            this._appendSeparator();

            let appInfo = this._source.app.get_app_info();
            let actions = appInfo.list_actions();
            if (this._source.app.can_open_new_window() &&
                actions.indexOf('new-window') == -1) {
                this._newWindowMenuItem = this._appendMenuItem(_("New Window"));
                this._newWindowMenuItem.connect('activate', () => {
                    if (this._source.app.state == Shell.AppState.STOPPED)
                        this._source.animateLaunch();

                    this._source.app.open_new_window(-1);
                    this.emit('activate-window', null);
                });
                this._appendSeparator();
            }

            if (discreteGpuAvailable &&
                this._source.app.state == Shell.AppState.STOPPED &&
                actions.indexOf('activate-discrete-gpu') == -1) {
                this._onDiscreteGpuMenuItem = this._appendMenuItem(_("Launch using Dedicated Graphics Card"));
                this._onDiscreteGpuMenuItem.connect('activate', () => {
                    if (this._source.app.state == Shell.AppState.STOPPED)
                        this._source.animateLaunch();

                    this._source.app.launch(0, -1, true);
                    this.emit('activate-window', null);
                });
            }

            for (let i = 0; i < actions.length; i++) {
                let action = actions[i];
                let item = this._appendMenuItem(appInfo.get_action_name(action));
                item.connect('activate', (emitter, event) => {
                    this._source.app.launch_action(action, event.get_time(), -1);
                    this.emit('activate-window', null);
                });
            }

            let canFavorite = global.settings.is_writable('favorite-apps');

            if (canFavorite) {
                this._appendSeparator();

                let isFavorite = AppFavorites.getAppFavorites().isFavorite(this._source.app.get_id());

                if (isFavorite) {
                    let item = this._appendMenuItem(_("Remove from Favorites"));
                    item.connect('activate', () => {
                        let favs = AppFavorites.getAppFavorites();
                        favs.removeFavorite(this._source.app.get_id());
                    });
                } else {
                    let item = this._appendMenuItem(_("Add to Favorites"));
                    item.connect('activate', () => {
                        let favs = AppFavorites.getAppFavorites();
                        favs.addFavorite(this._source.app.get_id());
                    });
                }
            }

            if (Shell.AppSystem.get_default().lookup_app('org.gnome.Software.desktop')) {
                this._appendSeparator();
                let item = this._appendMenuItem(_("Show Details"));
                item.connect('activate', () => {
                    let id = this._source.app.get_id();
                    let args = GLib.Variant.new('(ss)', [id, '']);
                    Gio.DBus.get(Gio.BusType.SESSION, null, (o, res) => {
                        let bus = Gio.DBus.get_finish(res);
                        bus.call('org.gnome.Software',
                                 '/org/gnome/Software',
                                 'org.gtk.Actions', 'Activate',
                                 GLib.Variant.new('(sava{sv})',
                                                  ['details', [args], null]),
                                 null, 0, -1, null, null);
                        Main.overview.hide();
                    });
                });
            }
        }
    }

    _appendSeparator() {
        let separator = new PopupMenu.PopupSeparatorMenuItem();
        this.addMenuItem(separator);
    }

    _appendMenuItem(labelText) {
        // FIXME: app-well-menu-item style
        let item = new PopupMenu.PopupMenuItem(labelText);
        this.addMenuItem(item);
        return item;
    }

    popup(activatingButton) {
        this._redisplay();
        this.open();
    }
};
Signals.addSignalMethods(AppIconMenu.prototype);

var SystemActionIcon = class SystemActionIcon extends Search.GridSearchResult {
    activate() {
        SystemActions.getDefault().activateAction(this.metaInfo['id']);
        Main.overview.viewSelector.show(ViewSelector.ViewPage.APPS);
    }
};

const AppCenterIconState = {
    EMPTY_TRASH: ViewIconState.NUM_STATES,
    FULL_TRASH: ViewIconState.NUM_STATES + 1
};

var AppCenterIcon = GObject.registerClass(
class AppCenterIcon extends AppIcon {
    _init(parentView) {
        let viewIconParams = { isDraggable: false,
                               showMenu: false,
                               parentView: parentView };

        let iconParams = { createIcon: this._createIcon.bind(this) };

        let appSys = Shell.AppSystem.get_default();
        let app = appSys.lookup_app(EOS_APP_CENTER_ID);

        super._init(app, viewIconParams, iconParams);
        this.canDrop = true;
    }
    _setStyleClass(state) {
        if (state == AppCenterIconState.EMPTY_TRASH) {
            this.actor.remove_style_class_name('trash-icon-full');
            this.actor.add_style_class_name('trash-icon-empty');
        } else if (state == AppCenterIconState.FULL_TRASH) {
            this.actor.remove_style_class_name('trash-icon-empty');
            this.actor.add_style_class_name('trash-icon-full');
        } else {
            this.actor.remove_style_class_name('trash-icon-empty');
            this.actor.remove_style_class_name('trash-icon-full');
        }
    }

    _createIcon(iconSize) {
        // Set the icon image as a background via CSS,
        // and return an empty icon to satisfy the caller
        this._setStyleClass(this.iconState);

        if (this.iconState != ViewIconState.NORMAL)
            return new St.Icon({ icon_size: iconSize });

        // In normal state we chain up to the parent to get the default icon.
        return super._createIcon	(iconSize);
    }

    getId() {
        return EOS_APP_CENTER_ID;
    }

    getName() {
        return this.app.get_generic_name();
    }

    handleViewDragBegin() {
        this.iconState = AppCenterIconState.EMPTY_TRASH;
        this.replaceText(_("Delete"));
    }

    setDragHoverState(state) {
        let appCenterIconState = state ?
            AppCenterIconState.FULL_TRASH : AppCenterIconState.EMPTY_TRASH;
        this.iconState = appCenterIconState;
    }

    handleIconDrop(source) {
        source.remove();
        this.handleViewDragEnd();
        return true;
    }
});
