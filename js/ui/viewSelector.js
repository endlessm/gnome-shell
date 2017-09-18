// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Signals = imports.signals;
const Lang = imports.lang;
const Shell = imports.gi.Shell;
const St = imports.gi.St;
const GObject = imports.gi.GObject;

const AppDisplay = imports.ui.appDisplay;
const LayoutManager = imports.ui.layout;
const Main = imports.ui.main;
const Monitor = imports.ui.monitor;
const OverviewControls = imports.ui.overviewControls;
const Params = imports.misc.params;
const Search = imports.ui.search;
const ShellEntry = imports.ui.shellEntry;
const Tweener = imports.ui.tweener;
const WorkspacesView = imports.ui.workspacesView;
const EdgeDragAction = imports.ui.edgeDragAction;
const IconGrid = imports.ui.iconGrid;

const SHELL_KEYBINDINGS_SCHEMA = 'org.gnome.shell.keybindings';
const PINCH_GESTURE_THRESHOLD = 0.7;

const ViewPage = {
    WINDOWS: 1,
    APPS: 2
};

const ViewsDisplayPage = {
    APP_GRID: 1
};

const FocusTrap = new Lang.Class({
    Name: 'FocusTrap',
    Extends: St.Widget,

    vfunc_navigate_focus: function(from, direction) {
        if (direction == Gtk.DirectionType.TAB_FORWARD ||
            direction == Gtk.DirectionType.TAB_BACKWARD)
            return this.parent(from, direction);
        return false;
    }
});

function getTermsForSearchString(searchString) {
    searchString = searchString.replace(/^\s+/g, '').replace(/\s+$/g, '');
    if (searchString == '')
        return [];

    let terms = searchString.split(/\s+/);
    return terms;
}

const TouchpadShowOverviewAction = new Lang.Class({
    Name: 'TouchpadShowOverviewAction',

    _init: function(actor) {
        actor.connect('captured-event', Lang.bind(this, this._handleEvent));
    },

    _handleEvent: function(actor, event) {
        if (event.type() != Clutter.EventType.TOUCHPAD_PINCH)
            return Clutter.EVENT_PROPAGATE;

        if (event.get_touchpad_gesture_finger_count() != 3)
            return Clutter.EVENT_PROPAGATE;

        if (event.get_gesture_phase() == Clutter.TouchpadGesturePhase.END)
            this.emit('activated', event.get_gesture_pinch_scale ());

        return Clutter.EVENT_STOP;
    }
});
Signals.addSignalMethods(TouchpadShowOverviewAction.prototype);

