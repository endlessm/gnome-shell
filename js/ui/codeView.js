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
const SoundServer = imports.misc.soundServer;

const WINDOW_ANIMATION_TIME = 0.25;

const STATE_APP = 0;
const STATE_TOOLBOX = 1;

const _HACKABLE_DESKTOP_KEY = 'X-Endless-Hackable';
const _HACK_SHADER_DESKTOP_KEY = 'X-Endless-HackShader';

const _HACK_SHADER_MAP = {
    'none': null,
    'desaturate': { constructor: Shell.CodeViewEffect,
                    colors: ['#05213f', '#031c39', '#00275c', '#8d6531', '#f4f1a2'],
                    points: [0.00, 0.07, 0.32, 0.65, 1.00] },
    'fizzics': { constructor: Shell.CodeViewEffect,
                 colors: ['#05213f', '#031c39', '#114283', '#b27220', '#f4f1a2'],
                 points: [0.00, 0.10, 0.20, 0.60, 1.00] },
};
const _HACK_DEFAULT_SHADER = 'desaturate';

function _ensureAfterFirstFrame(win, callback) {
    if (win._drawnFirstFrame) {
        callback();
        return;
    }

    let firstFrameConnection = win.connect('first-frame', () => {
        win.disconnect(firstFrameConnection);
        callback();
    });
};

function _getAppId(win) {
    let app = Shell.WindowTracker.get_default().get_window_app(win);
    // remove .desktop suffix
    return app.get_id().slice(0, -8);
};

function _getWindowId(win) {
    if (win.gtk_window_object_path)
        return win.gtk_window_object_path;
    return ('window:%d').format(win.get_stable_sequence());
};

const _ensureHackDataFile = (function () {
    let keyfile = new GLib.KeyFile();
    let initialized = false;

    const flatpakInstallationPaths = [
        GLib.build_filenamev([GLib.get_home_dir(), '.local/share/flatpak']),
        '/var/lib/flatpak',
    ];
    const flatpakPath = 'app/com.endlessm.HackComponents/current/active/files';
    const fileRelPath = 'share/hack-components';
    const searchPaths = flatpakInstallationPaths.map(installation =>
        GLib.build_filenamev([installation, flatpakPath, fileRelPath]));

    return function() {
        if (initialized)
            return keyfile;

        try {
            keyfile.load_from_dirs('hack-data.ini', searchPaths,
                GLib.KeyFileFlags.NONE);
        } catch (err) {
            if (!err.matches(GLib.FileError, GLib.FileError.NOENT) &&
                !err.matches(GLib.KeyFileError, GLib.KeyFileError.NOT_FOUND))
                logError(err, 'Error reading hack data file');
            keyfile = null;
        }

        initialized = true;
        return keyfile;
    }
}());

function _isBlacklistedApp(desktop_id) {
    const keyfile = _ensureHackDataFile();
    if (keyfile === null)
        return false;

    const app_id = desktop_id.slice(0, -8);  // remove ".desktop"
    let blacklist;
    try {
        [blacklist] = keyfile.get_string_list('flip-to-hack', 'blacklist');
    } catch (err) {
        if (!err.matches(GLib.KeyFileError, GLib.KeyFileError.KEY_NOT_FOUND) &&
            !err.matches(GLib.KeyFileError, GLib.KeyFileError.GROUP_NOT_FOUND))
            logError(err, 'Error with blacklist in hack data file');
        blacklist = [];
    }

    return blacklist.includes(app_id);
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
    button.set_position(rect.x,
                        rect.y + (rect.height - button.height) / 2);
}

function _getViewSourceButtonParams(interactive) {
    return {
        style_class: 'view-source',
        x_fill: true,
        y_fill: true,
        reactive: interactive,
        can_focus: interactive,
        track_hover: interactive,
        clip_to_allocation: true
    }
}

function _setFlippedState(button, flipped) {
    if (flipped)
        button.add_style_class_name('back');
    else
        button.remove_style_class_name('back');
}

