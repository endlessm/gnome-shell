// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Flatpak = imports.gi.Flatpak;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const St = imports.gi.St;

const AppActivation = imports.ui.appActivation;
const Main = imports.ui.main;
const Params = imports.misc.params;
const Tweener = imports.ui.tweener;

const WINDOW_ANIMATION_TIME = 0.25;

const BUTTON_OFFSET_X = 33;
const BUTTON_OFFSET_Y = 40;

const STATE_APP = 0;
const STATE_TOOLBOX = 1;

const _CODING_APPS = [
    // FIXME: this should be extended with a more complex lookup
    'com.endlessm.dinosaurs.en',
    'com.endlessm.hackybird',
    'com.endlessm.hackyballs'
];

function _isCodingApp(flatpakID) {
    return _CODING_APPS.indexOf(flatpakID) != -1;
}

function _createIcon() {
    let iconFile = Gio.File.new_for_uri('resource:///org/gnome/shell/theme/rotate.svg');
    let gicon = new Gio.FileIcon({ file: iconFile });
    let icon = new St.Icon({ style_class: 'view-source-icon',
                             gicon: gicon });
    return icon;
}

// _synchronizeMetaWindowActorGeometries
//
// Synchronize geometry of MetaWindowActor src to dst by
// applying both the physical geometry and maximization state.
function _synchronizeMetaWindowActorGeometries(src, dst) {
    let srcGeometry = src.meta_window.get_frame_rect();
    let dstGeometry = dst.meta_window.get_frame_rect();

    let srcIsMaximized = (src.meta_window.maximized_horizontally &&
                          src.meta_window.maximized_vertically);
    let dstIsMaximized = (dst.meta_window.maximized_horizontally &&
                          dst.meta_window.maximized_vertically);
    let maximizationStateChanged = srcIsMaximized != dstIsMaximized;

    // If we're going to change the maximization state, skip
    // effects on the destination window, since we're synchronizing it
    if (maximizationStateChanged)
        Main.wm.skipNextEffect(dst);

    if (!srcIsMaximized && dstIsMaximized)
        dst.meta_window.unmaximize(Meta.MaximizeFlags.BOTH);

    if (srcIsMaximized && !dstIsMaximized)
        dst.meta_window.maximize(Meta.MaximizeFlags.BOTH);


    if (!srcGeometry.equal(dstGeometry))
        dst.meta_window.move_resize_frame(false,
                                          srcGeometry.x,
                                          srcGeometry.y,
                                          srcGeometry.width,
                                          srcGeometry.height);
}

function _synchronizeViewSourceButtonToRectCorner(button, rect) {
    button.set_position(rect.x + rect.width - BUTTON_OFFSET_X,
                        rect.y + rect.height - BUTTON_OFFSET_Y);
}

function _getViewSourceButtonParams(interactive) {
    return {
        style_class: 'view-source',
        x_fill: true,
        y_fill: true,
        child: _createIcon(),
        reactive: interactive,
        can_focus: interactive,
        track_hover: interactive,
    }
}

function _createViewSourceButtonInRectCorner(rect) {
    let button = new St.Button(_getViewSourceButtonParams(false));
    _synchronizeViewSourceButtonToRectCorner(button, rect);
    return button;
}

function _flipButtonAroundRectCenter(props) {
    let {
        button,
        rect,
        startAngle,
        midpointAngle,
        finishAngle,
        startOpacity,
        finishOpacity,
        opacityDelay,
        onRotationComplete,
        onButtonFadeComplete
    } = props;

    // this API is deprecated but the best option here to
    // animate around a point outside of the actor
    button.rotation_center_y = new Clutter.Vertex({
        x: button.width - (rect.width * 0.5),
        y: button.height * 0.5,
        z: 0
    });
    button.rotation_angle_y = startAngle;
    button.opacity = startOpacity;
    Tweener.addTween(button, {
        rotation_angle_y: midpointAngle,
        time: WINDOW_ANIMATION_TIME * 2,
        transition: 'easeInQuad',
        onComplete: function() {
            Tweener.addTween(button, {
                rotation_angle_y: finishAngle,
                time: WINDOW_ANIMATION_TIME * 2,
                transition: 'easeOutQuad',
                onComplete: function() {
                    if (onRotationComplete)
                        onRotationComplete();
                }
            });
        }
    });
    Tweener.addTween(button, {
        opacity: finishOpacity,
        time: WINDOW_ANIMATION_TIME * 2,
        transition: 'linear',
        delay: opacityDelay,
        onComplete: function() {
            if (onButtonFadeComplete)
                onButtonFadeComplete();
        }
    });
}

