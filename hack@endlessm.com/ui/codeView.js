// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported CodeViewManager */

const { Clutter, Gio, GLib, GObject, Gtk, Meta, Shell, St } = imports.gi;
const Mainloop = imports.mainloop;

const ExtensionUtils = imports.misc.extensionUtils;
const Hack = ExtensionUtils.getCurrentExtension();
const Settings = Hack.imports.utils.getSettings();

const Animation = imports.ui.animation.Animation;
const Clubhouse = Hack.imports.ui.clubhouse;
const Main = imports.ui.main;
const Params = imports.misc.params;
const Soundable = Hack.imports.ui.soundable;
const Service = Hack.imports.service;
const SoundServer = Hack.imports.misc.soundServer;

const WINDOW_ANIMATION_TIME = 250;


var CodingSessionStateEnum = {
    APP: 0,
    TOOLBOX: 1
};

const _HACKABLE_DESKTOP_KEY = 'X-Endless-Hackable';
const _HACK_SHADER_DESKTOP_KEY = 'X-Endless-HackShader';

const FLIP_BUTTON_WIDTH = 66;
const FLIP_BUTTON_HEIGHT = 124;
const FLIP_BUTTON_PULSE_SPEED = 100;

const _HACK_SHADER_MAP = {
    'none': null,
    'desaturate': {
        constructor: Shell.CodeViewEffect,
        colors: ['#05213f', '#031c39', '#00275c', '#8d6531', '#f4f1a2'],
        points: [0.00, 0.07, 0.32, 0.65, 1.00],
    },
    'fizzics': {
        constructor: Shell.CodeViewEffect,
        colors: ['#05213f', '#031c39', '#114283', '#b27220', '#f4f1a2'],
        points: [0.00, 0.10, 0.20, 0.60, 1.00],
    },
};
const _HACK_DEFAULT_SHADER = 'desaturate';

const HackableIface = `
<node>
  <interface name='com.hack_computer.Hackable'>
    <property name="Hackable" type="b" access="read"/>
  </interface>
</node>`;
const HackableProxy = Gio.DBusProxy.makeProxyWrapper(HackableIface);

const OldHackableIface = `
<node>
  <interface name='com.endlessm.Hackable'>
    <property name="Hackable" type="b" access="read"/>
  </interface>
</node>`;
const OldHackableProxy = Gio.DBusProxy.makeProxyWrapper(OldHackableIface);

function _ensureAfterFirstFrame(win, callback) {
    if (win._drawnFirstFrame) {
        callback();
        return;
    }

    let firstFrameConnection = win.connect('first-frame', () => {
        win.disconnect(firstFrameConnection);
        callback();
    });
}

function _getAppId(win) {
    let app = Shell.WindowTracker.get_default().get_window_app(win);
    let gtkId = win.get_gtk_application_id();
    if (gtkId)
        return gtkId;

    // remove .desktop suffix
    return app.get_id().slice(0, -8);
}

function _getWindowId(win) {
    if (win.gtk_window_object_path)
        return win.gtk_window_object_path;
    return ('window:%d').format(win.get_stable_sequence());
}

function _getToolboxTarget(win) {
    let proxy = Shell.WindowTracker.get_hack_toolbox_proxy(win);
    let variant = proxy.get_cached_property('Target');
    let [targetAppId, targetWindowId] = variant.deep_unpack();
    return [targetAppId, targetWindowId];
}

const _ensureHackDataFile = (function () {
    let keyfile = new GLib.KeyFile();
    let initialized = false;
    let monitors = [];

    const flatpakInstallationPaths = [
        GLib.build_filenamev([GLib.get_home_dir(), '.local/share/flatpak']),
        '/var/lib/flatpak',
    ];

    return function() {
        if (initialized)
            return keyfile;

        const componentsId = Clubhouse.getClubhouseApp() ? 'com.hack_computer.Clubhouse' : 'com.endlessm.HackComponents';
        const flatpakPath = `app/${componentsId}/current/active/files`;
        const fileRelPath = 'share/hack-components';
        const searchPaths = flatpakInstallationPaths.map(installation =>
            GLib.build_filenamev([installation, flatpakPath, fileRelPath]));

        // Only create file monitors the first time
        if (monitors.length === 0) {
            for (let path of searchPaths) {
                path = GLib.build_filenamev([path, 'hack-data.ini']);
                const file = Gio.file_new_for_path(path);
                const monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
                monitor.connect('changed', (_monitor, _file, _otherfile, ev, _data) => {
                    if (ev === Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
                        // forces the keyfile reload the next time the function is called
                        keyfile = new GLib.KeyFile();
                        initialized = false;
                    }
                });
                // we keep a reference to the monitor object to avoid destroy and
                // signal disconnection
                monitors.push(monitor);
            }
        }

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
    };
}());

function _appIsBlockedFromHacking(desktopId) {
    const keyfile = _ensureHackDataFile();
    if (keyfile === null)
        return false;

    const appId = desktopId.slice(0, -8);  // remove ".desktop"
    let blockList;
    try {
        [blockList] = keyfile.get_string_list('flip-to-hack', 'blacklist');
    } catch (err) {
        if (!err.matches(GLib.KeyFileError, GLib.KeyFileError.KEY_NOT_FOUND) &&
            !err.matches(GLib.KeyFileError, GLib.KeyFileError.GROUP_NOT_FOUND))
            logError(err, 'Error with block list in hack data file');
        blockList = [];
    }

    return blockList.includes(appId);
}

