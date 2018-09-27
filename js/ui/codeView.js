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
const Tweener = imports.ui.tweener;

const WINDOW_ANIMATION_TIME = 0.25;
const WATCHDOG_TIME = 30000; // ms

const BUTTON_OFFSET_X = 33;
const BUTTON_OFFSET_Y = 40;

const STATE_APP = 0;
const STATE_TOOLBOX = 1;

const _CODING_APPS = [
    'com.endlessm.Helloworld',
    'org.gnome.Weather'
];

function _isCodingApp(flatpakID) {
    return _CODING_APPS.indexOf(flatpakID) != -1;
}

function _isToolbox(flatpakID) {
    return flatpakID === 'org.gnome.Builder';
}

function _isToolboxSpeedwagon(window) {
    let tracker = Shell.WindowTracker.get_default();
    let correspondingApp = tracker.get_window_app(window);
    return (Shell.WindowTracker.is_speedwagon_window(window) &&
            correspondingApp &&
            correspondingApp.get_id() === 'org.gnome.Builder.desktop');
}

function _createIcon() {
    let iconFile = Gio.File.new_for_uri('resource:///org/gnome/shell/theme/rotate.svg');
    let gicon = new Gio.FileIcon({ file: iconFile });
    let icon = new St.Icon({ style_class: 'view-source-icon',
                             gicon: gicon });
    return icon;
}

function _getAppManifestAt(location, flatpakID) {
    let manifestFile = Gio.File.new_for_path(GLib.build_filenamev([location, 'app', flatpakID, 'current',
                                                                   'active', 'files', 'manifest.json']));
    if (!manifestFile.query_exists(null))
        return null;
    return manifestFile;
}

function _getAppManifest(flatpakID) {
    let manifestFile = _getAppManifestAt(Flatpak.Installation.new_user(null).get_path().get_path(), flatpakID);
    if (manifestFile)
        return manifestFile;

    manifestFile = _getAppManifestAt(Flatpak.Installation.new_system(null).get_path().get_path(), flatpakID);
    if (manifestFile)
        return manifestFile;

    return null;
}

// _synchronizeMetaWindowActorGeometries
//
// Synchronize geometry of MetaWindowActor src to dst by
// applying both the physical geometry and maximization state.
//
// The return value signifies whether the maximization state changed,
// which may cause the hidden window to be shown.
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

    if (srcGeometry.equal(dstGeometry))
        return maximizationStateChanged;

    dst.meta_window.move_resize_frame(false,
                                      srcGeometry.x,
                                      srcGeometry.y,
                                      srcGeometry.width,
                                      srcGeometry.height);

    return maximizationStateChanged;
}

function _synchronizeViewSourceButtonToRectCorner(button, rect) {
    button.set_position(rect.x + rect.width - BUTTON_OFFSET_X,
                        rect.y + rect.height - BUTTON_OFFSET_Y);
}

function _createViewSourceButtonInRectCorner(rect) {
    let button = new St.Button({
        style_class: 'view-source',
        x_fill: true,
        y_fill: true
    });
    button.set_child(_createIcon());
    _synchronizeViewSourceButtonToRectCorner(button, rect);
    return button;
}

function _createInputEnabledViewSourceButtonInRectCorner(rect) {
    // Do required setup to make this button interactive,
    // by allowing it to be focused and adding chrome
    // to the toplevel layoutManager.
    let button = _createViewSourceButtonInRectCorner(rect);
    button.reactive = true;
    button.can_focus = true;
    button.track_hover = true;
    Main.layoutManager.addChrome(button);
    return button;
}