var WindowTrackingButton = new Lang.Class({
    Name: 'WindowTrackingButton',
    Extends: St.Button,
    Properties: {
        'window': GObject.ParamSpec.object('window',
                                           '',
                                           '',
                                           GObject.ParamFlags.READWRITE,
                                           Meta.Window),
        'toolbox_window': GObject.ParamSpec.object('toolbox-window',
                                                   '',
                                                   '',
                                                   GObject.ParamFlags.READWRITE,
                                                   Meta.Window)
    },

    _init: function(params) {
        this._toolbox_window = null;
        this._window = null;

        let buttonParams = _getViewSourceButtonParams(true);
        params = Params.parse(params, buttonParams, true);

        this.parent(params);

        this.connect('destroy', this._onDestroy.bind(this));

        // Note that in order to remove this button, you will need to call
        // destroy() from outside this class or use removeChrome from within it.
        Main.layoutManager.addChrome(this);

        // Connect to signals on the window to determine when to move
        // hide, and show the button. Note that WindowTrackingButton is
        // constructed with the primary app window and we listen for signals
        // on that. This is because of the assumption that both the app
        // window and toolbox window are completely synchronized.
        this._windowsRestackedId = Main.overview.connect('windows-restacked',
                                                         this._showIfWindowVisible.bind(this));
        this._overviewHidingId = Main.overview.connect('hiding',
                                                       this._showIfWindowVisible.bind(this));
        this._overviewShowingId = Main.overview.connect('showing',
                                                        this.hide.bind(this));
        this._sessionModeChangedId = Main.sessionMode.connect('updated',
                                                              this._showIfWindowVisible.bind(this));
    },

    _setupWindow: function() {
        this._positionChangedId = this.window.connect('position-changed',
                                                      this._updatePosition.bind(this));
        this._sizeChangedId = this.window.connect('size-changed',
                                                  this._updatePosition.bind(this));
        this._updatePosition();
    },

    _cleanupWindow: function() {
        if (this._positionChangedId) {
            this.window.disconnect(this._positionChangedId);
            this._positionChangedId = 0;
        }

        if (this._sizeChangedId) {
            this.window.disconnect(this._sizeChangedId);
            this._sizeChangedId = 0;
        }
    },

    _onDestroy: function() {
        if (this._windowsRestackedId) {
            Main.overview.disconnect(this._windowsRestackedId);
            this._windowsRestackedId = 0;
        }

        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = 0;
        }

        if (this._overviewHidingId) {
            Main.overview.disconnect(this._overviewHidingId);
            this._overviewHidingId = 0;
        }

        if (this._sessionModeChangedId) {
            Main.sessionMode.disconnect(this._sessionModeChangedId);
            this._sessionModeChangedId = 0;
        }

        this.window = null;

        Main.layoutManager.removeChrome(this);
    },

    // Just fade out and fade the button back in again. This makes it
    // look as though we have two buttons, but in reality we just have
    // one.
    switchAnimation: function(direction) {
        let rect = this.window.get_frame_rect();

        // Start an animation for flipping the main button around the
        // center of the window.
        _flipButtonAroundRectCenter({
            button: this,
            rect: rect,
            startAngle: 0,
            midpointAngle: direction == Gtk.DirectionType.RIGHT ? 90 : -90,
            finishAngle: direction == Gtk.DirectionType.RIGHT ? 180 : -180,
            startOpacity: 255,
            finishOpacity: 0,
            opacityDelay: 0,
            onButtonFadeComplete: () => {
                Tweener.removeTweens(this);
                this.rotation_angle_y = 0;
                // Fade in again once we're done, since
                // we'll need to display this button
                Tweener.addTween(this, {
                    opacity: 255,
                    time: WINDOW_ANIMATION_TIME * 0.5,
                    transition: 'linear',
                    delay: WINDOW_ANIMATION_TIME * 1.5
                });
            }
        });

        // Create a temporary button which we'll use to show a "flip-in"
        // animation along with the incoming window. This is removed as soon
        // as the animation is complete.
        let animationButton = _createViewSourceButtonInRectCorner(rect);
        Main.layoutManager.uiGroup.add_actor(animationButton);

        _flipButtonAroundRectCenter({
            button: animationButton,
            rect: rect,
            startAngle: direction == Gtk.DirectionType.RIGHT ? -180 : 180,
            midpointAngle: direction == Gtk.DirectionType.RIGHT ? -90 : 90,
            finishAngle: 0,
            startOpacity: 0,
            finishOpacity: 255,
            opacityDelay: WINDOW_ANIMATION_TIME,
            onRotationComplete: function() {
                animationButton.destroy();
            }
        });
    },

    set toolbox_window(value) {
        // It's possible that the toolbox window got focused before
        // the toolbox window was set, so do the check again
        // here, too.
        this._toolbox_window = value;
        this._showIfWindowVisible();
    },

    get toolbox_window() {
        return this._toolbox_window;
    },

    set window(value) {
        this._cleanupWindow();
        this._window = value;
        if (this._window)
            this._setupWindow();
    },

    get window() {
        return this._window;
    },

    _updatePosition: function() {
        let rect = this.window.get_frame_rect();
        _synchronizeViewSourceButtonToRectCorner(this, rect);
    },

    _showIfWindowVisible: function() {
        let focusedWindow = global.display.get_focus_window();
        // Probably the root window, ignore.
        if (!focusedWindow)
            return;

        // Don't show if the screen is locked
        let locked = Main.sessionMode.isLocked;

        // Show only if either this window or the toolbox window
        // is in focus
        if ((focusedWindow === this.window ||
             focusedWindow === this.toolbox_window) &&
            !locked)
            this.show();
        else
            this.hide();
    },
});