function _appIsAllowedHacking(desktopId) {
    const keyfile = _ensureHackDataFile();
    if (keyfile === null)
        return true;

    const appId = desktopId.slice(0, -8);  // remove ".desktop"
    let allowOnlyList;
    try {
        [allowOnlyList] = keyfile.get_string_list('flip-to-hack', 'whitelist');
    } catch (err) {
        if (!err.matches(GLib.KeyFileError, GLib.KeyFileError.KEY_NOT_FOUND) &&
            !err.matches(GLib.KeyFileError, GLib.KeyFileError.GROUP_NOT_FOUND))
            logError(err, 'Error with allow-only list in hack data file');
        allowOnlyList = [];
    }

    if (allowOnlyList.length === 0)
        return true;
    return allowOnlyList.includes(appId);
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
        dst.meta_window.move_resize_frame(true,
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
        clip_to_allocation: true,
    };
}

function _setFlippedState(button, flipped) {
    if (flipped)
        button.add_style_class_name('back');
    else
        button.remove_style_class_name('back');
}

function _setDimmedState(button, dimmed) {
    if (dimmed)
        button.add_style_class_name('dimmed');
    else
        button.remove_style_class_name('dimmed');
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
    button.ease_property('rotation_angle_y', midpointAngle, {
        duration: WINDOW_ANIMATION_TIME * 2,
        mode: Clutter.AnimationMode.EASE_IN_QUAD,
        onComplete: () => {
            if (onRotationMidpoint)
                onRotationMidpoint();
            button.ease_property('rotation_angle_y', finishAngle, {
                duration: WINDOW_ANIMATION_TIME * 2,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (onRotationComplete)
                        onRotationComplete();
                }
            });
        }
    });
}

var WindowTrackingButton = GObject.registerClass({
    Signals: {
        'clicked': {}
    },
}, class WindowTrackingButton extends Soundable.Button {
    _init(params) {
        this._flipped = false;
        this._rect = null;
        this._highlighted = false;

        let buttonParams = _getViewSourceButtonParams(true);
        params = Params.parse(params, buttonParams, true);

        super._init(params);

        this._updateSounds();

        // pulse effect
        let gfile = Gio.File.new_for_uri('resource:///org/gnome/shell/theme/flip-glow.png');
        this._pulseAnimation = new Animation(gfile,
            FLIP_BUTTON_WIDTH,
            FLIP_BUTTON_HEIGHT,
            FLIP_BUTTON_PULSE_SPEED);
        this._pulseIcon = this._pulseAnimation.actor;
    }

    get highlighted() {
        return this._highlighted;
    }

    set highlighted(value) {
        if (this._highlighted === value)
            return;

        if (value) {
            this.child = this._pulseIcon;
            this._pulseAnimation.play();
        } else {
            this._pulseAnimation.stop();
            this.child = null;
        }

        this._highlighted = value;
    }

    vfunc_allocate(box, flags) {
        super.vfunc_allocate(box, flags);

        if (this._rect)
            _synchronizeViewSourceButtonToRectCorner(this, this._rect);
    }

    // Just fade out and fade the button back in again. This makes it
    // look as though we have two buttons, but in reality we just have
    // one.
    switchAnimation(direction, targetState) {
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
                _setFlippedState(animationButton, targetState == CodingSessionStateEnum.TOOLBOX);
            },
            onRotationComplete: () => {
                animationButton.destroy();
            }
        });
    }

    set rect(value) {
        this._rect = value;
        this.queue_relayout();
    }

    set state(value) {
        this._flipped = value == CodingSessionStateEnum.TOOLBOX;
        _setFlippedState(this, this._flipped);
        this._updateSounds();
    }

    _updateSounds() {
        const id = this._flipped ? 'flip-inverse' : 'flip';
        this.enter_sound_event_id = `shell/tracking-button/${id}/enter`;
        this.hover_sound_event_id = `shell/tracking-button/${id}/hover`;
    }
});

const SessionDestroyEvent = {
    SESSION_DESTROY_APP_DESTROYED: 0,
    SESSION_DESTROY_TOOLBOX_DESTROYED: 1,
};

