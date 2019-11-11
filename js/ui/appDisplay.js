// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported AppDisplay, AppSearchProvider */

const { Clutter, Gio, GLib, GObject, Meta, Shell, St } = imports.gi;
const Signals = imports.signals;

const AppActivation = imports.ui.appActivation;
const AppFavorites = imports.ui.appFavorites;
const BackgroundMenu = imports.ui.backgroundMenu;
const BoxPointer = imports.ui.boxpointer;
const DND = imports.ui.dnd;
const GrabHelper = imports.ui.grabHelper;
const IconGrid = imports.ui.iconGrid;
const IconGridLayout = imports.ui.iconGridLayout;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const PageIndicators = imports.ui.pageIndicators;
const ParentalControlsManager = imports.misc.parentalControlsManager;
const PopupMenu = imports.ui.popupMenu;
const ViewSelector = imports.ui.viewSelector;
const Search = imports.ui.search;
const Params = imports.misc.params;
const Util = imports.misc.util;
const SystemActions = imports.misc.systemActions;

const { loadInterfaceXML } = imports.misc.fileUtils;

var MENU_POPUP_TIMEOUT = 600;
var MAX_COLUMNS = 7;
var MIN_COLUMNS = 4;
var MIN_ROWS = 1;

var INACTIVE_GRID_OPACITY = 77;
// This time needs to be less than IconGrid.EXTRA_SPACE_ANIMATION_TIME
// to not clash with other animations
var INACTIVE_GRID_OPACITY_ANIMATION_TIME = 240;
var FOLDER_SUBICON_FRACTION = .4;

var MIN_FREQUENT_APPS_COUNT = 3;

var VIEWS_SWITCH_TIME = 400;
var VIEWS_SWITCH_ANIMATION_DELAY = 100;

var PAGE_SWITCH_TIME = 300;

var APP_ICON_SCALE_IN_TIME = 500;
var APP_ICON_SCALE_IN_DELAY = 700;

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

var EOS_INACTIVE_GRID_TRANSITION = Clutter.AnimationMode.EASE_OUT_QUAD;
var EOS_ACTIVE_GRID_TRANSITION = Clutter.AnimationMode.EASE_IN_QUAD;

var EOS_INACTIVE_GRID_SATURATION = 1;
var EOS_ACTIVE_GRID_SATURATION = 0;

const EOS_REPLACED_BY_KEY = 'X-Endless-Replaced-By';

function _getCategories(info) {
    let categoriesStr = info.get_categories();
    if (!categoriesStr)
        return [];
    return categoriesStr.split(';');
}

function _listsIntersect(a, b) {
    for (let itemA of a)
        if (b.includes(itemA))
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
        } catch (e) {
            return name;
        }
    }

    return name;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function _getViewFromIcon(icon) {
    let parent = icon.actor.get_parent();
    if (!parent._delegate || !(parent._delegate instanceof BaseAppView))
        return null;
    return parent._delegate;
}

function _findBestFolderName(apps) {
    let appInfos = apps.map(app => app.get_app_info());

    let categoryCounter = {};
    let commonCategories = [];

    appInfos.reduce((categories, appInfo) => {
        const appCategories = appInfo.get_categories();
        if (!appCategories)
            return categories;
        for (let category of appCategories.split(';')) {
            if (!(category in categoryCounter))
                categoryCounter[category] = 0;

            categoryCounter[category] += 1;

            // If a category is present in all apps, its counter will
            // reach appInfos.length
            if (category.length > 0 &&
                categoryCounter[category] == appInfos.length) {
                categories.push(category);
            }
        }
        return categories;
    }, commonCategories);

    for (let category of commonCategories) {
        let keyfile = new GLib.KeyFile();
        let path = 'desktop-directories/%s.directory'.format(category);

        try {
            keyfile.load_from_data_dirs(path, GLib.KeyFileFlags.NONE);
            return keyfile.get_locale_string('Desktop Entry', 'Name', null);
        } catch (e) {
            continue;
        }
    }

    return null;
}

class BaseAppView {
    constructor(params, gridParams) {
        if (this.constructor === BaseAppView)
            throw new TypeError(`Cannot instantiate abstract class ${this.constructor.name}`);

        gridParams = Params.parse(gridParams, { xAlign: St.Align.MIDDLE,
                                                columnLimit: MAX_COLUMNS,
                                                minRows: MIN_ROWS,
                                                minColumns: MIN_COLUMNS,
                                                fillParent: false,
                                                padWithSpacing: true });
        params = Params.parse(params, { usePagination: false });

        this._iconGridLayout = IconGridLayout.getDefault();

        if (params.usePagination)
            this._grid = new IconGrid.PaginatedIconGrid(gridParams);
        else
            this._grid = new IconGrid.IconGrid(gridParams);
        this._grid._delegate = this;

        this._grid.connect('child-focused', (grid, actor) => {
            this._childFocused(actor);
        });
        // Standard hack for ClutterBinLayout
        this._grid.x_expand = true;

        this._items = {};
        this._allItems = [];

        this._id = null;
    }

    _childFocused(_actor) {
        // Nothing by default
    }

    _redisplay() {
        let oldApps = this._allItems.slice();
        let newApps = this._loadApps();

        let compareIcons = (itemA, itemB) => {
            if ((itemA instanceof AppIcon) != (itemB instanceof AppIcon))
                return false;

            if (itemA.name != itemB.name)
                return false;

            if (itemA.id != itemB.id)
                return false;

            if ((itemA instanceof AppIcon) &&
                (itemB instanceof AppIcon) &&
                !Shell.AppSystem.app_info_equal(itemA.app.get_app_info(),
                                                itemB.app.get_app_info()))
                return false;

            return true;
        };

        let addedApps = newApps.filter(icon => {
            return !oldApps.some(oldIcon => compareIcons(oldIcon, icon));
        });

        let removedApps = oldApps.filter(icon => {
            return !newApps.some(newIcon => compareIcons(newIcon, icon));
        });

        // Remove old app icons
        removedApps.forEach(icon => {
            let iconIndex = this._allItems.indexOf(icon);

            this._allItems.splice(iconIndex, 1);
            this._grid.removeItem(icon);
            delete this._items[icon.id];
        });

        // Add new app icons
        addedApps.forEach(icon => {
            let iconIndex = newApps.indexOf(icon);

            this._allItems.splice(iconIndex, 0, icon);
            this._grid.addItem(icon, iconIndex);
            this._items[icon.id] = icon;
        });

        this.emit('view-loaded');
    }