var CodingSession = new Lang.Class({
    Name: 'CodingSession',
    Extends: GObject.Object,
    Properties: {
        'app': GObject.ParamSpec.object('app',
                                        '',
                                        '',
                                        GObject.ParamFlags.READWRITE,
                                        Meta.WindowActor),
        'toolbox': GObject.ParamSpec.object('toolbox',
                                            '',
                                            '',
                                            GObject.ParamFlags.READWRITE,
                                            Meta.WindowActor),
        'button': GObject.ParamSpec.object('button',
                                           '',
                                           '',
                                           GObject.ParamFlags.READWRITE |
                                           GObject.ParamFlags.CONSTRUCT_ONLY,
                                           WindowTrackingButton.$gtype)
    },

    _init: function(params) {
        this._app = null;
        this._button = null;
        this._toolbox = null;
        this._appRemovedActor = null;
        this.appRemovedByFlipBack = false;

        this._positionChangedIdApp = 0;
        this._positionChangedIdToolbox = 0;
        this._sizeChangedIdApp = 0;
        this._sizeChangedIdToolbox = 0;
        this._constrainGeometryAppId = 0;
        this._constrainGeometryToolboxId = 0;

        this.parent(params);

        this._state = STATE_APP;
        this._toolboxActionGroup = null;

        // FIXME: this should be extended to make it possible to launch
        // arbitrary toolboxes in the future, depending on the application
        this._toolboxAppActionGroup =
            Gio.DBusActionGroup.get(Gio.DBus.session,
                                    'com.endlessm.HackToolbox',
                                    '/com/endlessm/HackToolbox');
        this._toolboxAppActionGroup.list_actions();

        this._windowsRestackedId = Main.overview.connect('windows-restacked',
                                                         this._windowsRestacked.bind(this));
        this._windowMinimizedId = global.window_manager.connect('minimize',
                                                                this._applyWindowMinimizationState.bind(this));
        this._windowUnminimizedId = global.window_manager.connect('unminimize',
                                                                  this._applyWindowUnminimizationState.bind(this));
    },

    set app(value) {
        this._cleanupAppWindow();
        this._app = value;
        if (this._app)
            this._setupAppWindow();
    },

    get app() {
        return this._app;
    },

    set toolbox(value) {
        this._cleanupToolboxWindow();
        this._toolbox = value;
        if (this._toolbox)
            this._setupToolboxWindow();
    },

    get toolbox() {
        return this._toolbox;
    },

    set button(value) {
        this._button = value;
        if (this._button)
            this._button.connect('clicked', this._switchWindows.bind(this));
    },

    get button() {
        return this._button;
    },

    _setupAnimation: function(targetState, src, oldDst, newDst, direction) {
        if (this._state === targetState)
            return;

        this._state = targetState;

        // Now, if we're not already on the desired state, we want to start
        // animating to it here.
        this._prepareAnimate(src, oldDst, newDst, direction);

        // We wait until the first frame of the window has been drawn
        // and damage updated in the compositor before we start rotating.
        //
        // This way we don't get ugly artifacts when rotating if
        // a window is slow to draw.
        if (!newDst._drawnFirstFrame) {
            let firstFrameConnection = newDst.connect('first-frame', () => {
                newDst.disconnect(firstFrameConnection);
                this._completeAnimate(src, oldDst, newDst, direction);
            });
        } else {
            this._completeAnimate(src, oldDst, newDst, direction);
        }
    },

    admitAppWindowActor: function(actor) {
        // If there is a currently bound window then we can't admit this window.
        if (this.app)
            return false;

        let appRemovedActor = this._appRemovedActor;
        this._appRemovedActor = null;

        // We can admit this window. Wire up signals and synchronize
        // geometries now.
        this.app = actor;
        this.button.window = actor.meta_window;

        this._setupAnimation(STATE_APP,
                             this.toolbox,
                             appRemovedActor, this.app,
                             Gtk.DirectionType.RIGHT);
        return true;
    },

    // Maybe admit this actor if it is the kind of actor that we want
    admitToolboxWindowActor: function(actor) {
        // If there is a currently bound window then we can't admit this window.
        if (this.toolbox)
            return false;

        // We can admit this window. Wire up signals and synchronize
        // geometries now.
        this.toolbox = actor;
        this.button.toolbox_window = actor.meta_window;
        this._toolboxActionGroup =
            Gio.DBusActionGroup.get(Gio.DBus.session,
                                    this.toolbox.meta_window.gtk_application_id,
                                    this.toolbox.meta_window.gtk_window_object_path);
        this._toolboxActionGroup.list_actions();

        this._setupAnimation(STATE_TOOLBOX,
                             this.app,
                             null, this.toolbox,
                             Gtk.DirectionType.LEFT);
        return true;
    },

    _actorForCurrentState: function() {
        if (this._state == STATE_APP)
            return this.app;
        else
            return this.toolbox;
    },

    _isActorFromSession: function(actor) {
        return actor === this.app || actor === this.toolbox;
    },

    _isCurrentWindow: function(window) {
        let actor = this._actorForCurrentState();
        return actor.meta_window === window;
    },

    _getOtherActor: function(actor) {
        if (!this._isActorFromSession(actor))
            return null;

        return actor === this.app ? this.toolbox : this.app;
    },

    _completeRemoveWindow: function() {
        let actor = this._actorForCurrentState();

        if (actor) {
            actor.rotation_angle_y = 0;
            actor.show();
            actor.meta_window.activate(global.get_current_time());
        } else {
            this.destroy();
        }
    },

    _setupToolboxWindow: function() {
        this._positionChangedIdToolbox =
            this.toolbox.meta_window.connect('position-changed',
                                             this._synchronizeWindows.bind(this));
        this._sizeChangedIdToolbox =
            this.toolbox.meta_window.connect('size-changed',
                                             this._synchronizeWindows.bind(this));
        this._constrainGeometryToolboxId =
            this.toolbox.meta_window.connect('geometry-allocate',
                                             this._constrainGeometry.bind(this));
    },

    _cleanupToolboxWindow: function() {
        if (this._positionChangedIdToolbox) {
            this.toolbox.meta_window.disconnect(this._positionChangedIdToolbox);
            this._positionChangedIdToolbox = 0;
        }

        if (this._sizeChangedIdToolbox) {
            this.toolbox.meta_window.disconnect(this._sizeChangedIdToolbox);
            this._sizeChangedIdToolbox = 0;
        }

        if (this._constrainGeometryToolboxId) {
            this.toolbox.meta_window.disconnect(this._constrainGeometryToolboxId);
            this._constrainGeometryToolboxId = 0;
        }
    },

    // Remove the toolbox window from this session. Disconnect
    // any signals that we have connected to the toolbox window
    // and show the app window
    removeToolboxWindow: function() {
        this.toolbox = null;

        // Remove the toolbox_window reference from the button. There's no
        // need to disconnect any signals here since the button doesn't
        // care about signals on the toolbox.
        this.button.toolbox_window = null;
        this._state = STATE_APP;

        this._completeRemoveWindow();
    },

    _setupAppWindow: function() {
        this._positionChangedIdApp =
            this.app.meta_window.connect('position-changed',
                                         this._synchronizeWindows.bind(this));
        this._sizeChangedIdApp =
            this.app.meta_window.connect('size-changed',
                                         this._synchronizeWindows.bind(this));
        this._constrainGeometryAppId =
            this.app.meta_window.connect('geometry-allocate',
                                         this._constrainGeometry.bind(this));

        this._appActionProxy =
            Gio.DBusActionGroup.get(Gio.DBus.session,
                                    this.app.meta_window.gtk_application_id,
                                    this.app.meta_window.gtk_application_object_path);
        this._appActionProxy.list_actions();
    },

    _cleanupAppWindow: function() {
        if (this._positionChangedIdApp !== 0) {
            this.app.meta_window.disconnect(this._positionChangedIdApp);
            this._positionChangedIdApp = 0;
        }
        if (this._sizeChangedIdApp !== 0) {
            this.app.meta_window.disconnect(this._sizeChangedIdApp);
            this._sizeChangedIdApp = 0;
        }
        if (this._constrainGeometryAppId) {
            this.app.meta_window.disconnect(this._constrainGeometryAppId);
            this._constrainGeometryAppId = 0;
        }

        this._appActionProxy = null;
    },

    removeAppWindow: function() {
        // Save the actor, so we can complete the destroy transition later
        if (this.appRemovedByFlipBack)
            this._appRemovedActor = this.app;

        this.appRemovedByFlipBack = false;
        this.app = null;

        this.button.window = null;
        this._state = STATE_TOOLBOX;

        this._completeRemoveWindow();
    },

    // Eject out of this session and remove all pairings.
    // Remove all connected signals and close the toolbox as well, if we have one.
    //
    // The assumption here is that the session will be removed immediately
    // after destruction.
    destroy: function() {
        if (this._windowsRestackedId !== 0) {
            Main.overview.disconnect(this._windowsRestackedId);
            this._windowsRestackedId = 0;
        }
        if (this._windowMinimizedId !== 0) {
            global.window_manager.disconnect(this._windowMinimizedId);
            this._windowMinimizedId = 0;
        }
        if (this._windowUnminimizedId !== 0) {
            global.window_manager.disconnect(this._windowUnminimizedId);
            this._windowUnminimizedId = 0;
        }

        this.app = null;

        // Destroy the button too
        this.button.destroy();

        // If we have a toolbox window, disconnect any signals and destroy it.
        if (this.toolbox) {
            let toolboxWindow = this.toolbox.meta_window;
            this.toolbox = null;

            // Destroy the toolbox window now
            toolboxWindow.delete(global.get_current_time());

            // Note that we do not set this._state to STATE_APP here. Any
            // further usage of this session is undefined and it should
            // be removed.
        }
    },

    _windowsNeedSync: function() {
        // Synchronization is only needed when we have both an app and
        // a toolbox
        return this.app && this.toolbox;
    },

    _constrainGeometry: function(window) {
        if (!this._windowsNeedSync())
            return;

        if (!this._isCurrentWindow(window))
            return;

        // Get the minimum size of both the app and the toolbox window
        // and then determine the maximum of the two. We won't permit
        // either window to get any smaller.
        let [minAppWidth, minAppHeight] = this.app.meta_window.get_minimum_size_hints();
        let [minToolboxWidth, minToolboxHeight] = this.toolbox.meta_window.get_minimum_size_hints();

        let minWidth = Math.max(minAppWidth, minToolboxWidth);
        let minHeight = Math.max(minAppHeight, minToolboxHeight);

        window.expand_allocated_geometry(minWidth, minHeight);
    },

    _switchWindows: function() {
        // Switch to toolbox if the app is active. Otherwise switch to the app.
        if (this._state === STATE_APP)
            this._switchToToolbox();
        else
            this._switchToApp();
    },

    // Switch to a toolbox window, launching it if we haven't yet launched it.
    //
    // Note that this is not the same as just rotating to the window - we
    // need to either launch the toolbox window if we don't have a reference
    // to it,  or we just need to switch to an existing toolbox window.
    //
    // This function and the one below do not check this._state to determine
    // if a flip animation should be played. That is the responsibility of
    // the caller.
    _switchToToolbox: function() {
        if (!this.toolbox) {
            this._toolboxAppActionGroup.activate_action(
                'flip',
                new GLib.Variant('(ss)', [this.app.meta_window.gtk_application_id,
                                          this.app.meta_window.gtk_window_object_path]));
        } else {
            this._setupAnimation(STATE_TOOLBOX,
                                 this.app,
                                 null, this.toolbox,
                                 Gtk.DirectionType.LEFT);
        }
    },

    _switchToApp: function() {
        if (this._toolboxActionGroup.has_action('flip-back')) {
            this._toolboxActionGroup.activate_action('flip-back', null);
            this.appRemovedByFlipBack = true;
        } else {
            this._setupAnimation(STATE_APP,
                                 this.toolbox,
                                 null, this.app,
                                 Gtk.DirectionType.RIGHT);
        }
    },

    // Given some recently-focused actor, switch to it without
    // flipping the two windows. We might want this behaviour instead
    // of flipping the windows in cases where we unminimized a window
    // or left the overview. This will cause the state to instantly change
    // and prevent things from being flipped later in _windowRestacked
    _switchToWindowWithoutFlipping: function(actor) {
        // We need to do a few housekeeping things here:
        // 1. Change the _state variable to indicate whether we are now
        //    on the app, or the toolbox window.
        // 2. Ensure that the relevant window is activated (usually just
        //    by activating it again). For instance, in the unminimize case,
        //    unminimizing the sibling window will cause it to activate
        //    which then breaks the user's expectations (it should unminimize
        //    but not activate). Re-activating ensures that we present
        //    the right story to the user.
        this._state = (actor === this.app ? STATE_APP : STATE_TOOLBOX);
        actor.meta_window.activate(global.get_current_time());
    },

    _synchronizeWindows: function(window) {
        if (!this._windowsNeedSync())
            return;

        if (!this._isCurrentWindow(window))
            return;

        let actor = window.get_compositor_private();
        _synchronizeMetaWindowActorGeometries(actor, this._getOtherActor(actor));
    },

    _applyWindowMinimizationState: function(shellwm, actor) {
        if (!this._isActorFromSession(actor))
            return;

        if (!this._isCurrentWindow(actor.meta_window))
            return;

        this._button.hide();

        let toMini = this._getOtherActor(actor);

        // Only want to minimize if we weren't already minimized.
        if (toMini && !toMini.meta_window.minimized)
            toMini.meta_window.minimize();
    },

    _applyWindowUnminimizationState: function(shellwm, actor) {
        if (!this._isActorFromSession(actor))
            return;

        if (!this._isCurrentWindow(actor.meta_window))
            return;

        this._button.show();

        let toUnMini = this._getOtherActor(actor);

        // We only want to unminimize a window here if it was previously
        // unminimized. Unminimizing it again and switching to it without
        // flipping will cause the secondary unminimized window to be
        // activated and flipped to.
        if (toUnMini && toUnMini.meta_window.minimized) {
            toUnMini.meta_window.unminimize();

            // Window was unminimized. Ensure that this actor is focused
            // and switch to it instantly
            this._switchToWindowWithoutFlipping(actor);
        }
    },

    _windowsRestacked: function() {
        let focusedWindow = global.display.get_focus_window();
        if (!focusedWindow)
            return;

        let appWindow = this.app ? this.app.meta_window : null;
        let toolboxWindow = this.toolbox ? this.toolbox.meta_window : null;

        // Determine if we need to change the state of this session by
        // examining the focused window
        if (focusedWindow != appWindow && focusedWindow != toolboxWindow)
            return;

        let focusedActor = focusedWindow.get_compositor_private();

        // If the overview is still showing or animating out, we probably
        // selected this window from the overview. In that case, flipping
        // make no sense, immediately change the state and show the
        // recently activated window.
        if (Main.overview.visible || Main.overview.animationInProgress) {
            this._switchToWindowWithoutFlipping(focusedActor);
            return;
        }

        // If we reached this point, we'll be rotating the two windows.
        // First, make sure we do not rotate when a rotation is running,
        // then use the state to figure out which way to flip
        if (this._rotatingInActor || this._rotatingOutActor)
            return;

        let actor = this._actorForCurrentState();
        if (actor !== focusedActor)
            this._switchWindows();
    },

    _prepareAnimate: function(src, oldDst, newDst, direction) {
        // Make sure the source window has active focus at the start of the
        // animation. We rely on it staying on top until midpoint.
        src.meta_window.activate(global.get_current_time());

        // We want to do this _first_ before setting up any animations.
        // Synchronising windows could cause kill-window-effects to
        // be emitted, which would undo some of the preparation
        // that we would have done such as setting rotation angles.
        _synchronizeMetaWindowActorGeometries(src, newDst);

        this._rotatingInActor = newDst;
        this._rotatingOutActor = src;

        // What we do here is rotate both windows by 180degrees.
        // The effect of this is that the front and back window will be at
        // opposite rotations at each point in time and so the exact point
        // at which the first window is brought to front, is the same point
        // at which the second window is brought to back.
        src.show();
        if (oldDst)
            newDst.opacity = 0;
        else
            newDst.show();

        // Hide the destination until midpoint
        if (direction == Gtk.DirectionType.LEFT)
            newDst.opacity = 0;

        // we have to set those after unmaximize/maximized otherwise they are lost
        newDst.rotation_angle_y = direction == Gtk.DirectionType.RIGHT ? -180 : 180;
        src.rotation_angle_y = 0;
        newDst.pivot_point = new Clutter.Point({ x: 0.5, y: 0.5 });
        src.pivot_point = new Clutter.Point({ x: 0.5, y: 0.5 });

        if (oldDst) {
            oldDst.rotation_angle_y = newDst.rotation_angle_y;
            oldDst.pivot_point = newDst.pivot_point;
        }
    },

    _completeAnimate: function(src, oldDst, newDst, direction) {
        this._animateToMidpoint(src,
                                oldDst,
                                newDst,
                                direction);
        this.button.switchAnimation(direction);
    },

    _animateToMidpoint: function(src, oldDst, newDst, direction) {
        // Tween both windows in a rotation animation at the same time.
        // This will allow for a smooth transition.
        Tweener.addTween(src, {
            rotation_angle_y: direction == Gtk.DirectionType.RIGHT ? 90 : -90,
            time: WINDOW_ANIMATION_TIME * 2,
            transition: 'easeInQuad',
            onComplete: this._rotateOutToMidpointCompleted.bind(this),
            onCompleteParams: [src, direction]
        });

        let dst = oldDst ? oldDst : newDst;
        Tweener.addTween(dst, {
            rotation_angle_y: direction == Gtk.DirectionType.RIGHT ? -90 : 90,
            time: WINDOW_ANIMATION_TIME * 2,
            transition: 'easeInQuad',
            onComplete: this._rotateInToMidpointCompleted.bind(this),
            onCompleteParams: [oldDst, newDst, direction]
        });
    },

    _rotateOutToMidpointCompleted: function(src, direction) {
        // Support a 'flip' action in the app too, if it exposes it
        const flipState = (this._state == STATE_TOOLBOX);
        if (this._appActionProxy.has_action('flip'))
            this._appActionProxy.activate_action('flip', new GLib.Variant('b', flipState));

        Tweener.addTween(src, {
            rotation_angle_y: direction == Gtk.DirectionType.RIGHT ? 180 : -180,
            time: WINDOW_ANIMATION_TIME * 2,
            transition: 'easeOutQuad',
            onComplete: this._rotateOutCompleted.bind(this),
            onCompleteParams: [false]
        });
    },

    _rotateInToMidpointCompleted: function(oldDst, newDst, direction) {
        if (oldDst) {
            newDst.rotation_angle_y = oldDst.rotation_angle_y;
            global.window_manager.completed_destroy(oldDst);
        }

        // Now show the destination
        newDst.meta_window.activate(global.get_current_time());
        newDst.opacity = 255;

        Tweener.addTween(newDst, {
            rotation_angle_y: 0,
            time: WINDOW_ANIMATION_TIME * 2,
            transition: 'easeOutQuad',
            onComplete: this._rotateInCompleted.bind(this)
        });
    },

    // We need to keep these separate here so that they can be called
    // by killEffects later if required.
    _rotateInCompleted: function() {
        let actor = this._rotatingInActor;
        if (!actor)
            return;

        Tweener.removeTweens(actor);
        actor.rotation_angle_y = 0;
        actor.opacity = 255;
        this._rotatingInActor = null;
    },

    _rotateOutCompleted: function(resetRotation) {
        let actor = this._rotatingOutActor;
        if (!actor)
            return;

        Tweener.removeTweens(actor);
        if (resetRotation)
            actor.rotation_angle_y = 0;
        this._rotatingOutActor = null;
    },

    killEffects: function() {
        this._rotateInCompleted();
        this._rotateOutCompleted(true);
    }
});