const ShowOverviewAction = new Lang.Class({
    Name: 'ShowOverviewAction',
    Extends: Clutter.GestureAction,
    Signals: { 'activated': { param_types: [GObject.TYPE_DOUBLE] } },

    _init : function() {
        this.parent();
        this.set_n_touch_points(3);

        global.display.connect('grab-op-begin', Lang.bind(this, function() {
            this.cancel();
        }));
    },

    vfunc_gesture_prepare : function(action, actor) {
        return Main.actionMode == Shell.ActionMode.NORMAL &&
               this.get_n_current_points() == this.get_n_touch_points();
    },

    _getBoundingRect : function(motion) {
        let minX, minY, maxX, maxY;

        for (let i = 0; i < this.get_n_current_points(); i++) {
            let x, y;

            if (motion == true) {
                [x, y] = this.get_motion_coords(i);
            } else {
                [x, y] = this.get_press_coords(i);
            }

            if (i == 0) {
                minX = maxX = x;
                minY = maxY = y;
            } else {
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
        }

        return new Meta.Rectangle({ x: minX,
                                    y: minY,
                                    width: maxX - minX,
                                    height: maxY - minY });
    },

    vfunc_gesture_begin : function(action, actor) {
        this._initialRect = this._getBoundingRect(false);
        return true;
    },

    vfunc_gesture_end : function(action, actor) {
        let rect = this._getBoundingRect(true);
        let oldArea = this._initialRect.width * this._initialRect.height;
        let newArea = rect.width * rect.height;
        let areaDiff = newArea / oldArea;

        this.emit('activated', areaDiff);
    }
});

const ViewsDisplayLayout = new Lang.Class({
    Name: 'ViewsDisplayLayout',
    Extends: Clutter.BinLayout,
    Signals: { 'grid-available-size-changed': { param_types: [GObject.TYPE_INT,
                                                              GObject.TYPE_INT] } },

    _init: function(appDisplayActor) {
        this.parent();

        this._appDisplayActor = appDisplayActor;
        this._appDisplayActor.connect('style-changed', Lang.bind(this, this._onStyleChanged));
    },

    _onStyleChanged: function() {
        this.layout_changed();
    },

    vfunc_allocate: function(actor, box, flags) {
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;

        // We want to emit the signal BEFORE any allocation has happened since the
        // icon grid will need to precompute certain values before being able to
        // report a sensible preferred height for the specified width.
        this.emit('grid-available-size-changed', availWidth, availHeight);
        this.parent(actor, box, flags);
    }
});

const ViewsDisplayContainer = new Lang.Class({
    Name: 'ViewsDisplayContainer',
    Extends: St.Widget,

    _init: function(appDisplay) {
        this._appDisplay = appDisplay;
        this._activePage = ViewsDisplayPage.APP_GRID;

        let layoutManager = new ViewsDisplayLayout(this._appDisplay.actor);
        this.parent({ layout_manager: layoutManager,
                      x_expand: true,
                      y_expand: true });

        layoutManager.connect('grid-available-size-changed', Lang.bind(this, this._onGridAvailableSizeChanged));

        this.add_actor(this._appDisplay.actor);
    },

    _onGridAvailableSizeChanged: function(actor, width, height) {
        let box = new Clutter.ActorBox();
        box.x1 = box.y1 = 0;
        box.x2 = width;
        box.y2 = height;
        box = this._appDisplay.actor.get_theme_node().get_content_box(box);
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;

        this._appDisplay.adaptToSize(availWidth, availHeight);
    },

    showPage: function(page) {
        if (this._activePage === page)
            return;

        this._activePage = page;
    },

    getActivePage: function() {
        return this._activePage;
    }
});

const ViewsDisplay = new Lang.Class({
    Name: 'ViewsDisplay',

    _init: function() {
        this._appDisplay = new AppDisplay.AppDisplay()

        this.actor = new ViewsDisplayContainer(this._appDisplay);
    },

    get appDisplay() {
        return this._appDisplay;
    },

    get activeViewsPage() {
        return this.actor.getActivePage();
    }
});

const ViewsDisplayConstraint = new Lang.Class({
    Name: 'ViewsDisplayConstraint',
    Extends: Monitor.MonitorConstraint,

    vfunc_update_allocation: function(actor, actorBox) {
        let originalBox = actorBox.copy();
        this.parent(actor, actorBox);

        actorBox.init_rect(originalBox.get_x(), originalBox.get_y(),
                           actorBox.get_width(), originalBox.get_height());
    }
});

const ViewSelector = new Lang.Class({
    Name: 'ViewSelector',

    _init : function() {
        this.actor = new Shell.Stack({ name: 'viewSelector' });

        this._activePage = null;

        this._workspacesDisplay = new WorkspacesView.WorkspacesDisplay();
        this._workspacesDisplay.connect('empty-space-clicked', Lang.bind(this, this._onEmptySpaceClicked));
        this._workspacesPage = this._addPage(this._workspacesDisplay.actor,
                                             _("Windows"), 'focus-windows-symbolic');

        this._viewsDisplay = new ViewsDisplay();
        this._appsPage = this._addPage(this._viewsDisplay.actor,
                                       _("Applications"), 'view-grid-symbolic');
        this._appsPage.add_constraint(new ViewsDisplayConstraint({ primary: true,
                                                                   work_area: true }));

        this.appDisplay = this._viewsDisplay.appDisplay;

        this._stageKeyPressId = 0;
        Main.overview.connect('showing', Lang.bind(this,
            function () {
                this._stageKeyPressId = global.stage.connect('key-press-event',
                                                             Lang.bind(this, this._onStageKeyPress));
            }));
        Main.overview.connect('hiding', Lang.bind(this,
            function () {
                if (this._stageKeyPressId != 0) {
                    global.stage.disconnect(this._stageKeyPressId);
                    this._stageKeyPressId = 0;
                }
            }));
        Main.overview.connect('shown', Lang.bind(this,
            function() {
                // If we were animating from the desktop view to the
                // apps page the workspace page was visible, allowing
                // the windows to animate, but now we no longer want to
                // show it given that we are now on the apps page or
                // search page.
                if (this._activePage != this._workspacesPage) {
                    this._workspacesPage.opacity = 0;
                    this._workspacesPage.hide();
                }
            }));

        Main.wm.addKeybinding('toggle-application-view',
                              new Gio.Settings({ schema_id: SHELL_KEYBINDINGS_SCHEMA }),
                              Meta.KeyBindingFlags.NONE,
                              Shell.ActionMode.NORMAL |
                              Shell.ActionMode.OVERVIEW,
                              Lang.bind(this, Main.overview.toggleApps));

        Main.wm.addKeybinding('toggle-overview',
                              new Gio.Settings({ schema_id: SHELL_KEYBINDINGS_SCHEMA }),
                              Meta.KeyBindingFlags.NONE,
                              Shell.ActionMode.NORMAL |
                              Shell.ActionMode.OVERVIEW,
                              Lang.bind(Main.overview, Main.overview.toggleWindows));

        let side;
        if (Clutter.get_default_text_direction() == Clutter.TextDirection.RTL)
            side = St.Side.RIGHT;
        else
            side = St.Side.LEFT;
        let gesture = new EdgeDragAction.EdgeDragAction(side,
                                                        Shell.ActionMode.NORMAL);
        gesture.connect('activated', Lang.bind(this, function() {
            if (Main.overview.visible)
                Main.overview.hide();
            else
                this.showApps();
        }));
        global.stage.add_action(gesture);

        gesture = new ShowOverviewAction();
        gesture.connect('activated', Lang.bind(this, this._pinchGestureActivated));
        global.stage.add_action(gesture);

        gesture = new TouchpadShowOverviewAction(global.stage);
        gesture.connect('activated', Lang.bind(this, this._pinchGestureActivated));
    },

    _pinchGestureActivated: function(action, scale) {
        if (scale < PINCH_GESTURE_THRESHOLD)
            Main.overview.show();
    },

    _onEmptySpaceClicked: function() {
        this.setActivePage(ViewPage.APPS);
    },

    showApps: function() {
        Main.overview.show();
    },

    show: function(viewPage) {
        this._activePage = null;
        this._showPage(this._pageFromViewPage(viewPage));
        this._workspacesDisplay.show(true);
    },

    animateFromOverview: function() {
        // Make sure workspace page is fully visible to allow
        // workspace.js do the animation of the windows
        this._workspacesPage.opacity = 255;

        this._workspacesDisplay.animateFromOverview(this._activePage != this._workspacesPage);

        this._showPage(this._workspacesPage);

        if (!this._workspacesDisplay.activeWorkspaceHasMaximizedWindows())
            Main.overview.fadeInDesktop();
    },

    setWorkspacesFullGeometry: function(geom) {
        this._workspacesDisplay.setWorkspacesFullGeometry(geom);
    },

    hide: function() {
        // Nothing to do, since we always show the app selector
    },

    _addPage: function(actor, name, a11yIcon, params) {
        params = Params.parse(params, { a11yFocus: null });

        let page = new St.Bin({ child: actor,
                                x_align: St.Align.START,
                                y_align: St.Align.START,
                                x_fill: true,
                                y_fill: true });
        if (params.a11yFocus)
            Main.ctrlAltTabManager.addGroup(params.a11yFocus, name, a11yIcon);
        else
            Main.ctrlAltTabManager.addGroup(actor, name, a11yIcon,
                                            { proxy: this.actor,
                                              focusCallback: Lang.bind(this,
                                                  function() {
                                                      this._a11yFocusPage(page);
                                                  })
                                            });;
        page.hide();
        this.actor.add_actor(page);
        return page;
    },

    _fadePageIn: function() {
        Tweener.addTween(this._activePage,
                         { opacity: 255,
                           time: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME,
                           transition: 'easeOutQuad'
                         });
    },

    _fadePageOut: function(page) {
        let oldPage = page;
        Tweener.addTween(page,
                         { opacity: 0,
                           time: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME,
                           transition: 'easeOutQuad',
                           onComplete: Lang.bind(this, function() {
                               this._animateIn(oldPage);
                           })
                         });
    },

    _animateIn: function(oldPage) {
        if (oldPage)
            oldPage.hide();

        this.emit('page-empty');

        this._activePage.show();

        if (this._activePage == this._appsPage && oldPage == this._workspacesPage) {
            // Restore opacity, in case we animated via _fadePageOut
            this._activePage.opacity = 255;
            this.appDisplay.animate(IconGrid.AnimationDirection.IN);
        } else {
            this._fadePageIn();
        }
    },

    _animateOut: function(page) {
        let oldPage = page;
        if (page == this._appsPage &&
            this._activePage == this._workspacesPage &&
            !Main.overview.animationInProgress) {
            this.appDisplay.animate(IconGrid.AnimationDirection.OUT, Lang.bind(this,
                function() {
                    this._animateIn(oldPage)
                }));
        } else {
            this._fadePageOut(page);
        }
    },

    _showPage: function(page) {
        if (!Main.overview.visible)
            return;

        if (page == this._activePage)
            return;

        let oldPage = this._activePage;
        this._activePage = page;
        this.emit('page-changed');

        if (oldPage)
            this._animateOut(oldPage)
        else
            this._animateIn();
    },

    _a11yFocusPage: function(page) {
        page.navigate_focus(null, Gtk.DirectionType.TAB_FORWARD, false);
    },

    _onStageKeyPress: function(actor, event) {
        // Ignore events while anything but the overview has
        // pushed a modal (system modals, looking glass, ...)
        if (Main.modalCount > 1)
            return Clutter.EVENT_PROPAGATE;

        let symbol = event.get_key_symbol();

        if (symbol == Clutter.Escape && this._activePage == this._workspacesPage) {
            Main.overview.toggleWindows();
            return Clutter.EVENT_STOP;
        }

        if (!global.stage.key_focus) {
            if (symbol == Clutter.Tab || symbol == Clutter.Down) {
                this._activePage.navigate_focus(null, Gtk.DirectionType.TAB_FORWARD, false);
                return Clutter.EVENT_STOP;
            } else if (symbol == Clutter.ISO_Left_Tab) {
                this._activePage.navigate_focus(null, Gtk.DirectionType.TAB_BACKWARD, false);
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    },

    _pageFromViewPage: function(viewPage) {
        let page;

        if (viewPage == ViewPage.WINDOWS)
            page = this._workspacesPage;
        else
            page = this._appsPage;

        return page;
    },

    getActivePage: function() {
        if (this._activePage == this._workspacesPage)
            return ViewPage.WINDOWS;
        else
            return ViewPage.APPS;
    },

    setActivePage: function(viewPage) {
        this._showPage(this._pageFromViewPage(viewPage));
    },

    fadeIn: function() {
        let actor = this._activePage;
        Tweener.addTween(actor, { opacity: 255,
                                  time: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME / 2,
                                  transition: 'easeInQuad'
                                });
    },

    fadeHalf: function() {
        let actor = this._activePage;
        Tweener.addTween(actor, { opacity: 128,
                                  time: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME / 2,
                                  transition: 'easeOutQuad'
                                });
    }
});
Signals.addSignalMethods(ViewSelector.prototype);