function _flipButtonAroundRectCenter(props) {
    let {
        button,
        rect,
        startAngle,
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
        rotation_angle_y: finishAngle,
        time: WINDOW_ANIMATION_TIME * 4,
        transition: 'easeOutQuad',
        onComplete: function() {
            if (onRotationComplete)
                onRotationComplete();
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
    Extends: GObject.Object,
    Properties: {
        'window': GObject.ParamSpec.object('window',
                                           '',
                                           '',
                                           GObject.ParamFlags.READWRITE |
                                           GObject.ParamFlags.CONSTRUCT_ONLY,
                                           Meta.Window),
        'toolbox_window': GObject.ParamSpec.object('toolbox-window',
                                                   '',
                                                   '',
                                                   GObject.ParamFlags.READWRITE,
                                                   Meta.Window)
    },
    Signals: {
        'clicked': {}
    },

    _init: function(params) {
        this.parent(params);

        // The button will be auto-added to the manager. Note that in order to
        // remove this button, you will need to call destroy() from outside
        // this class or use removeChrome from within it.
        this._button = _createInputEnabledViewSourceButtonInRectCorner(this.window.get_frame_rect());
        this._button.connect('clicked', () => {
            this.emit('clicked');
        });

        // Connect to signals on the window to determine when to move
        // hide, and show the button. Note that WindowTrackingButton is
        // constructed with the primary app window and we listen for signals
        // on that. This is because of the assumption that both the app
        // window and toolbox window are completely synchronized.
        this._positionChangedId = this.window.connect('position-changed',
                                                      this._updatePosition.bind(this));
        this._sizeChangedId = this.window.connect('size-changed',
                                                  this._updatePosition.bind(this));
        this._windowsRestackedId = Main.overview.connect('windows-restacked',
                                                         this._showIfWindowVisible.bind(this));
        this._overviewHidingId = Main.overview.connect('hiding',
                                                       this._showIfWindowVisible.bind(this));
        this._overviewShowingId = Main.overview.connect('showing',
                                                        this._hide.bind(this));
        this._sessionModeChangedId = Main.sessionMode.connect('updated',
                                                              this._showIfWindowVisible.bind(this));
        this._windowMinimizedId = global.window_manager.connect('minimize',
                                                                this._hide.bind(this));
        this._windowUnminimizedId = global.window_manager.connect('unminimize',
                                                                  this._show.bind(this));
    },

    // Users MUST call destroy before unreferencing this button - this will
    // cause it to disconnect all signals and remove its button from any
    // layout managers.
    destroy: function() {
        if (this._positionChangedId) {
            this.window.disconnect(this._positionChangedId);
            this._positionChangedId = 0;
        }

        if (this._sizeChangedId) {
            this.window.disconnect(this._sizeChangedId);
            this._sizeChangedId = 0;
        }

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

        if (this._windowMinimizedId) {
            global.window_manager.disconnect(this._windowMinimizedId);
            this._windowMinimizedId = 0;
        }

        if (this._windowUnminimizedId) {
            global.window_manager.disconnect(this._windowUnminimizedId);
            this._windowUnminimizedId = 0;
        }

        Main.layoutManager.removeChrome(this._button);
        this._button.destroy();
    },

    // Just fade out and fade the button back in again. This makes it
    // look as though we have two buttons, but in reality we just have
    // one.
    switchAnimation: function(direction) {
        let rect = this.window.get_frame_rect();

        // Start an animation for flipping the main button around the
        // center of the window.
        _flipButtonAroundRectCenter({
            button: this._button,
            rect: rect,
            startAngle: 0,
            finishAngle: direction == Gtk.DirectionType.RIGHT ? 180 : -180,
            startOpacity: 255,
            finishOpacity: 0,
            opacityDelay: 0,
            onButtonFadeComplete: () => {
                Tweener.removeTweens(this._button);
                this._button.rotation_angle_y = 0;
                // Fade in again once we're done, since
                // we'll need to display this button
                Tweener.addTween(this._button, {
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
            finishAngle: 0,
            startOpacity: 0,
            finishOpacity: 255,
            opacityDelay: WINDOW_ANIMATION_TIME,
            onRotationComplete: function() {
                animationButton.destroy();
            }
        });
    },

    set toolbox_window(window) {
        // It's possible that the toolbox window got focused before
        // the toolbox window was set, so do the check again
        // here, too.
        this.toolbox_window = window;
        this._showIfWindowVisible();
    },

    _updatePosition: function() {
        let rect = this.window.get_frame_rect();
        _synchronizeViewSourceButtonToRectCorner(this._button, rect);
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
            this._show();
        else
            this._hide();
    },

    _show: function() {
        this._button.show();
    },

    _hide: function() {
        this._button.hide();
    }
});

function _constructLoadFlatpakValue(app, appManifest) {
    // add an app_id_override to the manifest to load
    return appManifest.get_path() + '+' + app.meta_window.get_flatpak_id() + '.Coding';
}

var CodingSession = new Lang.Class({
    Name: 'CodingSession',
    Extends: GObject.Object,
    Properties: {
        'app': GObject.ParamSpec.object('app',
                                        '',
                                        '',
                                        GObject.ParamFlags.READWRITE |
                                        GObject.ParamFlags.CONSTRUCT_ONLY,
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
        this.parent(params);

        this._appManifest = null;
        this._state = STATE_APP;

        this.button.connect('clicked', this._switchWindows.bind(this));
        this._positionChangedIdApp = this.app.meta_window.connect('position-changed',
                                                                  this._synchronizeWindows.bind(this));
        this._sizeChangedIdApp = this.app.meta_window.connect('size-changed',
                                                              this._synchronizeWindows.bind(this));
        this._windowsRestackedId = Main.overview.connect('windows-restacked',
                                                         this._windowsRestacked.bind(this));
        this._windowMinimizedId = global.window_manager.connect('minimize',
                                                                this._applyWindowMinimizationState.bind(this));
        this._windowUnminimizedId = global.window_manager.connect('unminimize',
                                                                  this._applyWindowUnminimizationState.bind(this));
        this._constrainGeometryAppId = this.app.meta_window.connect('geometry-allocate',
                                                                    this._constrainGeometry.bind(this));

        this._watchdogId = 0;
    },

    // Maybe admit this actor if it is the kind of actor that we want
    admitToolboxWindowActor: function(actor) {
        // If there is a currently bound window and it is not a speedwagon,
        // then we can't admit this window. Return false.
        if (this.toolbox &&
            !Shell.WindowTracker.is_speedwagon_window(this.toolbox.meta_window))
            return false;

        // We can admit this window. Wire up signals and synchronize
        // geometries now.
        this.toolbox = actor;
        this.button.toolbox_window = actor.meta_window;

        // The assumption here is that if we connect a new window, we
        // are connecting a toolbox window (potentially 'on top') of the
        // speedwagon window, so there is no need to disconnect
        // signals
        this._positionChangedIdToolbox = this.toolbox.meta_window.connect('position-changed',
                                                                          this._synchronizeWindows.bind(this));
        this._sizeChangedIdToolbox = this.toolbox.meta_window.connect('size-changed',
                                                                      this._synchronizeWindows.bind(this));
        _synchronizeMetaWindowActorGeometries(this.app, this.toolbox);

        if (Shell.WindowTracker.is_speedwagon_window(actor.meta_window)) {
            // If we are animating to a speedwagon window, we'll want to
            // remove the 'above' attribute - we don't want the splash to
            // appear over everything else.
            actor.meta_window.unmake_above();
        } else {
            // Connect the real toolbox window to the geometry-allocate
            // signal
            this._constrainGeometryToolboxId = this.toolbox.meta_window.connect('geometry-allocate',
                                                                                this._constrainGeometry.bind(this));

            // We only want to untrack the coding app window at this
            // point and not at the point we show the speedwagon. This
            // will ensure that the shell window tracker is still
            // watching for the toolbox window to appear.
            this._stopWatchingForToolboxWindowToComeOnline();

            // We also only want to hide the speedwagon window at this
            // point, since the other window has arrived.
            this.splash.rampOut();
        }

        // Now, if we're not already on the toolbox window, we want to start
        // animating to it here. This is different from just calling
        // _switchToToolbox - we already have the window and we want to
        // rotate to it as soon as its first frame appears
        if (this._state === STATE_APP) {
            // We wait until the first frame of the window has been drawn
            // and damage updated in the compositor before we start rotating.
            //
            // This way we don't get ugly artifacts when rotating if
            // a window is slow to draw.
            let firstFrameConnection = this.toolbox.connect('first-frame', () => {
                this._animate(this.app,
                              this.toolbox,
                              Gtk.DirectionType.LEFT);

                this.toolbox.disconnect(firstFrameConnection);
                this.button.switchAnimation(Gtk.DirectionType.LEFT);

                return false;
            });
            this._prepareAnimate(this.app,
                                 this.toolbox,
                                 Gtk.DirectionType.LEFT);
            this._state = STATE_TOOLBOX;
        }

        return true;
    },

    // Remove the toolbox window from this session. Disconnect
    // any signals that we have connected to the toolbox window
    // and show the app window
    removeToolboxWindow: function() {
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

        // Remove the toolbox_window reference from the button. There's no
        // need to disconnect any signals here since the button doesn't
        // care about signals on the toolbox.
        this.button.toolbox_window = null;
        this.toolbox = null;
        this._state = STATE_APP;

        this.app.meta_window.activate(global.get_current_time());
        this.app.show();
    },

    // Eject out of this session and remove all pairings.
    // Remove all connected signals and show the toolbox window if we have
    // one.
    //
    // The assumption here is that the session will be removed immediately
    // after destruction.
    destroy: function() {
        if (this._positionChangedIdApp !== 0) {
            this.app.meta_window.disconnect(this._positionChangedIdApp);
            this.positionChangedIdApp = 0;
        }
        if (this._sizeChangedIdApp !== 0) {
            this.app.meta_window.disconnect(this._sizeChangedIdApp);
            this.sizeChangedIdApp = 0;
        }
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

        if (this._constrainGeometryAppId) {
            this.app.meta_window.disconnect(this._constrainGeometryAppId);
            this._constrainGeometryAppId = 0;
        }

        if (this._constrainGeometryToolboxId) {
            this.toolbox.meta_window.disconnect(this._constrainGeometryToolboxId);
            this._constrainGeometryToolboxId = 0;
        }

        // Destroy the button too
        this.button.destroy();

        // If we have a toolbox window, disconnect any signals,
        // show it and activate it now
        //
        // For whatever reason, this.toolbox.meta_window seems to be
        // undefined on speedwagon windows, so handle that case here.
        if (this.toolbox && this.toolbox.meta_window) {
            if (this._positionChangedIdToolbox) {
                this.toolbox.meta_window.disconnect(this._positionChangedIdToolbox);
                this._positionChangedIdToolbox = 0;
            }

            if (this._sizeChangedIdToolbox) {
                this.toolbox.meta_window.disconnect(this._sizeChangedIdToolbox);
                this._sizeChangedIdToolbox = 0;
            }

            this.toolbox.meta_window.activate(global.get_current_time());
            this.toolbox.show();

            // Note that we do not set this._state to STATE_APP here. Any
            // further usage of this session is undefined and it should
            // be removed.
        }
    },

    _constrainGeometry: function(window) {
        if (!this.toolbox)
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

    _switchWindows: function(actor, event) {
        // Switch to toolbox if the app is active. Otherwise switch to the app.
        if (this._state === STATE_APP)
            this._switchToToolbox();
        else
            this._switchToApp();
    },

    _startToolboxForFlatpak: function(loadFlatpakValue) {
        let params = new GLib.Variant('(sava{sv})', ['load-flatpak', [new GLib.Variant('s', loadFlatpakValue)], {}]);
        Gio.DBus.session.call('org.gnome.Builder',
                              '/org/gnome/Builder',
                              'org.gtk.Actions',
                              'Activate',
                              params,
                              null,
                              Gio.DBusCallFlags.NONE,
                              GLib.MAXINT32,
                              null,
                              (conn, result) => {
                                  try {
                                      conn.call_finish(result);
                                  } catch (e) {
                                      // Failed. Mark the session as cancelled
                                      // and wait for the flip animation
                                      // to complete, where we will
                                      // remove the toolbox window.
                                      this.cancelled = true;
                                      logError(e, 'Failed to start gnome-builder');
                                  }
                              });
    },

    // Switch to a toolbox window, launching it if we haven't yet launched it.
    //
    // Note that this is not the same as just rotating to the window - we
    // need to either launch the toolbox window if we don't have a reference
    // to it (and show a speedwagon) or we just need to switch to an existing
    // toolbox window.
    //
    // This function and the one below do not check this._state to determine
    // if a flip animation should be played. That is the responsibility of
    // the caller.
    _switchToToolbox: function() {
        if (!this.toolbox) {
            // get the manifest of the application
            // return early before we setup anything
            this._appManifest = _getAppManifest(this.app.meta_window.get_flatpak_id());
            if (!this._appManifest) {
                log('Error, coding: No manifest could be found for the app: ' + this.app.meta_window.get_flatpak_id());
                return;
            }

            let tracker = Shell.WindowTracker.get_default();
            tracker.track_coding_app_window(this.app.meta_window);
            this._watchdogId = Mainloop.timeout_add(WATCHDOG_TIME, this._stopWatchingForToolboxWindowToComeOnline.bind(this));

            // We always show a splash screen, even if toolbox is running. We
            // know when the window comes online so we can hide it accordingly.
            let toolboxShellApp = Shell.AppSystem.get_default().lookup_app('org.gnome.Builder.desktop');
            // Right now we don't connect the close button - clicking on
            // it will just do nothing. We expect the user to just click on
            // the CodeView button in order to get back to the main
            // window.
            this.splash = new AppActivation.SpeedwagonSplash(toolboxShellApp);
            this.splash.show();

            this._startToolboxForFlatpak(_constructLoadFlatpakValue(this.app,
                                                                    this._appManifest));
        } else {
            this.toolbox.meta_window.activate(global.get_current_time());
            this._prepareAnimate(this.app,
                                 this.toolbox,
                                 Gtk.DirectionType.LEFT);
            this._animate(this.app,
                          this.toolbox,
                          Gtk.DirectionType.LEFT);
            this.button.switchAnimation(Gtk.DirectionType.LEFT);
            this._state = STATE_TOOLBOX;
        }
    },

    _switchToApp: function() {
        this.app.meta_window.activate(global.get_current_time());
        this._prepareAnimate(this.toolbox,
                             this.app,
                             Gtk.DirectionType.RIGHT);
        this._animate(this.toolbox,
                      this.app,
                      Gtk.DirectionType.RIGHT);
        this.button.switchAnimation(Gtk.DirectionType.RIGHT);
        this._state = STATE_APP;
    },

    // Given some recently-focused actor, switch to it without
    // flipping the two windows. We might want this behaviour instead
    // of flipping the windows in cases where we unminimized a window
    // or left the overview. This will cause the state to instantly change
    // and prevent things from being flipped later in _windowRestacked
    _switchToWindowWithoutFlipping: function(actor) {
        // Neither the app window nor the toolbox, return
        if (actor !== this.app && actor !== this.toolbox)
            return;

        // We need to do a few housekeeping things here:
        // 1. Change the _state variable to indicate whether we are now
        //    on the app, or the toolbox window.
        // 2. Depending on that state, hide and show windows. We might have
        //    hidden windows during the flip animation, so we need to show
        //    any relevant windows and hide any irrelevant ones
        // 3. Ensure that the relevant window is activated (usually just
        //    by activating it again). For instance, in the unminimize case,
        //    unminimizing the sibling window will cause it to activate
        //    which then breaks the user's expectations (it should unminimize
        //    but not activate). Re-activating ensures that we present
        //    the right story to the user.
        this._state = (actor === this.app ? STATE_APP : STATE_TOOLBOX);
        if (this._state === STATE_APP) {
            this.toolbox.hide();
            this.app.show();
        } else {
            this.app.hide();
            this.toolbox.show();
        }

        actor.meta_window.activate(global.get_current_time());
    },

    // Assuming that we are only listening to some signal on app and toolbox,
    // given some window, determine which MetaWindowActor instance is the
    // source and which is the destination, such that the source is where
    // the signal occurred and the destination is where changes should be
    // applied.
    _srcAndDstPairFromWindow: function(window) {
        let src = (window === this.app.meta_window ? this.app : this.toolbox);
        let dst = (window === this.app.meta_window ? this.toolbox : this.app);

        return [src, dst];
    },

    _isActorFromSession: function(actor) {
        if (actor === this.app && this.toolbox)
            return this.toolbox;
        else if (actor === this.toolbox && this.app)
            return this.app;
        return null;
    },

    _synchronizeWindows: function(window) {
        // No synchronization if toolbox has not been set here
        if (!this.toolbox)
            return;

        let [src, dst] = this._srcAndDstPairFromWindow(window);
        let maximizationStateChanged = _synchronizeMetaWindowActorGeometries(src, dst);

        // If the maximization state changed, we may end up with windows that
        // are shown. Use the current state to determine which window to hide.
        if (!maximizationStateChanged)
            return;

        if (this._state === STATE_TOOLBOX)
            this.app.hide();
        else
            this.toolbox.hide();
    },

    _applyWindowMinimizationState: function(shellwm, actor) {
        // No synchronization if toolbox has not been set here
        if (!this.toolbox)
            return;

        let toMini = this._isActorFromSession(actor);

        // Only want to minimize if we weren't already minimized.
        if (toMini && !toMini.meta_window.minimized)
            toMini.meta_window.minimize();
    },

    _applyWindowUnminimizationState: function(shellwm, actor) {
        // No synchronization if toolbox has not been set here
        if (!this.toolbox)
            return;

        let toUnMini = this._isActorFromSession(actor);

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

        if (!this.toolbox)
            return;

        let appWindow = this.app.meta_window;
        let toolboxWindow = this.toolbox.meta_window;
        let nextState = null;

        // Determine if we need to change the state of this session by
        // examining the focused window
        if (appWindow === focusedWindow && this._state === STATE_TOOLBOX)
            nextState = STATE_APP;
        else if (toolboxWindow === focusedWindow && this._state === STATE_APP)
            nextState = STATE_TOOLBOX;

        // No changes to be made, so return directly
        if (nextState === null)
            return;

        // If the overview is still showing or animating out, we probably
        // selected this window from the overview. In that case, flipping
        // make no sense, immediately change the state and show the
        // recently activated window.
        if (Main.overview.visible || Main.overview.animationInProgress) {
            let actor = (nextState === STATE_APP ? this.app : this.toolbox);
            this._switchToWindowWithoutFlipping(actor);
            return;
        }

        // If we reached this point, we'll be rotating the two windows.
        // First, make sure we do not rotate when a rotation is running,
        // then use the state to figure out which way to flip
        if (this._rotatingInActor || this._rotatingOutActor)
            return;

        if (nextState === STATE_APP)
            this._switchToApp();
        else
            this._switchToToolbox();
    },

    _prepareAnimate: function(src, dst, direction) {
        // We want to do this _first_ before setting up any animations.
        // Synchronising windows could cause kill-window-effects to
        // be emitted, which would undo some of the preparation
        // that we would have done such as setting backface culling
        // or rotation angles.
        _synchronizeMetaWindowActorGeometries(src, dst);

        this._rotatingInActor = dst;
        this._rotatingOutActor = src;

        // We set backface culling to be enabled here so that we can
        // smootly animate between the two windows. Without expensive
        // vector projections, there's no way to determine whether a
        // window's front-face is completely invisible to the user
        // (this cannot be done just by looking at the angle of the
        // window because the same angle may show a different visible
        // face depending on its position in the view frustum).
        //
        // What we do here is enable backface culling and rotate both
        // windows by 180degrees. The effect of this is that the front
        // and back window will be at opposite rotations at each point
        // in time and so the exact point at which the first window
        // becomes invisible is the same point at which the second
        // window becomes visible. Because no back faces are drawn
        // there are no visible artifacts in the animation */
        src.set_cull_back_face(true);
        dst.set_cull_back_face(true);

        src.show();
        dst.show();
        dst.opacity = 0;

        // we have to set those after unmaximize/maximized otherwise they are lost
        dst.rotation_angle_y = direction == Gtk.DirectionType.RIGHT ? -180 : 180;
        src.rotation_angle_y = 0;
        dst.pivot_point = new Clutter.Point({ x: 0.5, y: 0.5 });
        src.pivot_point = new Clutter.Point({ x: 0.5, y: 0.5 });
    },

    _animate: function(src, dst, direction) {
        // Tween both windows in a rotation animation at the same time
        // with backface culling enabled on both. This will allow for
        // a smooth transition.
        Tweener.addTween(src, {
            rotation_angle_y: direction == Gtk.DirectionType.RIGHT ? 180 : -180,
            time: WINDOW_ANIMATION_TIME * 4,
            transition: 'easeOutQuad',
            onComplete: this._rotateOutCompleted.bind(this)
        });
        Tweener.addTween(dst, {
            rotation_angle_y: 0,
            time: WINDOW_ANIMATION_TIME * 4,
            transition: 'easeOutQuad',
            onComplete: () => {
                this._rotateInCompleted(dst);

                // Failed. Stop watching for coding
                // app windows and cancel any splash
                // screens.
                if (this.cancelled) {
                    this.splash.rampOut();
                    this._stopWatchingForToolboxWindowToComeOnline();
                    this.removeToolboxWindow();
                }
            }
        });

        // Gently fade the window in, this will paper over
        // any artifacts from shadows and the like
        //
        // Note: The animation time is reduced here - this
        // is intention. It is just to prevent initial
        // "double shadows" when rotating between windows.
        Tweener.addTween(dst, {
            opacity: 255,
            time: WINDOW_ANIMATION_TIME,
            transition: 'linear'
        });
    },

    // We need to keep these separate here so that they can be called
    // by killEffects later if required.
    _rotateInCompleted: function() {
        let actor = this._rotatingInActor;
        if (!actor)
            return;

        Tweener.removeTweens(actor);
        actor.opacity = 255;
        actor.rotation_angle_y = 0;
        actor.set_cull_back_face(false);
        this._rotatingInActor = null;

        // If we just finished rotating in the speedwagon
        // for toolbox, launch toolbox now
        if (_isToolboxSpeedwagon(actor.meta_window))
           this._startToolboxForFlatpak(_constructLoadFlatpakValue(this.app,
                                                                   this._appManifest));
    },

    _rotateOutCompleted: function() {
        let actor = this._rotatingOutActor;
        if (!actor)
            return;

        Tweener.removeTweens(actor);
        actor.hide();
        actor.rotation_angle_y = 0;
        actor.set_cull_back_face(false);
        this._rotatingOutActor = null;
    },

    _stopWatchingForToolboxWindowToComeOnline: function() {
        let tracker = Shell.WindowTracker.get_default();
        tracker.untrack_coding_app_window();
        if (this._watchdogId !== 0) {
            Mainloop.source_remove(this._watchdogId);
            this._watchdogId = 0;
        }

        return false;
    },

    killEffects: function() {
        this._rotateInCompleted();
        this._rotateOutCompleted();
    }
});

var CodeViewManager = new Lang.Class({
    Name: 'CodeViewManager',

    _init: function() {
        this._sessions = [];
    },

    addAppWindow: function(actor) {
        if (!global.settings.get_boolean('enable-code-view'))
            return false;

        let window = actor.meta_window;
        if (!_isCodingApp(window.get_flatpak_id()))
            return false;

        this._sessions.push(new CodingSession({
            app: actor,
            toolbox: null,
            button: new WindowTrackingButton({ window: actor.meta_window })
        }));
        return true;
    },

    addToolboxWindow: function(actor) {
        if (!global.settings.get_boolean('enable-code-view'))
            return false;

        let window = actor.meta_window;
        let isSpeedwagonForToolbox = _isToolboxSpeedwagon(window);

        if (!_isToolbox(window.get_flatpak_id()) &&
            !isSpeedwagonForToolbox)
            return false;

        // Get the last session in the list - we assume that we are
        // adding a toolbox to this window
        let session = this._sessions[this._sessions.length - 1];
        if (!session)
            return false;

        return session.admitToolboxWindowActor(actor);
    },

    removeAppWindow: function(actor) {
        let window = actor.meta_window;
        if (!_isCodingApp(window.get_flatpak_id()))
            return false;

        let session = this._getSession(actor);
        if (!session)
            return false;

        // Destroy the session here and remove it from the list
        session.destroy();

        let idx = this._sessions.indexOf(session);
        if (idx === -1)
            return false;

        this._sessions.splice(idx, 1);
        return true;
    },

    removeToolboxWindow: function(actor) {
        let window = actor.meta_window;
        let isSpeedwagonForToolbox = _isToolboxSpeedwagon(window);

        if (!_isToolbox(window.get_flatpak_id()) &&
            !isSpeedwagonForToolbox)
            return false;

        let session = this._getSession(actor);
        if (!session)
            return false;

        // We can remove either a speedwagon window or a normal toolbox window.
        // That window will be registered in the session at this point.
        session.removeToolboxWindow();
        return true;
    },

    killEffectsOnActor: function(actor) {
        let session = this._getSession(actor);
        if (session)
            session.killEffects();
    },

    _getSession: function(actor) {
        for (let i = 0; i < this._sessions.length; i++) {
            let session = this._sessions[i];
            if (session.app === actor || session.toolbox === actor)
                return session;
        }

        return null;
    }
});
