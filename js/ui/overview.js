// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Meta = imports.gi.Meta;
const Mainloop = imports.mainloop;
const Pango = imports.gi.Pango;
const Signals = imports.signals;
const Lang = imports.lang;
const St = imports.gi.St;
const Shell = imports.gi.Shell;
const Gdk = imports.gi.Gdk;

const Background = imports.ui.background;
const DND = imports.ui.dnd;
const Monitor = imports.ui.monitor;
const Lightbox = imports.ui.lightbox;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const ModalDialog = imports.ui.modalDialog;
const OverviewControls = imports.ui.overviewControls;
const Panel = imports.ui.panel;
const Params = imports.misc.params;
const Tweener = imports.ui.tweener;
const ViewSelector = imports.ui.viewSelector;
const WorkspaceThumbnail = imports.ui.workspaceThumbnail;

// Time for initial animation going into Overview mode
const ANIMATION_TIME = 0.25;

// Must be less than ANIMATION_TIME, since we switch to
// or from the overview completely after ANIMATION_TIME,
// and don't want the shading animation to get cut off
const SHADE_ANIMATION_TIME = .20;

const DND_WINDOW_SWITCH_TIMEOUT = 750;

const OVERVIEW_ACTIVATION_TIMEOUT = 0.5;

const NO_WINDOWS_OPEN_DIALOG_TIMEOUT = 2000; // ms

const ShellInfo = new Lang.Class({
    Name: 'ShellInfo',

    _init: function() {
        this._source = null;
        this._undoCallback = null;
        this._destroyCallback = null;
    },

    _onDestroy: function() {
        if (this._destroyCallback)
            this._destroyCallback();

        this._destroyCallback = null;
    },

    _onUndoClicked: function() {
        if (this._undoCallback)
            this._undoCallback();
        this._undoCallback = null;

        if (this._source)
            this._source.destroy();
    },

    setMessage: function(text, options) {
        options = Params.parse(options, { undoCallback: null,
                                          forFeedback: false,
                                          destroyCallback: null
                                        });

        let undoCallback = options.undoCallback;
        let forFeedback = options.forFeedback;
        let destroyCallback = options.destroyCallback;

        if (this._source == null) {
            this._source = new MessageTray.SystemNotificationSource();
            this._source.connect('destroy', Lang.bind(this,
                function() {
                    this._source = null;
                }));
            Main.messageTray.add(this._source);
        }

        let notification = null;
        if (this._source.notifications.length == 0) {
            notification = new MessageTray.Notification(this._source, text, null);
            notification.setTransient(true);
            notification.setForFeedback(forFeedback);
        } else {
            // as we reuse the notification, ensure that the previous _destroyCallback() is called
            if (this._destroyCallback)
                this._destroyCallback();

            notification = this._source.notifications[0];
            notification.update(text, null, { clear: true });
        }

        this._destroyCallback = destroyCallback;
        notification.connect('destroy', Lang.bind(this, this._onDestroy));

        this._undoCallback = undoCallback;
        if (undoCallback)
            notification.addAction(_("Undo"), Lang.bind(this, this._onUndoClicked));

        this._source.notify(notification);
    }
});