var CodingSession = GObject.registerClass({
    Properties: {
        'app': GObject.ParamSpec.object('app',
            '',
            '',
            GObject.ParamFlags.READWRITE,
            Meta.WindowActor),
        'state': GObject.ParamSpec.int('state',
            '',
            '',
            GObject.ParamFlags.READABLE,
            0, Object.keys(CodingSessionStateEnum).length,
            CodingSessionStateEnum.APP),
        'toolbox': GObject.ParamSpec.object('toolbox',
            '',
            '',
            GObject.ParamFlags.READWRITE,
            Meta.WindowActor),
    },
    Signals: {
        'minimized': {},
        'unminimized': {},
    },
}, class CodingSession extends GObject.Object {
    _init(params) {
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
        this._notifyVisibleIdApp = 0;
        this._notifyVisibleIdToolbox = 0;

        this._state = CodingSessionStateEnum.APP;
        this._toolboxActionGroup = null;
        this._toolboxAppActionGroup = null;

        this._hackableProxy = null;
        this._hackablePropsChangedId = 0;
        this._hackable = true;

        this._grabbed = false;
        this._backParent = null;
        this._backConstraint = null;
        this._grabTimeoutId = 0;

        super._init(params);
        this._hackableApp = new Service.HackableApp(this);

        this._initToolboxAppActionGroup();

        this._hackModeChangedId = Settings.connect('changed::hack-mode-enabled',
            this._syncButtonVisibility.bind(this));
        this._overviewHiddenId = Main.overview.connect('hidden',
            this._overviewStateChanged.bind(this));
        this._overviewShowingId = Main.overview.connect('showing',
            this._overviewStateChanged.bind(this));
        this._sessionModeChangedId = Main.sessionMode.connect('updated',
            this._syncButtonVisibility.bind(this));
        this._focusWindowId = global.display.connect('notify::focus-window',
            this._focusWindowChanged.bind(this));
        this._fullscreenId = global.display.connect('in-fullscreen-changed',
            this._syncButtonVisibility.bind(this));
        this._windowMinimizedId = global.window_manager.connect('minimize',
            this._applyWindowMinimizationState.bind(this));
        this._windowUnminimizedId = global.window_manager.connect('unminimize',
            this._applyWindowUnminimizationState.bind(this));
    }

    set app(value) {
        this._cleanupAppWindow();
        this._app = value;
        if (this._app)
            this._setupAppWindow();
        this.notify('app');
    }

    get app() {
        return this._app;
    }

    set state(value) {
        this._state = value;
        this.notify('state');
    }

    get state() {
        return this._state;
    }

    set toolbox(value) {
        this._cleanupToolboxWindow();
        this._toolbox = value;
        if (this._toolbox)
            this._setupToolboxWindow();
        this.notify('toolbox');
    }

    get toolbox() {
        return this._toolbox;
    }

    get toolboxId() {
        // FIXME: this should be extended to make it possible to launch
        // arbitrary toolboxes in the future, depending on the application
        let prefix = 'com.hack_computer';

        if (this.appId.startsWith('com.endlessm.'))
            prefix = 'com.endlessm';

        return `${prefix}.HackToolbox`;
    }

    get appId() {
        if (this.app)
            return _getAppId(this.app.meta_window);
        return null;
    }

    get hackableApp() {
        return this._hackableApp;
    }

    setGrabbed(grabbed) {
        if (this._grabTimeoutId > 0) {
            Mainloop.source_remove(this._grabTimeoutId);
            this._grabTimeoutId = 0;
        }

        if (grabbed) {
            this._attachBackendWindow();
            this._grabbed = true;
            this._syncButtonVisibility();
        } else {
            // giving some time to finish possible window movement FXs
            this._grabTimeoutId = Mainloop.timeout_add(500,
                () => {
                    Mainloop.source_remove(this._grabTimeoutId);
                    this._grabTimeoutId = 0;

                    this._detachBackendWindow();
                    this._grabbed = false;
                    this._syncButtonVisibility();
                    this._synchronizeButton(this._actorForCurrentState().meta_window);
                    return GLib.SOURCE_REMOVE;
                });
        }
    }

    _attachBackendWindow() {
        const frontActor = this._actorForCurrentState();
        const backActor = this._getOtherActor(frontActor);

        if (!backActor)
            return;

        this._backParent = backActor.get_parent();
        this._backParent.remove_child(backActor);
        frontActor.insert_child_at_index(backActor, 0);

        // Constraint to avoid inside actor movement
        const path = new Clutter.Path();
        path.add_move_to(0, 0);
        this._backConstraint = new Clutter.PathConstraint({ path: path, offset: 0 });
        backActor.add_constraint(this._backConstraint);
    }

    _detachBackendWindow() {
        const frontActor = this._actorForCurrentState();
        const backActor = this._getOtherActor(frontActor);

        if (!this._backParent || !backActor)
            return;

        if (this._backConstraint) {
            backActor.remove_constraint(this._backConstraint);
            this._backConstraint = null;
        }

        const [x, y] = frontActor.get_position();
        backActor.set_position(x, y);

        frontActor.remove_child(backActor);
        this._backParent.insert_child_below(backActor, frontActor);
        this._backParent = null;
    }

    _ensureButton() {
        if (this._button)
            return;

        let actor = this._actorForCurrentState();
        if (!actor)
            return;

        this._button = new WindowTrackingButton();
        this._button.connect('clicked', this._switchWindows.bind(this));

        // For now, only makes sense to monitor
        // hackable state if there is a button
        this._setupHackableProxy();

        _ensureAfterFirstFrame(actor, () => {
            Main.layoutManager.addChrome(this._button);
            // Position the button below the panel
            Main.layoutManager.uiGroup.set_child_below_sibling(
                this._button, Main.layoutManager.panelBox);
            this._synchronizeButton(actor.meta_window);
        });
    }

    _setupHackableProxy() {
        if (!this.app.meta_window.gtk_application_id)
            return;

        // Old hack apps should use the old Hackable proxy
        let appHackProxy = HackableProxy;
        if (this.appId.startsWith('com.endlessm.'))
            appHackProxy = OldHackableProxy;

        this._hackableProxy =
            new appHackProxy(Gio.DBus.session,
                this.app.meta_window.gtk_application_id,
                this.app.meta_window.gtk_application_object_path);
        this._hackablePropsChangedId =
            this._hackableProxy.connect('g-properties-changed',
                this._onHackablePropsChanged.bind(this));
    }

    _onHackablePropsChanged() {
        this._hackable = !!this._hackableProxy.Hackable;
        this._syncButtonVisibility();
    }

    _updateWindowPairingState() {
        let actor = this._actorForCurrentState();
        if (!actor)
            return;

        actor.meta_window._hackIsInactiveWindow = false;

        let otherActor = this._getOtherActor(actor);
        if (otherActor)
            otherActor.meta_window._hackIsInactiveWindow = true;
    }

    _setState(value, includeButton = true) {
        this.state = value;
        if (includeButton)
            this._button.state = value;
        this._updateWindowPairingState();
    }

    _setupAnimation(targetState, src, oldDst, newDst, direction) {
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
            this._completeAnimate.bind(this, src, oldDst, newDst, direction, targetState));
    }

    admitAppWindowActor(actor) {
        // If there is a currently bound window then we can't admit this window.
        if (this.app)
            return false;

        let appRemovedActor = this._appRemovedActor;
        this._appRemovedActor = null;

        // We can admit this window. Wire up signals and synchronize
        // geometries now.
        this.app = actor;

        this._setupAnimation(CodingSessionStateEnum.APP,
            this.toolbox,
            appRemovedActor, this.app,
            Gtk.DirectionType.RIGHT);
        return true;
    }

    // Maybe admit this actor if it is the kind of actor that we want
    admitToolboxWindowActor(actor) {
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

        this._setupAnimation(CodingSessionStateEnum.TOOLBOX,
            this.app,
            null, this.toolbox,
            Gtk.DirectionType.LEFT);
        return true;
    }

    _actorForCurrentState() {
        if (this._state == CodingSessionStateEnum.APP)
            return this.app;
        else
            return this.toolbox;
    }

    _isActorFromSession(actor) {
        return actor === this.app || actor === this.toolbox;
    }

    _isCurrentWindow(win) {
        let actor = this._actorForCurrentState();
        return actor && actor.meta_window === win;
    }

    _getOtherActor(actor) {
        if (!this._isActorFromSession(actor))
            return null;

        return actor === this.app ? this.toolbox : this.app;
    }

    _setEffectsEnabled(actor, enabled) {
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
                effect = new shaderDef.constructor({ enabled });
                effect.set_gradient_stops(shaderDef.colors, shaderDef.points);
                actor.add_effect_with_name('codeview-effect', effect);
            }
        }
    }

    _initToolboxAppActionGroup() {
        let toolboxId = this.toolboxId;
        let toolboxPath = `/${toolboxId.replace(/\./g, '/')}`;

        this._toolboxAppActionGroup =
            Gio.DBusActionGroup.get(Gio.DBus.session, toolboxId, toolboxPath);
        this._toolboxAppActionGroup.list_actions();
    }

    _setupToolboxWindow() {
        this._positionChangedIdToolbox =
            this.toolbox.meta_window.connect('position-changed',
                this._synchronizeWindows.bind(this));
        this._sizeChangedIdToolbox =
            this.toolbox.meta_window.connect('size-changed',
                this._synchronizeWindows.bind(this));
        this._constrainGeometryIdToolbox =
            this.toolbox.meta_window.connect('geometry-allocate',
                this._constrainGeometry.bind(this));
        this._notifyVisibleIdToolbox =
            this.toolbox.connect('notify::visible',
                this._syncButtonVisibility.bind(this));
    }

    _cleanupToolboxWindow() {
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
        if (this._notifyVisibleIdToolbox) {
            this.toolbox.disconnect(this._notifyVisibleIdToolbox);
            this._notifyVisibleIdToolbox = 0;
        }
    }

    _setupAppWindow() {
        this._positionChangedIdApp =
            this.app.meta_window.connect('position-changed',
                this._synchronizeWindows.bind(this));
        this._sizeChangedIdApp =
            this.app.meta_window.connect('size-changed',
                this._synchronizeWindows.bind(this));
        this._constrainGeometryIdApp =
            this.app.meta_window.connect('geometry-allocate',
                this._constrainGeometry.bind(this));
        this._notifyVisibleIdApp =
            this.app.connect('notify::visible',
                this._syncButtonVisibility.bind(this));

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
    }

    _cleanupAppWindow() {
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
        if (this._notifyVisibleIdApp) {
            this.app.disconnect(this._notifyVisibleIdApp);
            this._notifyVisibleIdApp = 0;
        }

        this._appActionProxy = null;
    }

    removeFlippedBackAppWindow() {
        if (!this.appRemovedByFlipBack)
            return false;

        // Save the actor, so we can complete the destroy transition later
        this._appRemovedActor = this.app;
        this.app = null;
        this.appRemovedByFlipBack = false;

        // We assume we have a toolbox here, or this.appRemovedByFlipBack would be false
        this._setState(CodingSessionStateEnum.TOOLBOX);

        let actor = this._actorForCurrentState();
        if (actor) {
            actor.rotation_angle_y = 0;
            this._setEffectsEnabled(actor, false);
            actor.show();
            actor.meta_window.activate(global.get_current_time());
        }

        return true;
    }

    // Eject out of this session and remove all pairings.
    // Remove all connected signals and close the toolbox as well, if we have one.
    //
    // The assumption here is that the session will be removed immediately
    // after destruction.
    destroy(eventType) {
        if (this._focusWindowId != 0) {
            global.display.disconnect(this._focusWindowId);
            this._focusWindowId = 0;
        }
        if (this._hackModeChangedId != 0) {
            Settings.disconnect(this._hackModeChangedId);
            this._hackModeChangedId = 0;
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

        if (this._hackablePropsChangedId !== 0) {
            this._hackableProxy.disconnect(this._hackablePropsChangedId);
            this._hackablePropsChangedId = 0;
        }

        if (this._grabTimeoutId !== 0) {
            Mainloop.source_remove(this._grabTimeoutId);
            this._grabTimeoutId = 0;
        }

        // If we have an app window, disconnect any signals and destroy it,
        // unless we are destroying the session because the app window was
        // destroyed in the first place
        if (this.app && !this.app.is_destroyed()) {
            let appWindow = this.app.meta_window;

            if (eventType != SessionDestroyEvent.SESSION_DESTROY_APP_DESTROYED) {
                appWindow.delete(global.get_current_time());
            } else if (this._state === CodingSessionStateEnum.TOOLBOX &&
                     this.toolbox && !this.toolbox.is_destroyed()) {
                this.app.rotation_angle_y = this.toolbox.rotation_angle_y;
            }

            this.app = null;
            this._shellApp = null;
        }

        // If we have a toolbox window, disconnect any signals and destroy it,
        // unless we are destroying the session because the toolbox window was
        // destroyed in the first place
        if (this.toolbox && !this.toolbox.is_destroyed()) {
            let toolboxWindow = this.toolbox.meta_window;
            this.toolbox = null;

            if (eventType != SessionDestroyEvent.SESSION_DESTROY_TOOLBOX_DESTROYED)
                toolboxWindow.delete(global.get_current_time());
        }

        // Destroy the button too
        this._button.destroy();
    }

    _windowsNeedSync() {
        // Synchronization is only needed when we have both an app and
        // a toolbox
        return this.app && this.toolbox;
    }

    _constrainGeometry(win) {
        if (!this._windowsNeedSync())
            return;

        if (!this._isCurrentWindow(win))
            return;

        // Get the minimum size of both the app and the toolbox window
        // and then determine the maximum of the two. We won't permit
        // either window to get any smaller.
        let [minAppWidth, minAppHeight] = this.app.meta_window.get_minimum_size_hints();
        let [minToolboxWidth, minToolboxHeight] = this.toolbox.meta_window.get_minimum_size_hints();

        // We need to compare these dimensions in frame coordinates, since
        // one of the two windows may be client-side decorated.
        let minAppRect = this.app.meta_window.client_rect_to_frame_rect(
            new Meta.Rectangle({ x: 0, y: 0, width: minAppWidth, height: minAppHeight }));
        let minToolboxRect = this.toolbox.meta_window.client_rect_to_frame_rect(
            new Meta.Rectangle({ x: 0, y: 0, width: minToolboxWidth, height: minToolboxHeight }));

        let minWidth = Math.max(minAppRect.width, minToolboxRect.width);
        let minHeight = Math.max(minAppRect.height, minToolboxRect.height);

        win.expand_allocated_geometry(minWidth, minHeight);
    }

    _switchWindows() {
        _setDimmedState(this._button, true);
        // Switch to toolbox if the app is active. Otherwise switch to the app.
        if (this._state === CodingSessionStateEnum.APP)
            this._switchToToolbox();
        else
            this._switchToApp();
    }

    // Switch to a toolbox window, launching it if we haven't yet launched it.
    //
    // Note that this is not the same as just rotating to the window - we
    // need to either launch the toolbox window if we don't have a reference
    // to it,  or we just need to switch to an existing toolbox window.
    //
    // This function and the one below do not check this._state to determine
    // if a flip animation should be played. That is the responsibility of
    // the caller.
    _switchToToolbox() {
        if (!this.toolbox) {
            this._toolboxAppActionGroup.activate_action(
                'flip',
                new GLib.Variant('(ss)', [
                    _getAppId(this.app.meta_window),
                    _getWindowId(this.app.meta_window),
                ]));
            this._button.reactive = false;
        } else {
            this._setupAnimation(CodingSessionStateEnum.TOOLBOX,
                this.app,
                null, this.toolbox,
                Gtk.DirectionType.LEFT);
        }
    }

    _switchToApp() {
        if (this._toolboxActionGroup.has_action('flip-back')) {
            this._toolboxActionGroup.activate_action('flip-back', null);
            this.appRemovedByFlipBack = true;
            this._button.reactive = false;
        } else {
            this._setupAnimation(CodingSessionStateEnum.APP,
                this.toolbox,
                null, this.app,
                Gtk.DirectionType.RIGHT);
        }
    }

    _synchronizeButton(win) {
        this._button.rect = win.get_frame_rect();
    }

    _synchronizeWindows(win) {
        if (!this._isCurrentWindow(win))
            return;

        this._synchronizeButton(win);

        if (!this._windowsNeedSync())
            return;

        let actor = win.get_compositor_private();
        _synchronizeMetaWindowActorGeometries(actor, this._getOtherActor(actor));
    }

    _applyWindowMinimizationState(shellwm, actor) {
        if (!this._isActorFromSession(actor))
            return;

        if (!this._isCurrentWindow(actor.meta_window))
            return;

        this._button.hide();

        let toMini = this._getOtherActor(actor);

        // Only want to minimize if we weren't already minimized.
        if (toMini && !toMini.meta_window.minimized)
            toMini.meta_window.minimize();

        this.emit('minimized');
    }

    _applyWindowUnminimizationState(shellwm, actor) {
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

        this.emit('unminimized');
    }

    _overviewStateChanged() {
        let actor = this._actorForCurrentState();
        let otherActor = this._getOtherActor(actor);
        if (otherActor)
            this._setEffectsEnabled(otherActor, !Main.overview.visible);

        this._syncButtonVisibility();
    }

    _syncButtonVisibility() {
        let focusedWindow = global.display.get_focus_window();
        if (!focusedWindow)
            return;

        // Don't show if the screen is locked
        let locked = Main.sessionMode.isLocked;

        let primaryMonitor = Main.layoutManager.primaryMonitor;
        let inFullscreen = primaryMonitor && primaryMonitor.inFullscreen;

        if (!Settings.get_boolean('hack-mode-enabled')) {
            this._button.hide();
            return;
        }

        // Show only if either this window or the toolbox window
        // is in focus, visible and hackable
        let focusedActor = focusedWindow.get_compositor_private();
        if (this._isActorFromSession(focusedActor) &&
            focusedActor.visible &&
            !Main.overview.visible &&
            !inFullscreen &&
            !locked &&
            !this._grabbed &&
            this._hackable) {

            if (!this.toolbox) {
                this._toolboxAppActionGroup.activate_action(
                    'init',
                    new GLib.Variant('(ss)', [
                        _getAppId(this.app.meta_window),
                        _getWindowId(this.app.meta_window),
                    ]));
            }

            this._button.show();
        } else
            this._button.hide();
    }

    _restoreButtonState() {
        this._button.reactive = true;
        // Not sure why, but we need to resync the button visibility
        // here, or it won't appear as reactive sometimes.
        this._button.hide();
        this._syncButtonVisibility();
    }

    _activateAppFlip() {
        // Support a 'flip' action in the app, if it exposes it
        const flipState = (this._state == CodingSessionStateEnum.TOOLBOX);
        if (this._appActionProxy && this._appActionProxy.has_action('flip'))
            this._appActionProxy.activate_action('flip', new GLib.Variant('b', flipState));
    }

    _focusWindowChanged() {
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
            this._setState(focusedActor === this.app ?
                CodingSessionStateEnum.APP : CodingSessionStateEnum.TOOLBOX);
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
    }

    _prepareAnimate(src, oldDst, newDst, direction) {
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
    }

    _playAnimationSound(direction) {
        if (direction == Gtk.DirectionType.LEFT)
            SoundServer.getDefault().play('shell/tracking-button/flip/click');
        else
            SoundServer.getDefault().play('shell/tracking-button/flip-inverse/click');
    }

    _completeAnimate(src, oldDst, newDst, direction, targetState) {
        this._animateToMidpoint(src, oldDst, newDst, direction);
        this._button.switchAnimation(direction, targetState);
        this._playAnimationSound(direction);
    }

    _animateToMidpoint(src, oldDst, newDst, direction) {
        // Tween both windows in a rotation animation at the same time.
        // This will allow for a smooth transition.
        src.ease_property(
            'rotation_angle_y',
            direction == Gtk.DirectionType.RIGHT ? 90 : -90,
            {
                duration: WINDOW_ANIMATION_TIME * 2,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: this._rotateOutToMidpointCompleted.bind(this, src, direction),
            });

        let dst = oldDst ? oldDst : newDst;
        dst.ease_property(
            'rotation_angle_y',
            direction == Gtk.DirectionType.RIGHT ? -90 : 90,
            {
                duration: WINDOW_ANIMATION_TIME * 2,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: this._rotateInToMidpointCompleted.bind(this, oldDst, newDst, direction),
            });
    }

    _rotateOutToMidpointCompleted(src, direction) {
        this._activateAppFlip();

        this._setEffectsEnabled(src, true);

        src.ease_property(
            'rotation_angle_y',
            direction == Gtk.DirectionType.RIGHT ? 180 : -180,
            {
                duration: WINDOW_ANIMATION_TIME * 2,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: this._rotateOutCompleted.bind(this, false),
            });
    }

    _rotateInToMidpointCompleted(oldDst, newDst, _direction) {
        if (oldDst) {
            newDst.rotation_angle_y = oldDst.rotation_angle_y;
            global.window_manager.completed_destroy(oldDst);
        }

        _setDimmedState(this._button, false);
        this._setEffectsEnabled(newDst, false);

        // Now show the destination
        newDst.meta_window.activate(global.get_current_time());
        newDst.opacity = 255;

        newDst.ease_property('rotation_angle_y', 0, {
            duration: WINDOW_ANIMATION_TIME * 2,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._restoreButtonState();
                this._rotateInCompleted();
            }
        });
    }

    // We need to keep these separate here so that they can be called
    // by killEffects later if required.
    _rotateInCompleted() {
        let actor = this._rotatingInActor;
        if (!actor)
            return;

        actor.rotation_angle_y = 0;
        actor.opacity = 255;
        this._rotatingInActor = null;
    }

    _rotateOutCompleted(resetRotation) {
        let actor = this._rotatingOutActor;
        if (!actor)
            return;

        if (resetRotation)
            actor.rotation_angle_y = 0;
        this._rotatingOutActor = null;
    }

    killEffects() {
        this._rotateInCompleted();
        this._rotateOutCompleted(true);
    }
});