function _flipButtonAroundRectCenter(props) {
    let {
        button,
        rect,
        startAngle,
        midpointAngle,
        finishAngle,
        onRotationMidpoint,
        onRotationComplete,
    } = props;

    // this API is deprecated but the best option here to
    // animate around a point outside of the actor
    button.rotation_center_y = new Clutter.Vertex({
        x: rect.width * 0.5,
        y: button.height * 0.5,
        z: 0
    });
    button.rotation_angle_y = startAngle;
    Tweener.addTween(button, {
        rotation_angle_y: midpointAngle,
        time: WINDOW_ANIMATION_TIME * 2,
        transition: 'easeInQuad',
        onComplete: function() {
            if (onRotationMidpoint)
                onRotationMidpoint();
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
}

var WindowTrackingButton = new Lang.Class({
    Name: 'WindowTrackingButton',
    Extends: St.Button,

    _init: function(params) {
        this._flipped = false;
        this._rect = null;

        let buttonParams = _getViewSourceButtonParams(true);
        params = Params.parse(params, buttonParams, true);

        this.parent(params);

        this.connect('notify::hover', this._onHoverChanged.bind(this));
    },

    vfunc_allocate: function(box, flags) {
        this.parent(box, flags);

        if (this._rect)
            _synchronizeViewSourceButtonToRectCorner(this, this._rect);
    },

    // Just fade out and fade the button back in again. This makes it
    // look as though we have two buttons, but in reality we just have
    // one.
    switchAnimation: function(direction, targetState) {
        // Start an animation for flipping the main button around the
        // center of the rect.
        _flipButtonAroundRectCenter({
            button: this,
            rect: this._rect,
            startAngle: 0,
            midpointAngle: direction == Gtk.DirectionType.RIGHT ? 90 : -90,
            finishAngle: direction == Gtk.DirectionType.RIGHT ? 180 : -180,
            onRotationMidpoint: () => {
                this.opacity = 0;
                this.state = targetState;
            },
            onRotationComplete: () => {
                Tweener.removeTweens(this);
                this.rotation_angle_y = 0;
                this.opacity = 255;
            },
        });

        // Create a temporary button which we'll use to show a "flip-in"
        // animation along with the incoming window. This is removed as soon
        // as the animation is complete.
        let animationButton = new St.Button(_getViewSourceButtonParams(false));
        Main.layoutManager.uiGroup.add_actor(animationButton);
        _synchronizeViewSourceButtonToRectCorner(animationButton, this._rect);

        animationButton.opacity = 0;
        _flipButtonAroundRectCenter({
            button: animationButton,
            rect: this._rect,
            startAngle: direction == Gtk.DirectionType.RIGHT ? -180 : 180,
            midpointAngle: direction == Gtk.DirectionType.RIGHT ? -90 : 90,
            finishAngle: 0,
            onRotationMidpoint: () => {
                animationButton.opacity = 255;
                _setFlippedState(animationButton, targetState == STATE_TOOLBOX);
            },
            onRotationComplete: () => {
                animationButton.destroy();
            }
        });
    },

    set rect(value) {
        this._rect = value;
        this.queue_relayout();
    },

    set state(value) {
        this._flipped = value == STATE_TOOLBOX;
        _setFlippedState(this, this._flipped);
    },

    _startHoverSound(flipped) {
        if (this._hoverSoundID === 'pending')
            return;
        if (this._hoverSoundID === 'cancel') {
            // Hovered in and out and back in quickly, before the first UUID was
            // returned. In this case, un-cancel the original sound but don't
            // request another one.
            this._hoverSoundID = 'pending';
            return;
        }
        this._hoverSoundID = 'pending';
        const id = flipped ? 'flip-inverse' : 'flip';
        SoundServer.getDefault().playAsync(`shell/tracking-button/${id}/hover`)
        .then(uuid => {
            if (this._hoverSoundID === 'cancel') {
                SoundServer.getDefault().stop(uuid);
                this._hoverSoundID = null;
                return;
            }

            this._hoverSoundID = uuid;
        });
    },

    _stopHoverSound() {
        if (this._hoverSoundID === 'pending') {
            this._hoverSoundID = 'cancel';
        } else if (this._hoverSoundID) {
            SoundServer.getDefault().stop(this._hoverSoundID);
            this._hoverSoundID = null;
        }
    },

    _onHoverChanged: function() {
        if (this.hover) {
            if (!this._flipped) {
                SoundServer.getDefault().play('shell/tracking-button/flip/enter');
                this._startHoverSound(false);
            } else {
                SoundServer.getDefault().play('shell/tracking-button/flip-inverse/enter');
                this._startHoverSound(true);
            }
        } else {
            this._stopHoverSound();
        }
    }
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
        this._constrainGeometryIdApp = 0;
        this._constrainGeometryIdToolbox = 0;

        this._state = STATE_APP;
        this._toolboxActionGroup = null;

        this.parent(params);

        // FIXME: this should be extended to make it possible to launch
        // arbitrary toolboxes in the future, depending on the application
        this._toolboxAppActionGroup =
            Gio.DBusActionGroup.get(Gio.DBus.session,
                                    'com.endlessm.HackToolbox',
                                    '/com/endlessm/HackToolbox');
        this._toolboxAppActionGroup.list_actions();

        this._overviewHiddenId = Main.overview.connect('hidden',
                                                       this._overviewStateChanged.bind(this));
        this._overviewShowingId = Main.overview.connect('showing',
                                                        this._overviewStateChanged.bind(this));
        this._sessionModeChangedId = Main.sessionMode.connect('updated',
                                                              this._syncButtonVisibility.bind(this));
        this._focusWindowId = global.display.connect('notify::focus-window',
                                                     this._focusWindowChanged.bind(this));
        this._fullscreenId = global.screen.connect('in-fullscreen-changed',
                                                   this._syncButtonVisibility.bind(this));
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

    _ensureButton: function() {
        if (this._button)
            return;

        let actor = this._actorForCurrentState();
        if (!actor)
            return;

        this._button = new WindowTrackingButton();
        this._button.connect('clicked', this._switchWindows.bind(this));

        _ensureAfterFirstFrame(actor, () => {
            Main.layoutManager.addChrome(this._button);
            this._synchronizeButton(actor.meta_window);
        });
    },

    _updateWindowPairingState: function() {
        let actor = this._actorForCurrentState();
        if (!actor)
            return;

        actor.meta_window._hackIsInactiveWindow = false;

        let otherActor = this._getOtherActor(actor);
        if (otherActor)
            otherActor.meta_window._hackIsInactiveWindow = true;
    },

    _setState: function(value, includeButton=true) {
        this._state = value;
        if (includeButton)
            this._button.state = value;
        this._updateWindowPairingState();
    },

    _setupAnimation: function(targetState, src, oldDst, newDst, direction) {
        if (this._state === targetState)
            return;

        // Bail out if we are already running an animation.
        if (this._rotatingInActor || this._rotatingOutActor)
            return;

        this._setState(targetState, false);

        // Now, if we're not already on the desired state, we want to start
        // animating to it here.
        this._prepareAnimate(src, oldDst, newDst, direction);

        // We wait until the first frame of the window has been drawn
        // and damage updated in the compositor before we start rotating.
        //
        // This way we don't get ugly artifacts when rotating if
        // a window is slow to draw.
        _ensureAfterFirstFrame(newDst,
                               this._completeAnimate.bind(this, src, oldDst, newDst,
                                                          direction, targetState));
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
        return actor && actor.meta_window === window;
    },

    _getOtherActor: function(actor) {
        if (!this._isActorFromSession(actor))
            return null;

        return actor === this.app ? this.toolbox : this.app;
    },

    _setEffectsEnabled: function(actor, enabled) {
        let effect = actor.get_effect('codeview-effect');
        if (effect) {
            effect.enabled = enabled;
        } else {
            let appInfo = this._shellApp.get_app_info();
            let shaderEffect = appInfo.get_string(_HACK_SHADER_DESKTOP_KEY);
            if (!shaderEffect)
                shaderEffect = _HACK_DEFAULT_SHADER;

            let shaderDef = _HACK_SHADER_MAP[shaderEffect];
            if (shaderDef) {
                effect = new shaderDef.constructor({enabled});
                effect.set_gradient_stops(shaderDef.colors, shaderDef.points);
                actor.add_effect_with_name('codeview-effect', effect);
            }
        }
    },

    _completeRemoveWindow: function() {
        let actor = this._actorForCurrentState();

        if (actor) {
            actor.rotation_angle_y = 0;
            this._setEffectsEnabled(actor, false);
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
        this._constrainGeometryIdToolbox =
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

        if (this._constrainGeometryIdToolbox) {
            this.toolbox.meta_window.disconnect(this._constrainGeometryIdToolbox);
            this._constrainGeometryIdToolbox = 0;
        }
    },

    _setupAppWindow: function() {
        this._positionChangedIdApp =
            this.app.meta_window.connect('position-changed',
                                         this._synchronizeWindows.bind(this));
        this._sizeChangedIdApp =
            this.app.meta_window.connect('size-changed',
                                         this._synchronizeWindows.bind(this));
        this._constrainGeometryIdApp =
            this.app.meta_window.connect('geometry-allocate',
                                         this._constrainGeometry.bind(this));

        if (this.app.meta_window.gtk_application_id) {
            this._appActionProxy =
                Gio.DBusActionGroup.get(Gio.DBus.session,
                                        this.app.meta_window.gtk_application_id,
                                        this.app.meta_window.gtk_application_object_path);
            this._appActionProxy.list_actions();
        } else {
            this._appActionProxy = null;
        }

        let windowTracker = Shell.WindowTracker.get_default();
        this._shellApp = windowTracker.get_window_app(this.app.meta_window);

        this._ensureButton();
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
        if (this._constrainGeometryIdApp) {
            this.app.meta_window.disconnect(this._constrainGeometryIdApp);
            this._constrainGeometryIdApp = 0;
        }

        this._appActionProxy = null;
    },

    removeAppWindow: function() {
        // Save the actor, so we can complete the destroy transition later
        if (this.appRemovedByFlipBack)
            this._appRemovedActor = this.app;

        this.appRemovedByFlipBack = false;
        this.app = null;

        this._setState(STATE_TOOLBOX);

        this._completeRemoveWindow();
    },

    // Eject out of this session and remove all pairings.
    // Remove all connected signals and close the toolbox as well, if we have one.
    //
    // The assumption here is that the session will be removed immediately
    // after destruction.
    destroy: function() {
        if (this._focusWindowId != 0) {
            global.display.disconnect(this._focusWindowId);
            this._focusWindowId = 0;
        }
        if (this._overviewHiddenId) {
            Main.overview.disconnect(this._overviewHiddenId);
            this._overviewHiddenId = 0;
        }
        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = 0;
        }
        if (this._sessionModeChangedId) {
            Main.sessionMode.disconnect(this._sessionModeChangedId);
            this._sessionModeChangedId = 0;
        }
        if (this._windowMinimizedId !== 0) {
            global.window_manager.disconnect(this._windowMinimizedId);
            this._windowMinimizedId = 0;
        }
        if (this._windowUnminimizedId !== 0) {
            global.window_manager.disconnect(this._windowUnminimizedId);
            this._windowUnminimizedId = 0;
        }

        // If we have an app window, disconnect any signals and destroy it.
        if (this.app) {
            let appWindow = this.app.meta_window;
            this.app = null;
            this._shellApp = null;

            appWindow.delete(global.get_current_time());
        }

        // If we have a toolbox window, disconnect any signals and destroy it.
        if (this.toolbox) {
            let toolboxWindow = this.toolbox.meta_window;
            this.toolbox = null;

            toolboxWindow.delete(global.get_current_time());
        }

        // Destroy the button too
        this._button.destroy();
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
                new GLib.Variant('(ss)', [_getAppId(this.app.meta_window),
                                          _getWindowId(this.app.meta_window)]));
            this._button.reactive = false;
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
            this._button.reactive = false;
        } else {
            this._setupAnimation(STATE_APP,
                                 this.toolbox,
                                 null, this.app,
                                 Gtk.DirectionType.RIGHT);
        }
    },

    _synchronizeButton: function(window) {
        this._button.rect = window.get_frame_rect();
    },

    _synchronizeWindows: function(window) {
        if (!this._isCurrentWindow(window))
            return;

        this._synchronizeButton(window);

        if (!this._windowsNeedSync())
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
        // minimized.
        if (toUnMini && toUnMini.meta_window.minimized)
            toUnMini.meta_window.unminimize();
    },

    _overviewStateChanged: function() {
        let actor = this._actorForCurrentState();
        let otherActor = this._getOtherActor(actor);
        if (otherActor)
            this._setEffectsEnabled(otherActor, !Main.overview.visible);

        this._syncButtonVisibility();
    },

    _syncButtonVisibility: function() {
        let focusedWindow = global.display.get_focus_window();
        if (!focusedWindow)
            return;

        // Don't show if the screen is locked
        let locked = Main.sessionMode.isLocked;

        let primaryMonitor = Main.layoutManager.primaryMonitor;
        let inFullscreen = primaryMonitor && primaryMonitor.inFullscreen;

        // Show only if either this window or the toolbox window
        // is in focus
        let focusedActor = focusedWindow.get_compositor_private();
        if (this._isActorFromSession(focusedActor) &&
            !Main.overview.visible &&
            !inFullscreen &&
            !locked)
            this._button.show();
        else
            this._button.hide();
    },

    _activateAppFlip: function() {
        // Support a 'flip' action in the app, if it exposes it
        const flipState = (this._state == STATE_TOOLBOX);
        if (this._appActionProxy && this._appActionProxy.has_action('flip'))
            this._appActionProxy.activate_action('flip', new GLib.Variant('b', flipState));
    },

    _focusWindowChanged: function() {
        let focusedWindow = global.display.get_focus_window();
        if (!focusedWindow)
            return;

        this._syncButtonVisibility();

        let focusedActor = focusedWindow.get_compositor_private();
        if (!this._isActorFromSession(focusedActor))
            return;

        let actor = this._actorForCurrentState();
        if (actor !== focusedActor) {
            // FIXME: we probably selected this window from the overview or the taskbar.
            // Flipping makes little sense as the window has already been activated,
            // immediately change the state and reset any rotation for now.
            // In the future, we want to change the behavior of those activation points
            // so that when a toolbox is present, it is only possible to switch side
            // when the flip button is clicked.
            this._setState(focusedActor === this.app ? STATE_APP : STATE_TOOLBOX);
            this._activateAppFlip();
            focusedActor.rotation_angle_y = 0;
            actor.rotation_angle_y = 180;
            this._setEffectsEnabled(focusedActor, false);
            this._setEffectsEnabled(actor, true);
        }

        // Ensure correct stacking order by activating the window that just got focus.
        // shell_app_activate_window() will raise all the other windows of the app
        // while preserving stacking order.
        this._shellApp.activate_window(focusedActor.meta_window, global.get_current_time());
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

        // Pre-create the effect if it hasn't been already
        this._setEffectsEnabled(src, false);

        if (oldDst) {
            oldDst.rotation_angle_y = newDst.rotation_angle_y;
            oldDst.pivot_point = newDst.pivot_point;
        }
    },

    _playAnimationSound: function(direction) {
        if (direction == Gtk.DirectionType.LEFT)
            SoundServer.getDefault().play('shell/tracking-button/flip/click');
        else
            SoundServer.getDefault().play('shell/tracking-button/flip-inverse/click');
    },

    _completeAnimate: function(src, oldDst, newDst, direction, targetState) {
        this._animateToMidpoint(src,
                                oldDst,
                                newDst,
                                direction);
        this._button.switchAnimation(direction, targetState);
        this._playAnimationSound(direction);
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
        this._activateAppFlip();

        this._setEffectsEnabled(src, true);

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

        this._setEffectsEnabled(newDst, false);

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

        this._button.reactive = true;
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

    _addSession: function(actor) {
        this._sessions.push(new CodingSession({ app: actor }));
    },

    _removeSession: function(session) {
        // Destroy the session here and remove it from the list
        session.destroy();

        let idx = this._sessions.indexOf(session);
        if (idx === -1)
            return;

        this._sessions.splice(idx, 1);
    },

    _removeAppWindow: function(actor) {
        let session = this._getSession(actor, SessionLookupFlags.SESSION_LOOKUP_APP);
        if (!session)
            return false;

        if (session.appRemovedByFlipBack) {
            session.removeAppWindow();
            return true;
        }

        this._removeSession(session);

        return false;
    },

    _removeToolboxWindow: function(actor) {
        let session = this._getSession(actor, SessionLookupFlags.SESSION_LOOKUP_TOOLBOX);
        if (!session)
            return;

        this._removeSession(session);
    },

    handleDestroyWindow: function(actor) {
        let wasFlippedBack = this._removeAppWindow(actor);
        this._removeToolboxWindow(actor);

        return wasFlippedBack;
    },

    handleMapWindow: function(actor) {
        if (!global.settings.get_boolean('enable-code-view'))
            return false;

        // Do not manage apps that don't have an associated .desktop file
        let windowTracker = Shell.WindowTracker.get_default();
        let shellApp = windowTracker.get_window_app(actor.meta_window);
        let appInfo = shellApp.get_app_info();
        if (!appInfo)
            return false;

        // Do not manage apps that are NoDisplay=true, but take into account
        // the custom X-Endless-Hackable key to override that
        if (!appInfo.should_show() && !appInfo.get_boolean(_HACKABLE_DESKTOP_KEY))
            return false;

        // Do not manage apps that we blacklist in com.endlessm.HackComponents
        if (_isBlacklistedApp(appInfo.get_id()))
            return false;

        // It might be a "HackToolbox". Check that, and if so,
        // add it to the window group for the window.
        let proxy = Shell.WindowTracker.get_hack_toolbox_proxy(actor.meta_window);
        let handled = false;

        // This is a new proxy window, make it join the session
        if (proxy) {
            let variant = proxy.get_cached_property('Target');
            let [targetAppId, targetWindowId] = variant.deep_unpack();

            let session = this._getSessionForTargetAppWindow(
                targetAppId, targetWindowId);
            if (!session)
                session = this._getAvailableSessionForTargetApp(targetAppId);

            if (session)
                handled = session.admitToolboxWindowActor(actor);
        } else {
            // See if this is a new app window for an existing toolbox session
            let session = this._getSessionForToolboxTarget(
                _getAppId(actor.meta_window), _getWindowId(actor.meta_window));
            if (!session)
                session = this._getAvailableSessionForToolboxTarget(_getAppId(actor.meta_window));

            if (session)
                handled = session.admitAppWindowActor(actor);
            else
                // This is simply a new application window
                this._addSession(actor);
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
        return this._sessions.find((session) => {
            return (((session.app === actor) && (flags & SessionLookupFlags.SESSION_LOOKUP_APP)) ||
                    ((session.toolbox === actor) && (flags & SessionLookupFlags.SESSION_LOOKUP_TOOLBOX)));
        });
    },

    _getAvailableSessionForTargetApp: function(targetAppId) {
        return this._sessions.find((session) => {
            return (session.app &&
                    !session.toolbox &&
                    _getAppId(session.app.meta_window) == targetAppId);
        });
    },

    _getAvailableSessionForToolboxTarget: function(appId) {
        return this._sessions.find((session) => {
            if (!session.toolbox || session.app)
                return false;

            let proxy = Shell.WindowTracker.get_hack_toolbox_proxy(session.toolbox.meta_window);
            let variant = proxy.get_cached_property('Target');
            let [targetAppId, targetWindowId] = variant.deep_unpack();
            return (targetAppId == appId);
        });
    },

    _getSessionForTargetAppWindow: function(targetAppId, targetWindowId) {
        return this._sessions.find((session) => {
            return (session.app &&
                    _getAppId(session.app.meta_window) == targetAppId &&
                    _getWindowId(session.app.meta_window) == targetWindowId);
        });
    },

    _getSessionForToolboxTarget: function(appId, windowId) {
        return this._sessions.find((session) => {
            if (!session.toolbox)
                return false;

            let proxy = Shell.WindowTracker.get_hack_toolbox_proxy(session.toolbox.meta_window);
            let variant = proxy.get_cached_property('Target');
            let [targetAppId, targetWindowId] = variant.deep_unpack();
            return (targetAppId == appId && targetWindowId == windowId);
        });
    }
});