const SessionLookupFlags = {
    SESSION_LOOKUP_APP: 1 << 0,
    SESSION_LOOKUP_TOOLBOX: 1 << 1,
};

var CodeViewManager = new Lang.Class({
    Name: 'CodeViewManager',

    _init: function() {
        this._sessions = [];

        global.display.connect('window-created', (display, window) => {
            let windowActor = window.get_compositor_private();
            windowActor._drawnFirstFrame = false;
            windowActor.connect('first-frame', () => {
                windowActor._drawnFirstFrame = true;
            });
        });
    },

    _addAppWindow: function(actor) {
        if (!global.settings.get_boolean('enable-code-view'))
            return;

        let window = actor.meta_window;
        if (!_isCodingApp(window.get_flatpak_id()))
            return;

        this._sessions.push(new CodingSession({
            app: actor,
            toolbox: null,
            button: new WindowTrackingButton({ window: window })
        }));
    },

    _removeAppWindow: function(actor) {
        let session = this._getSession(actor, SessionLookupFlags.SESSION_LOOKUP_APP);
        if (!session)
            return false;

        if (session.appRemovedByFlipBack) {
            session.removeAppWindow();
            return true;
        } else {
            // Destroy the session here and remove it from the list
            session.destroy();

            let idx = this._sessions.indexOf(session);
            if (idx === -1)
                return false;

            this._sessions.splice(idx, 1);
        }

        return false;
    },

    _removeToolboxWindow: function(actor) {
        let session = this._getSession(actor, SessionLookupFlags.SESSION_LOOKUP_TOOLBOX);
        if (!session)
            return;

        // We can remove the normal toolbox window.
        // That window will be registered in the session at this point.
        session.removeToolboxWindow();
    },

    handleDestroyWindow: function(actor) {
        let wasFlippedBack = this._removeAppWindow(actor);
        this._removeToolboxWindow(actor);

        return wasFlippedBack;
    },

    handleMapWindow: function(actor) {
        // Check if the window is a GtkApplicationWindow. If it is
        // then it might be either a "hack" toolbox window or target
        // window and we'll need to check on the session bus and
        // make associations as appropriate
        if (!actor.meta_window.gtk_application_object_path)
            return false;

        // It might be a "HackToolbox". Check that, and if so,
        // add it to the window group for the window.
        let proxy = Shell.WindowTracker.get_hack_toolbox_proxy(actor.meta_window);
        let handled = false;

        // This is a new proxy window, make it join the session
        if (proxy) {
            let variant = proxy.get_cached_property('Target');
            let [targetBusName, targetObjectPath] = variant.deep_unpack();
            let session = this._getSessionForTargetApp(
                targetBusName, targetObjectPath);

            if (session)
                handled = session.admitToolboxWindowActor(actor);
        } else {
            // See if this is a new app window for an existing toolbox session
            let session = this._getSessionForToolboxTarget(
                actor.meta_window.gtk_application_id,
                actor.meta_window.gtk_window_object_path);

            if (session)
                handled = session.admitAppWindowActor(actor);
            else
                // This is simply a new application window
                this._addAppWindow(actor);
        }

        if (handled)
            global.window_manager.completed_map(actor);

        return handled;
    },

    killEffectsOnActor: function(actor) {
        let session = this._getSession(actor,
                                       SessionLookupFlags.SESSION_LOOKUP_APP |
                                       SessionLookupFlags.SESSION_LOOKUP_TOOLBOX);
        if (session)
            session.killEffects();
    },

    _getSession: function(actor, flags) {
        for (let i = 0; i < this._sessions.length; i++) {
            let session = this._sessions[i];
            if (((session.app === actor) && (flags & SessionLookupFlags.SESSION_LOOKUP_APP)) ||
                ((session.toolbox === actor) && (flags & SessionLookupFlags.SESSION_LOOKUP_TOOLBOX)))
                return session;
        }

        return null;
    },

    _getSessionForTargetApp: function(targetBusName, targetObjectPath) {
        for (let session of this._sessions) {
            if ((session.app &&
                 (session.app.meta_window.gtk_application_id == targetBusName &&
                  session.app.meta_window.gtk_window_object_path == targetObjectPath)))
                return session;
        }

        return null;
    },

    _getSessionForToolboxTarget: function(appBusName, appObjectPath) {
        for (let session of this._sessions) {
            if (!session.toolbox)
                continue;

            let proxy = Shell.WindowTracker.get_hack_toolbox_proxy(session.toolbox.meta_window);
            let variant = proxy.get_cached_property('Target');
            let [targetBusName, targetObjectPath] = variant.deep_unpack();
            if (targetBusName == appBusName &&
                targetObjectPath == appObjectPath)
                return session;
        }

        return null;
    }
});