const SessionLookupFlags = {
    SESSION_LOOKUP_APP: 1 << 0,
    SESSION_LOOKUP_TOOLBOX: 1 << 1,
};


var CodeViewManager = GObject.registerClass({
    Signals: {
        'session-added': { param_types: [GObject.TYPE_OBJECT] },
        'session-removed': { param_types: [GObject.TYPE_OBJECT] }
    },
}, class CodeViewManager extends GObject.Object {
    _init(params) {
        super._init(params);

        this._sessions = [];

        global.display.connect('window-created', (display, win) => {
            let windowActor = win.get_compositor_private();
            windowActor._drawnFirstFrame = false;
            windowActor.connect('first-frame', () => {
                windowActor._drawnFirstFrame = true;
            });
        });

        Settings.connect('changed::hack-mode-enabled', () => {
            let activated = Settings.get_boolean('hack-mode-enabled');
            if (!activated) {
                this._sessions.forEach((session) => {
                    let eventType = SessionDestroyEvent.SESSION_DESTROY_APP_DESTROYED;
                    this._removeSession(session, eventType);
                });
            } else {
                // enable FtH for all windows!
                global.get_window_actors().forEach((actor) => {
                    this.handleMapWindow(actor);
                });

                this._sessions.forEach((session) => {
                    session._syncButtonVisibility();
                });
            }
        });

        this._stopped = false;
        global.window_manager.connect('stop', () => {
            this._stopped = true;
        });
    }

    get sessions() {
        return this._sessions;
    }

    _addSession(actor) {
        let session = new CodingSession({ app: actor });

        // When the app is minimized the WM doesn't emit the destroy signal if
        // the app is closed, for this reason we need to listen to the 'destroy'
        // signal of the actor if it's minimized, to be able to remove from the
        // CodingSession list and avoid possible gnome-shell crash
        let destroyAppHandlerId = 0;
        let destroyToolboxHandlerId = 0;
        session.connect('minimized', (session) => {
            if (session.app) {
                destroyAppHandlerId = session.app.connect('destroy',
                    this.handleDestroyWindow.bind(this));
            }

            if (session.toolbox) {
                destroyToolboxHandlerId = session.toolbox.connect('destroy',
                    this.handleDestroyWindow.bind(this));
            }
        });
        session.connect('unminimized', (session) => {
            if (destroyAppHandlerId) {
                session.app.disconnect(destroyAppHandlerId);
                destroyAppHandlerId = 0;
            }
            if (destroyToolboxHandlerId) {
                session.toolbox.disconnect(destroyToolboxHandlerId);
                destroyToolboxHandlerId = 0;
            }
        });

        this._sessions.push(session);
        this.emit('session-added', session);
    }

    _removeSession(session, eventType) {
        // Destroy the session here and remove it from the list
        session.destroy(eventType);

        let idx = this._sessions.indexOf(session);
        if (idx === -1)
            return;

        this._sessions.splice(idx, 1);
        this.emit('session-removed', session);
    }

    handleDestroyWindow(actor) {
        if (this._stopped)
            return false;

        // First, determine if this is an app window getting destroyed
        let session = this._getSession(actor, SessionLookupFlags.SESSION_LOOKUP_APP);
        let eventType = SessionDestroyEvent.SESSION_DESTROY_APP_DESTROYED;

        if (session) {
            // If the app window was destroyed because the toolbox flipped it back,
            // simply disassociate it from the session, because we are expecting
            // the new window for this app to appear soon
            if (session.removeFlippedBackAppWindow())
                return true;
        } else {
            // If not, determine if this is a toolbox window getting destroyed
            session = this._getSession(actor, SessionLookupFlags.SESSION_LOOKUP_TOOLBOX);
            eventType = SessionDestroyEvent.SESSION_DESTROY_TOOLBOX_DESTROYED;
        }

        // If this was an app or toolbox window, destroy the session
        if (session)
            this._removeSession(session, eventType);

        return false;
    }

    handleWindowGrab(actor, grabbed) {
        let session = this._getSession(actor,
            SessionLookupFlags.SESSION_LOOKUP_APP | SessionLookupFlags.SESSION_LOOKUP_TOOLBOX);
        if (!session)
            return;

        session.setGrabbed(grabbed);
    }

    _isClubhouseInstalled() {
        return Clubhouse.getClubhouseApp() || Clubhouse.getClubhouseApp('com.endlessm.Clubhouse');
    }

    handleMapWindow(actor) {
        if (this._stopped)
            return false;

        if (!Settings.get_boolean('hack-mode-enabled') || !this._isClubhouseInstalled())
            return false;

        // Do not manage apps that don't have an associated .desktop file
        let windowTracker = Shell.WindowTracker.get_default();
        let shellApp = windowTracker.get_window_app(actor.meta_window);
        if (!shellApp)
            return false;
        let appInfo = shellApp.get_app_info();
        if (!appInfo)
            return false;

        let gtkId = actor.meta_window.get_gtk_application_id();

        // The custom X-Endless-Hackable key has the last word always
        if (appInfo.has_key(_HACKABLE_DESKTOP_KEY)) {
            if (!appInfo.get_boolean(_HACKABLE_DESKTOP_KEY))
                return false;
        // HackUnlock and HackToolbox are inside the com.hack_computer.Clubhouse flatpak
        // and have the Clubhouse appInfo, so we should ignore those cases here
        // to be able to show the HackUnlock and HackToolbox windows
        } else if (gtkId !== 'com.hack_computer.HackUnlock' &&
                   gtkId !== 'com.hack_computer.HackToolbox' &&
                   gtkId !== 'com.endlessm.HackToolbox') {
            // Do not manage apps that are NoDisplay=true
            if (!appInfo.should_show())
                return false;

            // Do not manage apps that we block in com.endlessm.HackComponents
            if (_appIsBlockedFromHacking(appInfo.get_id()))
                return false;

            // If there is an allow-only list in com.endlessm.HackComponents,
            // only manage apps on that list
            if (!_appIsAllowedHacking(appInfo.get_id()))
                return false;
        }

        // It might be a "HackToolbox". Check that, and if so,
        // add it to the window group for the window.
        let proxy = Shell.WindowTracker.get_hack_toolbox_proxy(actor.meta_window);
        let handled = false;

        // This is a new proxy window, make it join the session
        if (proxy) {
            let [targetAppId, targetWindowId] = _getToolboxTarget(actor.meta_window);

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
    }

    killEffectsOnActor(actor) {
        let session = this._getSession(actor,
            SessionLookupFlags.SESSION_LOOKUP_APP | SessionLookupFlags.SESSION_LOOKUP_TOOLBOX);
        if (session)
            session.killEffects();
    }

    _getSession(actor, flags) {
        return this._sessions.find((session) => {
            return (((session.app === actor) && (flags & SessionLookupFlags.SESSION_LOOKUP_APP)) ||
                    ((session.toolbox === actor) && (flags & SessionLookupFlags.SESSION_LOOKUP_TOOLBOX)));
        });
    }

    _getAvailableSessionForTargetApp(targetAppId) {
        return this._sessions.find((session) => {
            return (session.app &&
                    !session.app.is_destroyed() &&
                    !session.toolbox &&
                    _getAppId(session.app.meta_window) == targetAppId);
        });
    }

    _getAvailableSessionForToolboxTarget(appId) {
        return this._sessions.find((session) => {
            return (!session.app &&
                    session.toolbox &&
                    !session.toolbox.is_destroyed() &&
                    _getToolboxTarget(session.toolbox.meta_window)[0] == appId);
        });
    }

    _getSessionForTargetAppWindow(targetAppId, targetWindowId) {
        return this._sessions.find((session) => {
            return (session.app &&
                    !session.app.is_destroyed() &&
                    _getAppId(session.app.meta_window) == targetAppId &&
                    _getWindowId(session.app.meta_window) == targetWindowId);
        });
    }

    _getSessionForToolboxTarget(appId, windowId) {
        return this._sessions.find((session) => {
            return (session.toolbox &&
                    !session.toolbox.is_destroyed () &&
                    _getToolboxTarget(session.toolbox.meta_window)[0] == appId &&
                    _getToolboxTarget(session.toolbox.meta_window)[1] == windowId);
        });
    }
});

// TODO:
// * js/ui/windowManager.js (Code view integration, this is the harder part)

// altTab.js

const AltTab = imports.ui.altTab;
const originalGetWindow = AltTab.getWindows;

function getWindows(workspace) {
    // We ignore skip-taskbar windows in switchers, but if they are attached
    // to their parent, their position in the MRU list may be more appropriate
    // than the parent; so start with the complete list ...
    let windows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL,
                                              workspace);
    // ... map windows to their parent where appropriate ...
    return windows.map(w => {
        return w.is_attached_dialog() ? w.get_transient_for() : w;
    // ... and filter out hack inactive, skip-taskbar windows and duplicates
    }).filter((w, i, a) => !w._hackIsInactiveWindow && !w.skip_taskbar && a.indexOf(w) == i);
}