const NoWindowsDialog = new Lang.Class({
    Name: 'NoWindowsDialog',
    Extends: ModalDialog.ModalDialog,

    _init: function() {
        this.parent({ styleClass: 'prompt-dialog',
                      shellReactive: true,
                      destroyOnClose: false });

        this._timeoutId = 0;

        let descriptionLabel = new St.Label({ style_class: 'prompt-dialog-headline headline',
                                              text: _('No apps are open') });
        descriptionLabel.clutter_text.line_wrap = true;
        descriptionLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        this.contentLayout.add(descriptionLabel,
                               { x_fill: false,
                                 y_fill: false,
                                 x_align: St.Align.MIDDLE,
                                 y_align: St.Align.MIDDLE });

        this._group.connect('key-press-event', Lang.bind(this, function(event) {
            this.close(global.get_current_time());
            return Clutter.EVENT_PROPAGATE;
        }));
    },

    show: function() {
        if (this._timeoutId != 0)
            Mainloop.source_remove(this._timeoutId);

        this._timeoutId =
            Mainloop.timeout_add(NO_WINDOWS_OPEN_DIALOG_TIMEOUT, Lang.bind(this, function() {
                this.hide();
                return GLib.SOURCE_REMOVE;
            }));
        this.open(global.get_current_time());
    },

    hide: function() {
        if (this._timeoutId != 0) {
            Mainloop.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this.close(global.get_current_time());
    },
});

const Overview = new Lang.Class({
    Name: 'Overview',

    _init: function() {
        this._overviewCreated = false;
        this._initCalled = false;

        Main.sessionMode.connect('updated', Lang.bind(this, this._sessionUpdated));
        this._sessionUpdated();
        this._noWindowsDialog = new NoWindowsDialog();
    },

    _createOverview: function() {
        if (this._overviewCreated)
            return;

        if (this.isDummy)
            return;

        this._overviewCreated = true;

        // this._allMonitorsGroup is a simple actor that covers all monitors,
        // used to install actions that apply to all monitors
        this._allMonitorsGroup = new Clutter.Actor({ reactive: true });
        this._allMonitorsGroup.add_constraint(
            new Clutter.BindConstraint({ source: Main.layoutManager.overviewGroup,
                                         coordinate: Clutter.BindCoordinate.ALL }));

        this._overview = new St.BoxLayout({ name: 'overview',
                                            /* Translators: This is the main view to select
                                               activities. See also note for "Activities" string. */
                                            accessible_name: _("Overview"),
                                            reactive: true,
                                            vertical: true });
        this._overview.add_constraint(new Monitor.MonitorConstraint({ primary: true }));
        this._overview._delegate = this;
        this._allMonitorsGroup.add_actor(this._overview);

        // The main Background actors are inside global.window_group which are
        // hidden when displaying the overview, so we create a new
        // one. Instances of this class share a single CoglTexture behind the
        // scenes which allows us to show the background with different
        // rendering options without duplicating the texture data.
        this._backgroundGroup = new Meta.BackgroundGroup({ reactive: true });
        Main.layoutManager.overviewGroup.add_child(this._backgroundGroup);
        this._bgManagers = [];

        this._desktopFade = new St.Widget();
        Main.layoutManager.overviewGroup.add_child(this._desktopFade);

        this._activationTime = 0;

        this.visible = false;           // animating to overview, in overview, animating out
        this._shown = false;            // show() and not hide()
        this._toggleToHidden = false;   // Whether to hide the overview when either toggle function is called
        this._targetPage = null;        // do we have a target page to animate to?
        this._modal = false;            // have a modal grab
        this.animationInProgress = false;
        this.visibleTarget = false;

        // During transitions, we raise this to the top to avoid having the overview
        // area be reactive; it causes too many issues such as double clicks on
        // Dash elements, or mouseover handlers in the workspaces.
        this._coverPane = new Clutter.Actor({ opacity: 0,
                                              reactive: true });
        Main.layoutManager.overviewGroup.add_child(this._coverPane);
        this._coverPane.connect('event', Lang.bind(this, function (actor, event) { return Clutter.EVENT_STOP; }));

        Main.layoutManager.overviewGroup.add_child(this._allMonitorsGroup);

        this._coverPane.hide();

        // XDND
        this._dragMonitor = {
            dragMotion: Lang.bind(this, this._onDragMotion)
        };


        Main.layoutManager.overviewGroup.connect('scroll-event',
                                                 Lang.bind(this, this._onScrollEvent));
        Main.xdndHandler.connect('drag-begin', Lang.bind(this, this._onDragBegin));
        Main.xdndHandler.connect('drag-end', Lang.bind(this, this._onDragEnd));

        global.screen.connect('restacked', Lang.bind(this, this._onRestacked));

        this._windowSwitchTimeoutId = 0;
        this._windowSwitchTimestamp = 0;
        this._lastActiveWorkspaceIndex = -1;
        this._lastHoveredWindow = null;
        this._needsFakePointerEvent = false;

        if (this._initCalled)
            this.init();
    },

    _updateBackgrounds: function() {
        for (let i = 0; i < this._bgManagers.length; i++)
            this._bgManagers[i].destroy();

        this._bgManagers = [];

        for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
            let bgManager = new Background.BackgroundManager({ container: this._backgroundGroup,
                                                               monitorIndex: i });
            this._bgManagers.push(bgManager);
        }
    },

    _sessionUpdated: function() {
        this.isDummy = !Main.sessionMode.hasOverview;
        this._createOverview();
    },

    // The members we construct that are implemented in JS might
    // want to access the overview as Main.overview to connect
    // signal handlers and so forth. So we create them after
    // construction in this init() method.
    init: function() {
        this._initCalled = true;

        if (this.isDummy)
            return;

        this._shellInfo = new ShellInfo();

        // Create controls
        this._controls = new OverviewControls.ControlsManager();
        this.viewSelector = this._controls.viewSelector;

        // Add our same-line elements after the search entry
        this._overview.add(this._controls.actor, { y_fill: true, expand: true });

        // Add a clone of the panel to the overview so spacing and such is
        // automatic
        this._panelGhost = new St.Bin({ child: new Clutter.Clone({ source: Main.panel.actor }),
                                        reactive: false,
                                        opacity: 0 });

        this._overview.add_actor(this._panelGhost);

        this.viewSelector.connect('page-changed', Lang.bind(this, this._onPageChanged));
        Main.layoutManager.connect('startup-complete', Lang.bind(this, this._onStartupCompleted));
        Main.layoutManager.connect('monitors-changed', Lang.bind(this, this._relayout));
        this._relayoutNoHide();
    },

    addSearchProvider: function(provider) {
        this.viewSelector.addSearchProvider(provider);
    },

    removeSearchProvider: function(provider) {
        this.viewSelector.removeSearchProvider(provider);
    },

    //
    // options:
    //  - undoCallback (function): the callback to be called if undo support is needed
    //  - forFeedback (boolean): whether the message is for direct feedback of a user action
    //
    setMessage: function(text, options) {
        if (this.isDummy)
            return;

        this._shellInfo.setMessage(text, options);
    },

    _onPageChanged: function() {
        this._toggleToHidden = false;

        // SideComponent hooks on this signal but can't connect directly to
        // viewSelector since it won't be created at the time the component
        // is enabled, so rely on the overview and re-issue it from here.
        this.emit('page-changed');
    },

    _onDragBegin: function() {
        this._inXdndDrag = true;

        DND.addDragMonitor(this._dragMonitor);
        // Remember the workspace we started from
        this._lastActiveWorkspaceIndex = global.screen.get_active_workspace_index();
    },

    _onDragEnd: function(time) {
        this._inXdndDrag = false;

        // In case the drag was canceled while in the overview
        // we have to go back to where we started and hide
        // the overview
        if (this._shown) {
            global.screen.get_workspace_by_index(this._lastActiveWorkspaceIndex).activate(time);
            this.hide();
        }
        this._resetWindowSwitchTimeout();
        this._lastHoveredWindow = null;
        DND.removeDragMonitor(this._dragMonitor);
        this.endItemDrag();
    },

    _resetWindowSwitchTimeout: function() {
        if (this._windowSwitchTimeoutId != 0) {
            Mainloop.source_remove(this._windowSwitchTimeoutId);
            this._windowSwitchTimeoutId = 0;
            this._needsFakePointerEvent = false;
        }
    },

    _fakePointerEvent: function() {
        let display = Gdk.Display.get_default();
        let deviceManager = display.get_device_manager();
        let pointer = deviceManager.get_client_pointer();
        let [screen, pointerX, pointerY] = pointer.get_position();

        pointer.warp(screen, pointerX, pointerY);
    },

    _onDragMotion: function(dragEvent) {
        let targetIsWindow = dragEvent.targetActor &&
                             dragEvent.targetActor._delegate &&
                             dragEvent.targetActor._delegate.metaWindow &&
                             !(dragEvent.targetActor._delegate instanceof WorkspaceThumbnail.WindowClone);

        this._windowSwitchTimestamp = global.get_current_time();

        if (targetIsWindow &&
            dragEvent.targetActor._delegate.metaWindow == this._lastHoveredWindow)
            return DND.DragMotionResult.CONTINUE;

        this._lastHoveredWindow = null;

        this._resetWindowSwitchTimeout();

        if (targetIsWindow) {
            this._lastHoveredWindow = dragEvent.targetActor._delegate.metaWindow;
            this._windowSwitchTimeoutId = Mainloop.timeout_add(DND_WINDOW_SWITCH_TIMEOUT,
                                            Lang.bind(this, function() {
                                                this._windowSwitchTimeoutId = 0;
                                                this._needsFakePointerEvent = true;
                                                Main.activateWindow(dragEvent.targetActor._delegate.metaWindow,
                                                                    this._windowSwitchTimestamp);
                                                this.hide();
                                                this._lastHoveredWindow = null;
                                                return GLib.SOURCE_REMOVE;
                                            }));
            GLib.Source.set_name_by_id(this._windowSwitchTimeoutId, '[gnome-shell] Main.activateWindow');
        }

        return DND.DragMotionResult.CONTINUE;
    },

    _onScrollEvent: function(actor, event) {
        this.emit('scroll-event', event);
        return Clutter.EVENT_PROPAGATE;
    },

    addAction: function(action, isPrimary) {
        if (this.isDummy)
            return;

        if (isPrimary)
            this._overview.add_action(action);
        else
            this._allMonitorsGroup.add_action(action);
    },

    _getDesktopClone: function() {
        let windows = global.get_window_actors().filter(function(w) {
            return w.meta_window.get_window_type() == Meta.WindowType.DESKTOP;
        });
        if (windows.length == 0)
            return null;

        let window = windows[0];
        let clone = new Clutter.Clone({ source: window,
                                        x: window.x, y: window.y });
        clone.source.connect('destroy', Lang.bind(this, function() {
            clone.destroy();
        }));
        return clone;
    },

    _relayout: function () {
        // To avoid updating the position and size of the workspaces
        // we just hide the overview. The positions will be updated
        // when it is next shown.
        this.hide();

        this._relayoutNoHide();
    },

    _relayoutNoHide: function () {
        let workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);

        this._coverPane.set_position(0, workArea.y);
        this._coverPane.set_size(workArea.width, workArea.height);

        this._updateBackgrounds();
    },

    _onRestacked: function() {
        let stack = global.get_window_actors();
        let stackIndices = {};

        for (let i = 0; i < stack.length; i++) {
            // Use the stable sequence for an integer to use as a hash key
            stackIndices[stack[i].get_meta_window().get_stable_sequence()] = i;
        }

        this.emit('windows-restacked', stackIndices);
    },

    beginItemDrag: function(source) {
        this.emit('item-drag-begin');
        this._inDrag = true;
    },

    cancelledItemDrag: function(source) {
        this.emit('item-drag-cancelled');
    },

    endItemDrag: function(source) {
        this.emit('item-drag-end');
        this._inDrag = false;
    },

    beginWindowDrag: function(window) {
        this.emit('window-drag-begin', window);
        this._inDrag = true;
    },

    cancelledWindowDrag: function(window) {
        this.emit('window-drag-cancelled', window);
    },

    endWindowDrag: function(window) {
        this.emit('window-drag-end', window);
        this._inDrag = false;
    },

    focusSearch: function() {
        this.show();
        this.viewSelector.focusSearch();
    },

    _onStartupCompleted: function() {
        if (this.isDummy)
            return;

        if (Main.workspaceMonitor.hasActiveWindows)
            return;

        this._showOrSwitchPage(ViewSelector.ViewPage.APPS);
    },

    _showOrSwitchPage: function(page) {
        if (this.visible) {
            this.viewSelector.setActivePage(page);
        } else {
            this._targetPage = page;
            this.show();
        }
    },

    showApps: function() {
        if (this.isDummy)
            return;

        this._showOrSwitchPage(ViewSelector.ViewPage.APPS);
    },

    showWindows: function() {
        if (this.isDummy)
            return;

        this._showOrSwitchPage(ViewSelector.ViewPage.WINDOWS);
    },

    fadeInDesktop: function() {
            this._desktopFade.opacity = 0;
            this._desktopFade.show();
            Tweener.addTween(this._desktopFade,
                             { opacity: 255,
                               time: ANIMATION_TIME,
                               transition: 'easeOutQuad' });
    },

    fadeOutDesktop: function() {
        if (!this._desktopFade.get_n_children()) {
            let clone = this._getDesktopClone();
            if (!clone)
                return;

            this._desktopFade.add_child(clone);
        }

        this._desktopFade.opacity = 255;
        this._desktopFade.show();
        Tweener.addTween(this._desktopFade,
                         { opacity: 0,
                           time: ANIMATION_TIME,
                           transition: 'easeOutQuad'
                         });
    },

    toggleApps: function() {
        if (this.isDummy)
            return;

        if (!this.visible ||
            this.viewSelector.getActivePage() !== ViewSelector.ViewPage.APPS) {
            this.showApps();
            return;
        }

        if (!Main.workspaceMonitor.hasActiveWindows) {
            this._noWindowsDialog.show();
            return;
        }

        if (!Main.workspaceMonitor.hasVisibleWindows) {
            // There are active windows but all of them are hidden, so activate
            // the most recently used one before hiding the overview.
            let appSystem = Shell.AppSystem.get_default();
            let runningApps = appSystem.get_running();
            if (runningApps.length > 0)
                runningApps[0].activate();
        }

        // Toggle to the currently open window
        this.hide();
    },

    toggleWindows: function() {
        if (this.isDummy)
            return;

        if (!this.visible) {
            this.showWindows();
            return;
        }

        if (!Main.workspaceMonitor.hasActiveWindows) {
            this._noWindowsDialog.show();
            return;
        }
        if (this.viewSelector.getActivePage() !== ViewSelector.ViewPage.WINDOWS) {
            this.showWindows();
            return;
        }

        if (!this._toggleToHidden) {
            this.showApps();
            return;
        }

        if (!Main.workspaceMonitor.hasVisibleWindows) {
            // There are active windows but all of them are
            // hidden, so we get back to show the icons grid.
            this.showApps();
            return;
        }

        // Toggle to the currently open window
        this.hide();
    },

    // Checks if the Activities button is currently sensitive to
    // clicks. The first call to this function within the
    // OVERVIEW_ACTIVATION_TIMEOUT time of the hot corner being
    // triggered will return false. This avoids opening and closing
    // the overview if the user both triggered the hot corner and
    // clicked the Activities button.
    shouldToggleByCornerOrButton: function() {
        if (this.animationInProgress)
            return false;
        if (this._inDrag)
            return false;
        if (this._activationTime == 0 || Date.now() / 1000 - this._activationTime > OVERVIEW_ACTIVATION_TIMEOUT)
            return true;
        return false;
    },

    _syncGrab: function() {
        // We delay grab changes during animation so that when removing the
        // overview we don't have a problem with the release of a press/release
        // going to an application.
        if (this.animationInProgress)
            return true;

        if (this._shown) {
            let shouldBeModal = !this._inXdndDrag;
            if (shouldBeModal) {
                if (!this._modal) {
                    if (Main.pushModal(this._overview,
                                       { actionMode: Shell.ActionMode.OVERVIEW })) {
                        this._modal = true;
                    } else {
                        this.hide();
                        return false;
                    }
                }
            }
        } else {
            if (this._modal) {
                Main.popModal(this._overview);
                this._modal = false;
            }
        }
        return true;
    },

    // show:
    //
    // Animates the overview visible and grabs mouse and keyboard input
    show: function() {
        if (this.isDummy)
            return;
        if (this._shown)
            return;
        this._shown = true;

        if (!this._syncGrab())
            return;

        Main.layoutManager.showOverview();
        this._animateVisible();
    },


    _animateVisible: function() {
        if (this.visible || this.animationInProgress)
            return;

        this.visible = true;
        this.animationInProgress = true;
        this.visibleTarget = true;
        this._activationTime = Date.now() / 1000;

        Meta.disable_unredirect_for_screen(global.screen);

        if (!this._targetPage)
            this._targetPage = ViewSelector.ViewPage.WINDOWS;

        this.viewSelector.show(this._targetPage);
        this._targetPage = null;

        // Since the overview is just becoming visible, we should toggle back
        // the hidden state
        this._toggleToHidden = true;

        this._overview.opacity = 0;
        Tweener.addTween(this._overview,
                         { opacity: 255,
                           transition: 'easeOutQuad',
                           time: ANIMATION_TIME,
                           onComplete: this._showDone,
                           onCompleteScope: this
                         });
        this._coverPane.raise_top();
        this._coverPane.show();
        this.emit('showing');
    },

    _showDone: function() {
        this.animationInProgress = false;
        this._desktopFade.hide();
        this._coverPane.hide();

        this.emit('shown');
        // Handle any calls to hide* while we were showing
        if (!this._shown)
            this._animateNotVisible();

        this._syncGrab();
        global.sync_pointer();
    },

    // hide:
    //
    // Reverses the effect of show()
    hide: function() {
        if (this.isDummy)
            return;

        if (!this._shown)
            return;

        let event = Clutter.get_current_event();
        if (event) {
            let type = event.type();
            let button = (type == Clutter.EventType.BUTTON_PRESS ||
                          type == Clutter.EventType.BUTTON_RELEASE);
            let ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) != 0;
            if (button && ctrl)
                return;
        }

        this._shown = false;

        // Hide the 'No windows dialog' in case it is open
        this._noWindowsDialog.hide();

        this._animateNotVisible();
        this._syncGrab();
    },


    _animateNotVisible: function() {
        if (!this.visible || this.animationInProgress)
            return;

        this.animationInProgress = true;
        this.visibleTarget = false;

        this.viewSelector.animateFromOverview();

        // Make other elements fade out.
        Tweener.addTween(this._overview,
                         { opacity: 0,
                           transition: 'easeOutQuad',
                           time: ANIMATION_TIME,
                           onComplete: this._hideDone,
                           onCompleteScope: this
                         });

        this._coverPane.raise_top();
        this._coverPane.show();
        this.emit('hiding');
    },

    _hideDone: function() {
        // Re-enable unredirection
        Meta.enable_unredirect_for_screen(global.screen);

        this.viewSelector.hide();
        this._desktopFade.hide();
        this._coverPane.hide();

        this.visible = false;
        this.animationInProgress = false;

        this.emit('hidden');
        // Handle any calls to show* while we were hiding
        if (this._shown)
            this._animateVisible();
        else
            Main.layoutManager.hideOverview();

        this._syncGrab();

        // Fake a pointer event if requested
        if (this._needsFakePointerEvent) {
            this._fakePointerEvent();
            this._needsFakePointerEvent = false;
        }
    },

    toggle: function() {
        if (this.isDummy)
            return;

        if (this.visible)
            this.hide();
        else
            this.show();
    },

    getActivePage: function() {
        return this.viewSelector.getActivePage();
    }
});
Signals.addSignalMethods(Overview.prototype);