    getAllItems() {
        return this._allItems;
    }

    _compareItems(a, b) {
        return a.name.localeCompare(b.name);
    }

    moveItem(item, newPosition) {
        let visibleItems = this._allItems.filter(item => item.actor.visible);

        // Avoid overflow
        if (newPosition >= visibleItems.length)
            return -1;

        let targetId = visibleItems[newPosition].id;

        let visibleIndex = visibleItems.indexOf(item);
        if (newPosition > visibleIndex)
            newPosition -= 1;

        // Remove from the old position
        let itemIndex = this._allItems.indexOf(item);

        let realPosition = -1;
        if (itemIndex != -1) {
            this._allItems.splice(itemIndex, 1);
            realPosition = this._grid.moveItem(item, newPosition);
            this._allItems.splice(realPosition, 0, item);
        } else {
            realPosition = this._allItems.indexOf(targetId);
        }

        this._iconGridLayout.repositionIcon(item.id, targetId, this.id);

        return realPosition;
    }

    _selectAppInternal(id) {
        if (this._items[id])
            this._items[id].actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
        else
            log(`No such application ${id}`);
    }

    selectApp(id) {
        if (this._items[id] && this._items[id].actor.mapped) {
            this._selectAppInternal(id);
        } else if (this._items[id]) {
            // Need to wait until the view is mapped
            let signalId = this._items[id].actor.connect('notify::mapped',
                actor => {
                    if (actor.mapped) {
                        actor.disconnect(signalId);
                        this._selectAppInternal(id);
                    }
                });
        } else {
            // Need to wait until the view is built
            let signalId = this.connect('view-loaded', () => {
                this.disconnect(signalId);
                this.selectApp(id);
            });
        }
    }

    _doSpringAnimation(animationDirection) {
        this._grid.opacity = 255;

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
        this.actor.remove_all_transitions();
        this._grid.remove_all_transitions();

        let params = {
            duration: VIEWS_SWITCH_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
        };
        if (animationDirection == IconGrid.AnimationDirection.IN) {
            this.actor.show();
            params.opacity = 255;
            params.delay = VIEWS_SWITCH_ANIMATION_DELAY;
        } else {
            params.opacity = 0;
            params.delay = 0;
            params.onComplete = () => this.actor.hide();
        }

        this._grid.ease(params);
    }

    _canAccept(source) {
        return true;
    }

    handleDragOver(source, _actor, x, y) {
        if (!this._canAccept(source)) {
            this._grid.removeNudges();
            return DND.DragMotionResult.NO_DROP;
        }

        // Ask grid can we drop here
        let [index, dragLocation] = this.canDropAt(x, y);

        let onIcon = dragLocation == IconGrid.DragLocation.ON_ICON;
        let sourceIndex = this._allItems.filter(c => c.actor.visible).indexOf(source);
        let onItself = sourceIndex != -1 && (sourceIndex == index || sourceIndex == index - 1);
        let isNewPosition =
            ((!onIcon && index != this._lastIndex) ||
             (dragLocation != this._lastDragLocation));

        if (isNewPosition || onItself)
            this._grid.removeNudges();

        if (!onItself)
            this._grid.nudgeItemsAtIndex(index, dragLocation);

        this._lastDragLocation = dragLocation;
        this._lastIndex = index;

        return DND.DragMotionResult.CONTINUE;
    }

    acceptDrop(source, _actor, x, y) {
        this._grid.removeNudges();

        if (!this._canAccept(source))
            return false;

        let [index] = this.canDropAt(x, y);

        this.moveItem(source, index);

        return true;
    }

    get gridActor() {
        return this._grid;
    }

    canDropAt(x, y) {
        return this._grid.canDropAt(x, y);
    }

    nudgeItemsAtIndex(index, dragLocation) {
        this._grid.nudgeItemsAtIndex(index, dragLocation);
    }

    removeNudges() {
        this._grid.removeNudges();
    }

    get id() {
        return this._id;
    }
}
Signals.addSignalMethods(BaseAppView.prototype);