// appIconBar.js
const AppIconBar = imports.ui.appIconBar;
const originalGetInterestingWindow = AppIconBar.AppIconButton.prototype._getInterestingWindows;

function getInterestingWindows() {
    let windows = this._app.get_windows();
    let hasSpeedwagon = false;
    windows = windows.filter(function(metaWindow) {
        hasSpeedwagon = hasSpeedwagon || Shell.WindowTracker.is_speedwagon_window(metaWindow);
        return !metaWindow.is_skip_taskbar() && !metaWindow._hackIsInactiveWindow;
    });
    return [windows, hasSpeedwagon];
}

// workspace.js
const Workspace = imports.ui.workspace;
const originalIsOverviewWindow = Workspace.Workspace.prototype._isOverviewWindow;

function isOverviewWindow(win) {
    return !win.get_meta_window().skip_taskbar && !win.get_meta_window()._hackIsInactiveWindow;
}

function enable() {
    AltTab.getWindows = getWindows;
    AltTab.AppIcon.prototype = {
        get cachedWindows() {
            let cached = this._cachedWindows || [];
            return cached.filter((win) => {
                return !win._hackIsInactiveWindow;
            });
        },
        set cachedWindows(windowList) {
            this._cachedWindows = windowList;
        },
    };

    AppIconBar.AppIconButton.prototype._getInterestingWindows = getInterestingWindows;
    Workspace.Workspace.prototype._isOverviewWindow = isOverviewWindow;
}

function disable() {
    AltTab.getWindow = originalGetWindow;
    AltTab.AppIcon.prototype = {
        get cachedWindows() {
            return this._cachedWindows || [];
        },
        set cachedWindows(windowList) {
            this._cachedWindows = windowList;
        },
    };

    AppIconBar.AppIconButton.prototype._getInterestingWindows = originalGetInterestingWindow;
    Workspace.Workspace.prototype._isOverviewWindow = originalIsOverviewWindow;
}