var AllViewContainer = GObject.registerClass(
class AllViewContainer extends St.Widget {
    _init(gridActor, params) {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });

        params = Params.parse(params, { allowScrolling: true });

        this.gridActor = gridActor;

        gridActor.y_expand = true;
        gridActor.y_align = Clutter.ActorAlign.START;

        this.scrollView = new St.ScrollView({
            style_class: 'all-apps-scroller',
            x_expand: true,
            y_expand: true,
            x_fill: true,
            y_fill: false,
            reactive: true,
            reactive: params.allowScrolling,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            y_align: Clutter.ActorAlign.START,
        });

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
    constructor(params = {}) {
        super({ usePagination: true },
              { minRows: EOS_DESKTOP_MIN_ROWS });
        this.actor = new AllViewContainer(this._grid, params);
        this._scrollView = this.actor.scrollView;
        this._stack = this.actor.stack;
        this._stackBox = this.actor.stackBox;

        this._id = IconGridLayout.DESKTOP_GRID_ID;

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
        this._currentPopupDestroyId = 0;

        this._availWidth = 0;
        this._availHeight = 0;

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
        this._iconGridLayout.connect('changed', () => {
            Main.queueDeferredWork(this._redisplayWorkId);
        });
        global.settings.connect('changed::' + EOS_ENABLE_APP_CENTER_KEY, () => {
            Main.queueDeferredWork(this._redisplayWorkId);
        });

        Main.overview.connect('item-drag-begin', this._onDragBegin.bind(this));
        Main.overview.connect('item-drag-end', this._onDragEnd.bind(this));

        this._nEventBlockerInhibits = 0;
    }

    getAppInfos() {
        return this._appInfoList;
    }

    _loadApps() {
        let newApps = [];
        let items = [];

        let desktopIds = this._iconGridLayout.getIcons(IconGridLayout.DESKTOP_GRID_ID);

        for (let idx in desktopIds) {
            let itemId = desktopIds[idx];
            items.push(itemId);
        }

        let appSys = Shell.AppSystem.get_default();

        this.folderIcons = [];

        // Allow dragging of the icon only if the Dash would accept a drop to
        // change favorite-apps. There are no other possible drop targets from
        // the app picker, so there's no other need for a drag to start,
        // at least on single-monitor setups.
        // This also disables drag-to-launch on multi-monitor setups,
        // but we hope that is not used much.
        let favoritesWritable = global.settings.is_writable('favorite-apps');

        items.forEach((itemId) => {
            let icon = null;

            if (this._iconGridLayout.iconIsFolder(itemId)) {
                icon = this._items[itemId];
                if (!icon) {
                    let item = Shell.DesktopDirInfo.new(itemId);
                    icon = new FolderIcon(item, this);
                } else {
                    icon.update();
                }
                this.folderIcons.push(icon);
            } else {
                let app = appSys.lookup_app(itemId);
                if (!app)
                    return;

                icon = new AppIcon(app, {
                    isDraggable: favoritesWritable,
                });
            }

            newApps.push(icon);
        });

        // Add the App Center icon if it is enabled (and installed)
        this._maybeAddAppCenterIcon(newApps);

        return newApps;
    }

    _maybeAddAppCenterIcon(apps) {
        if (!global.settings.get_boolean(EOS_ENABLE_APP_CENTER_KEY))
            return;

        let appSys = Shell.AppSystem.get_default();
        if (!appSys.lookup_app(EOS_APP_CENTER_ID)) {
            log('App center ' + EOS_APP_CENTER_ID + ' is not installed');
            return;
        }

        if (!this._appCenterIcon)
            this._appCenterIcon = new AppCenterIcon();

        apps.push(this._appCenterIcon);
    }

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
            this._currentPopup.actor.ease({
                opacity: 0,
                duration: VIEWS_SWITCH_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => (this.opacity = 255)
            });

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

        if (!this.actor.mapped) {
            this._adjustment.value = this._grid.getPageY(pageNumber);
            this._pageIndicators.setCurrentPage(pageNumber);
            this._grid.currentPage = pageNumber;
            return;
        }

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
            let minVelocity = totalHeight / PAGE_SWITCH_TIME;
            velocity = Math.max(minVelocity, velocity);
            time = diffToPage / velocity;
        } else {
            time = PAGE_SWITCH_TIME * diffToPage / totalHeight;
        }
        // When changing more than one page, make sure to not take
        // longer than PAGE_SWITCH_TIME
        time = Math.min(time, PAGE_SWITCH_TIME);

        this._grid.currentPage = pageNumber;
        this._adjustment.ease(this._grid.getPageY(pageNumber), {
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            duration: time
        });

        this._pageIndicators.setCurrentPage(pageNumber);
    }

    _diffToPage(pageNumber) {
        let currentScrollPosition = this._adjustment.value;
        return Math.abs(currentScrollPosition - this._grid.getPageY(pageNumber));
    }

    openSpaceForPopup(item, side, nRows) {
        this._updateIconOpacities(true);
        this._displayingPopup = true;
        this._eventBlocker.reactive = true;
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
        let [dist_, dx_, dy] = action.get_motion_delta(0);
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

    addFolderPopup(popup) {
        this._stack.add_actor(popup.actor);
        popup.connect('open-state-changed', (popup, isOpen) => {
            this._eventBlocker.reactive = isOpen;

            if (this._currentPopup) {
                this._currentPopup.actor.disconnect(this._currentPopupDestroyId);
                this._currentPopupDestroyId = 0;
            }

            this._currentPopup = null;

            if (isOpen) {
                this._currentPopup = popup;
                this._currentPopupDestroyId = popup.actor.connect('destroy', () => {
                    this._currentPopup = null;
                    this._currentPopupDestroyId = 0;
                    this._eventBlocker.reactive = false;
                });
            }
            this._updateIconOpacities(isOpen);
            if (!isOpen)
                this._closeSpaceForPopup();
        });
    }

    _childFocused(icon) {
        let itemPage = this._grid.getItemPage(icon);
        this.goToPage(itemPage);
    }

    _updateIconOpacities(folderOpen) {
        for (let id in this._items) {
            let opacity;
            if (folderOpen && !this._items[id].actor.checked)
                opacity =  INACTIVE_GRID_OPACITY;
            else
                opacity = 255;
            this._items[id].actor.ease({
                opacity: opacity,
                duration: INACTIVE_GRID_OPACITY_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
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
            Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
                this._adjustment.value = 0;
                this._grid.currentPage = 0;
                this._pageIndicators.setNPages(this._grid.nPages());
                this._pageIndicators.setCurrentPage(0);
                return GLib.SOURCE_REMOVE;
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

    _handleDragOvershoot(dragEvent) {
        let [, gridY] = this.actor.get_transformed_position();
        let [, gridHeight] = this.actor.get_transformed_size();
        let gridBottom = gridY + gridHeight;

        // Within the grid boundaries, or already animating
        if (dragEvent.y > gridY && dragEvent.y < gridBottom ||
            this._adjustment.get_transition('value') != null) {
            this._grid.removeNudges();
            return;
        }

        // Moving above the grid
        let currentY = this._adjustment.value;
        if (dragEvent.y <= gridY && currentY > 0) {
            this.goToPage(this._grid.currentPage - 1);
            return;
        }

        // Moving below the grid
        let maxY = this._adjustment.upper - this._adjustment.page_size;
        if (dragEvent.y >= gridBottom && currentY < maxY) {
            this.goToPage(this._grid.currentPage + 1);
        }
    }

    _onDragBegin() {
        this._dragMonitor = {
            dragMotion: this._onDragMotion.bind(this)
        };
        DND.addDragMonitor(this._dragMonitor);
    }

    _onDragMotion(dragEvent) {
        let icon = dragEvent.source;

        // Handle the drag overshoot. When dragging to above the
        // icon grid, move to the page above; when dragging below,
        // move to the page below.
        if (this._grid.contains(icon.actor))
            this._handleDragOvershoot(dragEvent);

        return DND.DragMotionResult.CONTINUE;
    }

    _onDragEnd() {
        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
    }

    acceptDrop(source, actor, x, y) {
        if (!super.acceptDrop(source, actor, x, y))
            return false;

        if (this._currentPopup)
            this._currentPopup.popdown();

        return true;
    }

    inhibitEventBlocker() {
        this._nEventBlockerInhibits++;
        this._eventBlocker.visible = this._nEventBlockerInhibits == 0;
    }

    uninhibitEventBlocker() {
        if (this._nEventBlockerInhibits === 0)
            throw new Error('Not inhibited');

        this._nEventBlockerInhibits--;
        this._eventBlocker.visible = this._nEventBlockerInhibits == 0;
    }

    createFolder(apps, iconAtPosition) {
        let appItems = apps.map(id => this._items[id].app);
        let folderName = _findBestFolderName(appItems);

        let newFolderId = this._iconGridLayout.addFolder(folderName,
            iconAtPosition);

        if (!newFolderId)
            return false;

        for (let app of apps)
            this._iconGridLayout.appendIcon(app, newFolderId);

        return true;
    }
};
Signals.addSignalMethods(AllView.prototype);

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

        this.actor = new St.Widget({
            style_class: 'all-apps',
            x_expand: true,
            y_expand: true,
            layout_manager: new Clutter.BinLayout(),
        });

        this.actor.add_actor(this._allView.actor);
        this._showView();
    }

    animate(animationDirection, onComplete) {
        this._allView.animate(animationDirection, onComplete);
    }

    _showView() {
        this._allView.animateSwitch(IconGrid.AnimationDirection.IN);
    }

    selectApp(id) {
        this._showView();
        this._allView.selectApp(id);
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

        this._iconGridLayout = IconGridLayout.getDefault();
        this._systemActions = new SystemActions.getDefault();
    }

    getResultMetas(apps, callback) {
        let metas = [];
        for (let id of apps) {
            if (id.endsWith('.desktop')) {
                let app = this._appSys.lookup_app(id);

                metas.push({
                    id: app.get_id(),
                    name: app.get_name(),
                    createIcon: size => app.create_icon_texture(size),
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

    getInitialResultSet(terms, callback, _cancellable) {
        let query = terms.join(' ');
        let groups = Shell.AppSystem.search(query);
        let usage = Shell.AppUsage.get_default();
        let results = [];
        let replacementMap = {};
        let parentalControlsManager = ParentalControlsManager.getDefault();

        groups.forEach(group => {
            group = group.filter(appID => {
                let app = Gio.DesktopAppInfo.new(appID);
                let isLink = appID.startsWith(EOS_LINK_PREFIX);
                let isOnDesktop = this._iconGridLayout.hasIcon(appID);

                // exclude links that are not part of the desktop grid
                if (!app ||
                    !parentalControlsManager.shouldShowApp(app) ||
                    (isLink && !isOnDesktop))
                    return false;

                if (app && parentalControlsManager.shouldShowApp(app)) {
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
        results = results.sort((a, b) => {
            let hasA = a === EOS_APP_CENTER_ID || this._iconGridLayout.hasIcon(a);
            let hasB = b === EOS_APP_CENTER_ID || this._iconGridLayout.hasIcon(b);

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
    constructor(dirInfo, parentView) {
        super(null, null);

        this._dirInfo = dirInfo;

        this._id = dirInfo.get_id();

        // If it not expand, the parent doesn't take into account its preferred_width when allocating
        // the second time it allocates, so we apply the "Standard hack for ClutterBinLayout"
        this._grid.x_expand = true;
        this._parentView = parentView;
        this._grid._delegate = this;

        this.actor = new St.ScrollView({ overlay_scrollbars: true });
        this.actor.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        let scrollableContainer = new St.BoxLayout({ vertical: true, reactive: true });
        scrollableContainer.add_actor(this._grid);
        this.actor.add_actor(scrollableContainer);

        let action = new Clutter.PanAction({ interpolate: true });
        action.connect('pan', this._onPan.bind(this));
        this.actor.add_action(action);

        this._redisplay();
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

        let numItems = this._allItems.length;
        let rtl = icon.get_text_direction() == Clutter.TextDirection.RTL;
        for (let i = 0; i < 4; i++) {
            let bin = new St.Bin({ width: subSize, height: subSize });
            if (i < numItems)
                bin.child = this._allItems[i].app.create_icon_texture(subSize);
            layout.attach(bin, rtl ? (i + 1) % 2 : i % 2, Math.floor(i / 2), 1, 1);
        }

        return icon;
    }

    _canAccept(source) {
        if (!(source instanceof AppIcon))
            return false;

        return true;
    }

    _onPan(action) {
        let [dist_, dx_, dy] = action.get_motion_delta(0);
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
        // so we have to subtract the required padding etc of the boxpointer
        return [(contentBox.x2 - contentBox.x1) - 2 * this._offsetForEachSide, (contentBox.y2 - contentBox.y1) - 2 * this._offsetForEachSide];
    }

    usedWidth() {
        let [availWidthPerPage] = this._getPageAvailableSize();
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

    _loadApps() {
        let apps = [];
        let appSys = Shell.AppSystem.get_default();
        let addAppId = appId => {
            let app = appSys.lookup_app(appId);
            if (!app)
                return;

            if (!app.get_app_info().should_show())
                return;

            if (apps.some(appIcon => appIcon.id == appId))
                return;

            let icon = new AppIcon(app);
            apps.push(icon);
        };

        let id = this._dirInfo.get_id();
        let folderApps = this._iconGridLayout.getIcons(id);
        folderApps.forEach(addAppId);

        return apps;
    }

    removeApp(app) {
        let id = this._dirInfo.get_id();
        let folderApps = this._iconGridLayout.getIcons(id);

        // Remove the folder if this is the last app icon; otherwise,
        // just remove the icon
        if (folderApps.length == 0) {
            this._iconGridLayout.removeIcon(id);
        } else {
            /* FIXME */
        }

        return true;
    }
};

var ViewIcon = GObject.registerClass(
class ViewIcon extends GObject.Object {
    _init(buttonParams, iconParams) {
        super._init();

        buttonParams = Params.parse(buttonParams, {
            style_class: 'app-well-app',
            pivot_point: new Clutter.Point({ x: 0.5, y: 0.5 }),
            button_mask: St.ButtonMask.ONE |
                         St.ButtonMask.TWO |
                         St.ButtonMask.THREE,
            toggle_mode: false,
            can_focus: true,
            x_fill: true,
            y_fill: true
        }, true);

        iconParams = Params.parse(iconParams, {
            showLabel: true,
        }, true);

        this._iconGridLayout = IconGridLayout.getDefault();

        // Might be changed once the createIcon() method is called.
        this._iconSize = IconGrid.ICON_SIZE;

        this.actor = new St.Button(buttonParams);
        this.actor._delegate = this;
        this.actor.connect('destroy', this._onDestroy.bind(this));

        // Get the isDraggable property without passing it on to the BaseIcon:
        let appIconParams = Params.parse(iconParams, {
            isDraggable: true,
        }, true);
        let isDraggable = appIconParams['isDraggable'];
        delete iconParams['isDraggable'];

        this.icon = new IconGrid.BaseIcon(this.name, iconParams);
        this.actor.label_actor = this.icon.label;

        if (isDraggable) {
            this._draggable = DND.makeDraggable(this.actor);
            this._draggable.connect('drag-begin', () => {
                this._dragging = true;
                this.scaleAndFade();
                this._removeMenuTimeout();
                Main.overview.beginItemDrag(this);
            });
            this._draggable.connect('drag-cancelled', () => {
                this._dragging = false;
                Main.overview.cancelledItemDrag(this);
            });
            this._draggable.connect('drag-end', () => {
                this._dragging = false;
                this.undoScaleAndFade();
                Main.overview.endItemDrag(this);
            });
        }

        this._itemDragBeginId = Main.overview.connect(
            'item-drag-begin', this._onDragBegin.bind(this));
        this._itemDragEndId = Main.overview.connect(
            'item-drag-end', this._onDragEnd.bind(this));
    }

    get id() {
        return this._id;
    }

    get name() {
        return this._name;
    }

    scaleAndFade() {
        this.actor.reactive = false;
        this.actor.ease({
            scale_x: 0.75,
            scale_y: 0.75,
            opacity: 128
        });
    }

    undoScaleAndFade() {
        this.actor.reactive = true;
        this.actor.ease({
            scale_x: 1.0,
            scale_y: 1.0,
            opacity: 255
        });
    }

    _betweenLeeways(x, y) {
        return x >= IconGrid.LEFT_DIVIDER_LEEWAY &&
               x <= this.actor.width - IconGrid.RIGHT_DIVIDER_LEEWAY;
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

    getDragActor() {
        let iconParams = {
            createIcon: this._createIcon.bind(this),
            showLabel: this.icon.label != null,
            setSizeManually: false,
        };

        let icon = new IconGrid.BaseIcon(this.name, iconParams);
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
    Signals: {
        'apps-changed': {},
     },
}, class FolderIcon extends ViewIcon {
    _init(dirInfo, parentView) {
        let buttonParams = {
            button_mask: St.ButtonMask.ONE,
            toggle_mode: true,
        };
        let iconParams = {
            isDraggable: true,
            createIcon: this._createIcon.bind(this),
            setSizeManually: false,
        };
        this._parentView = parentView;

        this._name = dirInfo.get_name();
        this._id = dirInfo.get_id();
        this._dirInfo = dirInfo;

        super._init(buttonParams, iconParams);
        this.actor.add_style_class_name('app-folder');

        this._iconContainer = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._iconContainer.add_child(this.icon);

        this.actor.set_child(this._iconContainer);
        this.actor.label_actor = this.icon.label;

        this.view = new FolderView(this._dirInfo, parentView);

        // whether we need to update arrow side, position etc.
        this._popupInvalidated = false;
        this._popupTimeoutId = 0;

        this.actor.connect('leave-event', this._onLeaveEvent.bind(this));
        this.actor.connect('button-press-event', this._onButtonPress.bind(this));
        this.actor.connect('touch-event', this._onTouchEvent.bind(this));
        this.actor.connect('popup-menu', this._popupRenamePopup.bind(this));

        this.actor.connect('clicked', this.open.bind(this));
        this.actor.connect('destroy', this.onDestroy.bind(this));
        this.actor.connect('notify::mapped', () => {
            if (!this.actor.mapped && this._popup)
                this._popup.popdown();
        });

        this._redisplay();
    }

    onDestroy() {
        Main.overview.disconnect(this._itemDragBeginId);
        Main.overview.disconnect(this._itemDragEndId);

        this.view.actor.destroy();

        if (this._spaceReadySignalId) {
            this._parentView.disconnect(this._spaceReadySignalId);
            this._spaceReadySignalId = 0;
        }

        if (this._popup)
            this._popup.actor.destroy();

        this._removeMenuTimeout();
    }

    open() {
        this._removeMenuTimeout();
        this._ensurePopup();
        this.view.actor.vscroll.adjustment.value = 0;
        this._openSpaceForPopup();
    }

    _onDragBegin() {
        this._dragMonitor = {
            dragMotion: this._onDragMotion.bind(this),
        };
        DND.addDragMonitor(this._dragMonitor);

        this._parentView.inhibitEventBlocker();
    }

    _onDragMotion(dragEvent) {
        let target = dragEvent.targetActor;

        if (!this.actor.contains(target) || !this._canAccept(dragEvent.source))
            this.actor.remove_style_pseudo_class('drop');
        else
            this.actor.add_style_pseudo_class('drop');

        return DND.DragMotionResult.CONTINUE;
    }

    _onDragEnd() {
        this.actor.remove_style_pseudo_class('drop');
        this._parentView.uninhibitEventBlocker();
        DND.removeDragMonitor(this._dragMonitor);
        this._dragMonitor = null;
    }

    _canAccept(source) {
        if (!(source instanceof AppIcon))
            return false;

        let view = _getViewFromIcon(source);
        if (!view || !(view instanceof AllView))
            return false;

        let folderApps = this._iconGridLayout.getIcons(source.id);
        if (folderApps.includes(source.id))
            return false;

        return true;
    }

    handleDragOver(source, _actor, x, y) {
        if (!this._canAccept(source))
            return DND.DragMotionResult.CONTINUE;

        if (!this._betweenLeeways(x, y))
            return DND.DragMotionResult.CONTINUE;

        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source) {
        if (!this._canAccept(source))
            return false;

        let app = source.app;
        this._iconGridLayout.appendIcon(app.id, this.id);

        this._redisplay();
        this.view._redisplay();

        return true;
    }

    _updateName() {
        let name = this._dirInfo.get_name();
        if (this._name == name)
            return;

        this._name = name;
        this.icon.label.text = this._name;
    }

    _redisplay() {
        this._updateName();
        this.view._redisplay();
        this.actor.visible = this.view.getAllItems().length > 0;
        this.icon.update();
        this.emit('apps-changed');
    }

    update() {
        this._redisplay();
    }

    _createIcon(iconSize) {
        return this.view.createFolderIcon(iconSize, this);
    }

    _popupHeight() {
        let usedHeight = this.view.usedHeight() + this._popup.getOffset(St.Side.TOP) + this._popup.getOffset(St.Side.BOTTOM);
        return usedHeight;
    }

    _openSpaceForPopup() {
        this._spaceReadySignalId = this._parentView.connect('space-ready', () => {
            this._parentView.disconnect(this._spaceReadySignalId);
            this._spaceReadySignalId = 0;
            this._popup.popup();
            this._updatePopupPosition();
        });
        this._parentView.openSpaceForPopup(this, this._boxPointerArrowside, this.view.nRowsDisplayedAtOnce());
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

    _removeMenuTimeout() {
        if (this._popupTimeoutId > 0) {
            GLib.source_remove(this._popupTimeoutId);
            this._popupTimeoutId = 0;
        }
    }

    _setPopupTimeout() {
        this._removeMenuTimeout();
        this._popupTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MENU_POPUP_TIMEOUT, () => {
            this._popupTimeoutId = 0;
            this._popupRenamePopup();
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._popupTimeoutId,
                                   '[gnome-shell] this._popupRenamePopup');
    }

    _onLeaveEvent(_actor, _event) {
        this.actor.fake_release();
        this._removeMenuTimeout();
    }

    _onButtonPress(_actor, event) {
        let button = event.get_button();
        if (button == 1) {
            this._setPopupTimeout();
        } else if (button == 3) {
            this._popupRenamePopup();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onTouchEvent(actor, event) {
        if (event.type() == Clutter.EventType.TOUCH_BEGIN)
            this._setPopupTimeout();

        return Clutter.EVENT_PROPAGATE;
    }

    _popupRenamePopup() {
        this._removeMenuTimeout();
        this.actor.fake_release();

        if (!this._menu) {
            this._menuManager = new PopupMenu.PopupMenuManager(this.actor);

            this._menu = new RenameFolderMenu(this, this._dirInfo);
            this._menuManager.addMenu(this._menu);

            this._menu.connect('open-state-changed', (menu, isPoppedUp) => {
                if (!isPoppedUp)
                    this.actor.sync_hover();
                this._updateName();
            });
            let id = Main.overview.connect('hiding', () => {
                this._menu.close();
            });
            this.actor.connect('destroy', () => {
                Main.overview.disconnect(id);
            });
        }

        this.actor.set_hover(true);
        this._menu.open();
        this._menuManager.ignoreRelease();
    }

    adaptToSize(width, height) {
        this._parentAvailableWidth = width;
        this._parentAvailableHeight = height;
        if (this._popup)
            this.view.adaptToSize(width, height);
        this._popupInvalidated = true;
    }
});

var RenameFolderMenuItem = GObject.registerClass(
class RenameFolderMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init(dirInfo) {
        super._init({
            style_class: 'rename-folder-popup-item',
            reactive: false,
        });
        this.setOrnament(PopupMenu.Ornament.HIDDEN);

        this._dirInfo = dirInfo;

        // Entry
        this._entry = new St.Entry({
            x_expand: true,
            width: 200,
        });
        this.add_child(this._entry);

        this._entry.clutter_text.connect(
            'notify::text', this._validate.bind(this));
        this._entry.clutter_text.connect(
            'activate', this._updateFolderName.bind(this));

        // Rename button
        this._button = new St.Button({
            style_class: 'button',
            reactive: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
            can_focus: true,
            label: _('Rename'),
        });
        this.add_child(this._button);

        this._button.connect('clicked', this._updateFolderName.bind(this));
    }

    vfunc_map() {
        this._entry.text = this._dirInfo.get_name();
        this._entry.clutter_text.set_selection(0, -1);
        super.vfunc_map();
    }

    vfunc_key_focus_in() {
        super.vfunc_key_focus_in();
        this._entry.clutter_text.grab_key_focus();
    }

    _isValidFolderName() {
        let folderName = this._dirInfo.get_name();
        let newFolderName = this._entry.text.trim();

        return newFolderName.length > 0 && newFolderName != folderName;
    }

    _validate() {
        let isValid = this._isValidFolderName();

        this._button.reactive = isValid;
    }

    _updateFolderName() {
        if (!this._isValidFolderName())
            return;

        let newFolderName = this._entry.text.trim();
        this._dirInfo.create_custom_with_name(newFolderName);
        this.activate(Clutter.get_current_event());
    }
});

var RenameFolderMenu = class RenameFolderMenu extends PopupMenu.PopupMenu {
    constructor(source, folder) {
        super(source.actor, 0.5, St.Side.BOTTOM);
        this.actor.add_style_class_name('rename-folder-popup');

        this._iconGridLayout = IconGridLayout.getDefault();

        // We want to keep the item hovered while the menu is up
        this.blockSourceEvents = true;

        let menuItem = new RenameFolderMenuItem(folder);
        this.addMenuItem(menuItem);

        // Focus the text entry on menu pop-up
        this.focusActor = menuItem;

        // Chain our visibility and lifecycle to that of the source
        this._sourceMappedId = source.actor.connect('notify::mapped', () => {
            if (!source.actor.mapped)
                this.close();
        });
        source.actor.connect('destroy', () => {
            source.actor.disconnect(this._sourceMappedId);
            this.destroy();
        });

        // Separator
        let separator = new PopupMenu.PopupSeparatorMenuItem();
        this.addMenuItem(separator);

        // Add the "Remove from desktop" menu item at the end.
        let item = new PopupMenu.PopupMenuItem(_("Remove from desktop"));
        this.addMenuItem(item);
        item.connect('activate', () => {
            this._iconGridLayout.removeIcon(source.id, true);
        });

        Main.uiGroup.add_actor(this.actor);
    }
};
Signals.addSignalMethods(RenameFolderMenu.prototype);

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

        this._boxPointer.style_class = 'app-folder-popup';
        this.actor.add_actor(this._boxPointer);
        this._boxPointer.bin.set_child(this._view.actor);

        this.closeButton = Util.makeCloseButton(this._boxPointer);
        this.closeButton.connect('clicked', this.popdown.bind(this));
        this.actor.add_actor(this.closeButton);

        this._boxPointer.bind_property('opacity', this.closeButton, 'opacity',
                                       GObject.BindingFlags.SYNC_CREATE);

        global.focus_manager.add_group(this.actor);

        this._grabHelper = new GrabHelper.GrabHelper(this.actor, {
            actionMode: Shell.ActionMode.POPUP
        });
        this._grabHelper.addActor(Main.layoutManager.overviewGroup);
        this.actor.connect('key-press-event', this._onKeyPress.bind(this));
        this.actor.connect('destroy', this._onDestroy.bind(this));
    }

    _onDestroy() {
        if (this._isOpen) {
            this._isOpen = false;
            this._grabHelper.ungrab({ actor: this.actor });
            this._grabHelper = null;
        }
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
            direction = isLtr
                ? St.DirectionType.TAB_FORWARD
                : St.DirectionType.TAB_BACKWARD;
            break;
        case Clutter.Up:
            direction = St.DirectionType.TAB_BACKWARD;
            break;
        case Clutter.Left:
            direction = isLtr
                ? St.DirectionType.TAB_BACKWARD
                : St.DirectionType.TAB_FORWARD;
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
    Signals: {
        'menu-state-changed': { param_types: [GObject.TYPE_BOOLEAN] },
        'sync-tooltip': {},
    },
}, class AppDisplayIcon extends ViewIcon {
    _init(app, iconParams = {}) {
        this.app = app;
        this._id = app.get_id();
        this._name = app.get_name();

        let buttonParams = { button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO };
        iconParams = Params.parse(iconParams, {
            createIcon: this._createIcon.bind(this),
            createExtraIcons: this._createExtraIcons.bind(this),
        }, true);

        // Get the showMenu property without passing it on to the BaseIcon:
        let appIconParams = Params.parse(iconParams, { showMenu: true }, true);

        this._showMenu = appIconParams['showMenu'];
        delete iconParams['showMenu'];

        super._init(buttonParams, iconParams);

        this._dot = new St.Widget({ style_class: 'app-well-app-running-dot',
                                    layout_manager: new Clutter.BinLayout(),
                                    x_expand: true, y_expand: true,
                                    x_align: Clutter.ActorAlign.CENTER,
                                    y_align: Clutter.ActorAlign.END });

        this._iconContainer = new St.Widget({ layout_manager: new Clutter.BinLayout(),
                                              x_expand: true, y_expand: true });
        this._iconContainer.add_child(this.icon);

        this.actor.set_child(this._iconContainer);
        this._iconContainer.add_child(this._dot);

        this._hasDndHover = false;
        this._folderPreviewId = 0;

        this.actor.connect('leave-event', this._onLeaveEvent.bind(this));
        this.actor.connect('button-press-event', this._onButtonPress.bind(this));
        this.actor.connect('touch-event', this._onTouchEvent.bind(this));
        this.actor.connect('clicked', this._onClicked.bind(this));
        this.actor.connect('popup-menu', this._onKeyboardPopupMenu.bind(this));

        this._menu = null;
        this._menuManager = new PopupMenu.PopupMenuManager(this.actor);

        this.actor.connect('destroy', this._onDestroy.bind(this));

        this._menuTimeoutId = 0;
        this._stateChangedId = this.app.connect('notify::state', () => {
            this._updateRunningStyle();
        });
        this._updateRunningStyle();
    }

    _onDestroy() {
        Main.overview.disconnect(this._itemDragBeginId);
        Main.overview.disconnect(this._itemDragEndId);

        if (this._folderPreviewId > 0) {
            GLib.source_remove(this._folderPreviewId);
            this._folderPreviewId = 0;
        }
        if (this._stateChangedId > 0)
            this.app.disconnect(this._stateChangedId);
        if (this._draggable) {
            if (this._dragging)
                Main.overview.endItemDrag(this);
            this._draggable = null;
        }
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
            GLib.source_remove(this._menuTimeoutId);
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
        this._menuTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MENU_POPUP_TIMEOUT, () => {
            this._menuTimeoutId = 0;
            this.popupMenu();
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._menuTimeoutId, '[gnome-shell] this.popupMenu');
    }

    _onLeaveEvent(_actor, _event) {
        this.actor.fake_release();
        this._removeMenuTimeout();
    }

    _onButtonPress(_actor, event) {
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

        if (!this._showMenu)
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

    animateLaunchAtPos(x, y) {
        this.icon.animateZoomOutAtPos(x, y);
    }

    scaleIn() {
        this.actor.scale_x = 0;
        this.actor.scale_y = 0;

        this.actor.ease({
            scale_x: 1,
            scale_y: 1,
            duration: APP_ICON_SCALE_IN_TIME,
            delay: APP_ICON_SCALE_IN_DELAY,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT
        });
    }

    shellWorkspaceLaunch(params) {
        let { stack } = new Error();
        log(`shellWorkspaceLaunch is deprecated, use app.open_new_window() instead\n${stack}`);

        params = Params.parse(params, { workspace: -1,
                                        timestamp: 0 });

        this.app.open_new_window(params.workspace);
    }

    getDragActor() {
        return this.app.create_icon_texture(this._iconSize);
    }

    shouldShowTooltip() {
        return this.actor.hover && (!this._menu || !this._menu.isOpen);
    }

    _showFolderPreview() {
        this.icon.label.opacity = 0;
        this.icon.icon.ease({
            scale_x: FOLDER_SUBICON_FRACTION,
            scale_y: FOLDER_SUBICON_FRACTION
        });
    }

    _hideFolderPreview() {
        this.icon.label.opacity = 255;
        this.icon.icon.ease({
            scale_x: 1.0,
            scale_y: 1.0
        });
    }

    _canAccept(source) {
        let view = _getViewFromIcon(source);

        return source != this &&
               (source instanceof AppIcon) &&
               (view instanceof AllView);
    }

    _setHoveringByDnd(hovering) {
        if (hovering) {
            if (this._folderPreviewId > 0)
                return;

            this._folderPreviewId =
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                    this.actor.add_style_pseudo_class('drop');
                    this._showFolderPreview();
                    this._folderPreviewId = 0;
                    return GLib.SOURCE_REMOVE;
                });
        } else {
            if (this._folderPreviewId > 0) {
                GLib.source_remove(this._folderPreviewId);
                this._folderPreviewId = 0;
            }
            this._hideFolderPreview();
            this.actor.remove_style_pseudo_class('drop');
        }
    }

    _onDragBegin() {
        this._dragMonitor = {
            dragMotion: this._onDragMotion.bind(this),
        };
        DND.addDragMonitor(this._dragMonitor);
    }

    _onDragMotion(dragEvent) {
        let target = dragEvent.targetActor;
        let isHovering = target == this.actor || this.actor.contains(target);
        let canDrop = this._canAccept(dragEvent.source);
        let hasDndHover = isHovering && canDrop;

        if (this._hasDndHover != hasDndHover) {
            this._setHoveringByDnd(hasDndHover);
            this._hasDndHover = hasDndHover;
        }

        return DND.DragMotionResult.CONTINUE;
    }

    _onDragEnd() {
        this.actor.remove_style_pseudo_class('drop');
        DND.removeDragMonitor(this._dragMonitor);
        this._dragMonitor = null;
    }

    handleDragOver(source, _actor, x, y) {
        if (source == this)
            return DND.DragMotionResult.NO_DROP;

        if (!this._canAccept(source))
            return DND.DragMotionResult.CONTINUE;

        if (!this._betweenLeeways(x, y))
            return DND.DragMotionResult.CONTINUE;

        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source) {
        this._setHoveringByDnd(false);

        if (!this._canAccept(source))
            return false;

        let view = _getViewFromIcon(this);
        let apps = [this.id, source.id];

        return view.createFolder(apps, this.id);
    }
});

var AppIconMenu = class AppIconMenu extends PopupMenu.PopupMenu {
    constructor(source) {
        let side = St.Side.LEFT;
        if (Clutter.get_default_text_direction() == Clutter.TextDirection.RTL)
            side = St.Side.RIGHT;

        super(source.actor, 0.5, side);

        this._iconGridLayout = IconGridLayout.getDefault();

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

        if (windows.length > 0)
            this.addMenuItem(
                /* Translators: This is the heading of a list of open windows */
                new PopupMenu.PopupSeparatorMenuItem(_("Open Windows"))
            );

        windows.forEach(window => {
            let title = window.title
                ? window.title : this._source.app.get_name();
            let item = this._appendMenuItem(title);
            item.connect('activate', () => {
                this.emit('activate-window', window);
            });
        });

        if (!this._source.app.is_window_backed()) {
            this._appendSeparator();

            let appInfo = this._source.app.get_app_info();
            let actions = appInfo.list_actions();
            if (this._source.app.can_open_new_window() &&
                !actions.includes('new-window')) {
                this._newWindowMenuItem = this._appendMenuItem(_("New Window"));
                this._newWindowMenuItem.connect('activate', () => {
                    this._source.animateLaunch();
                    this._source.app.open_new_window(-1);
                    this.emit('activate-window', null);
                });
                this._appendSeparator();
            }

            if (discreteGpuAvailable &&
                this._source.app.state == Shell.AppState.STOPPED &&
                !actions.includes('activate-discrete-gpu')) {
                this._onDiscreteGpuMenuItem = this._appendMenuItem(_("Launch using Dedicated Graphics Card"));
                this._onDiscreteGpuMenuItem.connect('activate', () => {
                    this._source.animateLaunch();
                    this._source.app.launch(0, -1, true);
                    this.emit('activate-window', null);
                });
            }

            for (let i = 0; i < actions.length; i++) {
                let action = actions[i];
                let item = this._appendMenuItem(appInfo.get_action_name(action));
                item.connect('activate', (emitter, event) => {
                    if (action == 'new-window' ||
                        action == 'activate-discrete-gpu')
                        this._source.animateLaunch();

                    this._source.app.launch_action(action, event.get_time(), -1);
                    this.emit('activate-window', null);
                });
            }
        }

        // Add the "Remove from desktop" menu item at the end.
        let item = this._appendMenuItem(_("Remove from desktop"));
        item.connect('activate', () => {
            this._iconGridLayout.removeIcon(this._source.id, true);
        });
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

    popup(_activatingButton) {
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

var AppCenterIcon = GObject.registerClass(
class AppCenterIcon extends AppIcon {
    _init() {
        let viewIconParams = {
            isDraggable: false,
            showMenu: false,
        };

        let iconParams = {
            createIcon: this._createIcon.bind(this),
        };

        let appSys = Shell.AppSystem.get_default();
        let app = appSys.lookup_app(EOS_APP_CENTER_ID);

        super._init(app, viewIconParams, iconParams);

        this._id = EOS_APP_CENTER_ID;
        this._name = this.app.get_generic_name();
    }

    _onDragBegin() {
        super._onDragBegin();

        this.icon.label.text = _("Remove");
        this.icon.update();
    }

    _onDragEnd() {
        super._onDragEnd();

        this.icon.label.text = this.app.get_generic_name();
        this.icon.update();
    }

    _setHoveringByDnd(hovering) {
        this._hovering = hovering;

        this.icon.update();
    }

    _createIcon(iconSize) {
        if (!this._dragMonitor)
            return super._createIcon(iconSize);

        let iconResource = '';
        if (this._hovering)
            iconResource = 'resource:///org/gnome/shell/theme/trash-icon-full.png';
        else
            iconResource = 'resource:///org/gnome/shell/theme/trash-icon-empty.png';

        let gicon = new Gio.FileIcon({
            file: Gio.File.new_for_uri(iconResource),
        });

        return new St.Icon({
            gicon: gicon,
            icon_size: iconSize,
        });
    }

    _canAccept(source) {
        return source instanceof ViewIcon;
    }

    acceptDrop(source) {
        this._setHoveringByDnd(false);

        if (!this._canAccept(source))
            return false;

        this._iconGridLayout.removeIcon(source.id, true);
        return true;
    }
});
