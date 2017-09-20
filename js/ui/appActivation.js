// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const St = imports.gi.St;

const Background = imports.ui.background;
const GrabHelper = imports.ui.grabHelper;
const Main = imports.ui.main;
const Overview = imports.ui.overview;
const Panel = imports.ui.panel;
const Tweener = imports.ui.tweener;
const Util = imports.misc.util;
const WindowManager = imports.ui.windowManager;

const SPLASH_SCREEN_TIMEOUT = 700; // ms

// By default, maximized windows are 75% of the workarea
// of the monitor they're on when unmaximized.
const DEFAULT_MAXIMIZED_WINDOW_SIZE = 0.75;
const LAUNCH_MAXIMIZED_DESKTOP_KEY = 'X-Endless-LaunchMaximized';


// Determine if a splash screen should be shown for the provided
// ShellApp and other global settings
function _shouldShowSplash(app) {
    let info = app.get_app_info();

    if (!(info && info.has_key(LAUNCH_MAXIMIZED_DESKTOP_KEY) &&
          info.get_boolean(LAUNCH_MAXIMIZED_DESKTOP_KEY)))
        return false;

    // Don't show splash screen if default maximize is disabled
    if (global.settings.get_boolean(WindowManager.NO_DEFAULT_MAXIMIZE_KEY))
        return false;

    // Don't show splash screen if this is a link and the browser is
    // running. We can't rely on any signal being emitted in that
    // case, as links open in browser tabs.
    if (app.get_id().indexOf('eos-link-') != -1 &&
        Util.getBrowserApp().state != Shell.AppState.STOPPED)
        return false;

    return true;
}

const AppActivationContext = new Lang.Class({
    Name: 'AppActivationContext',

    _init: function(app) {
        this._app = app;
        this._abort = false;
        this._cancelled = false;

        this._splash = null;

        this._appStateId = 0;
        this._timeoutId = 0;

        this._appActivationTime = 0;

        this._hiddenWindows = [];

        this._appSystem = Shell.AppSystem.get_default();

        this._tracker = Shell.WindowTracker.get_default();
        this._tracker.connect('notify::focus-app',
                              Lang.bind(this, this._onFocusAppChanged));
    },

    _doActivate: function(showSplash, timestamp) {
        if (!timestamp)
            timestamp = global.get_current_time();

        try {
            this._app.activate_full(-1, timestamp);
        } catch (e) {
            logError(e, 'error while activating: ' + this._app.get_id());
            return;
        }

        if (showSplash)
            this.showSplash();
    },

    activate: function(event, timestamp) {
        let modifiers = event ? event.get_state() : 0;

        if (this._app.state == Shell.AppState.RUNNING) {
            if (modifiers & Clutter.ModifierType.CONTROL_MASK)
                this._app.open_new_window(-1);
            else
                this._doActivate(false, timestamp);
        } else {
            this._doActivate(true, timestamp);
        }

        Main.overview.hide();
    },

    cancelSplash: function() {
        this._cancelled = true;
        this._clearSplash();
        // If application doesn't quit very likely is because it
        // didn't reach running state yet; so wait for it to
        // finish
        if (!this._app.request_quit())
            this._abort = true;
    },

    showSplash: function() {
        if (!_shouldShowSplash(this._app))
            return;

        // Prevent windows from being shown when the overview is hidden so it does
        // not affect the speedwagon's animation
        if (Main.overview.visible)
            this._hideWindows();

        this._cancelled = false;
        this._splash = new SpeedwagonSplash(this._app);
        this._splash.connect('close-clicked', Lang.bind(this, this.cancelSplash));
        this._splash.show();

        // Scale the timeout by the slow down factor, because otherwise
        // we could be trying to destroy the splash screen window before
        // the map animation has finished.
        // This buffer time ensures that the user can never destroy the
        // splash before the animation is completed.
        this._timeoutId = Mainloop.timeout_add(SPLASH_SCREEN_TIMEOUT * St.get_slow_down_factor(),
                                               Lang.bind(this, this._splashTimeout));

        // We can't fully trust windows-changed to be emitted with the
        // same ShellApp we called activate() on, as WMClass matching might
        // fail. For this reason, just pick to the first application that
        // will flip its state to running
        this._appStateId = this._appSystem.connect('app-state-changed',
            Lang.bind(this, this._onAppStateChanged));
        this._appActivationTime = GLib.get_monotonic_time();
    },

    _clearSplash: function() {
        this._resetWindowsVisibility();

        if (this._splash) {
            this._splash.rampOut();
            this._splash = null;
        }
    },

    _maybeClearSplash: function() {
        // Clear the splash only when we've waited at least 700ms,
        // and when the app has transitioned to the running state...
        if (this._appStateId == 0 && this._timeoutId == 0)
            this._clearSplash();
    },

    _splashTimeout: function() {
        this._timeoutId = 0;
        this._maybeClearSplash();

        return false;
    },

    _resetWindowsVisibility: function() {
        for (let actor of this._hiddenWindows) {
            actor.visible = true;
        }

        this._hiddenWindows = [];
    },

    _hideWindows: function() {
        let windows = global.get_window_actors();

        for (let actor of windows) {
            if (!actor.visible)
                continue;

            this._hiddenWindows.push(actor);
            actor.visible = false;
        }
    },

    _recordLaunchTime: function() {
        let activationTime = this._appActivationTime;
        this._appActivationTime = 0;

        if (activationTime == 0)
            return;

        if (!GLib.getenv('SHELL_DEBUG_LAUNCH_TIME'))
            return;

        let currentTime = GLib.get_monotonic_time();
        let elapsedTime = currentTime - activationTime;

        log('Application ' + this._app.get_name() +
            ' took ' + elapsedTime / 1000000 +
            ' seconds to launch');
    },

    _isBogusWindow: function(app) {
        let launchedAppId = this._app.get_id();
        let appId = app.get_id();

        // When the application IDs match, the window is not bogus
        if (appId == launchedAppId)
            return false;

        // Special case for Libreoffice splash screen; we will get a non-matching
        // app with 'Soffice' as its name when the recovery screen comes up,
        // so special case that too
        if (launchedAppId.indexOf('libreoffice') != -1 &&
            app.get_name() != 'Soffice')
            return true;

        return false;
    },

    _onAppStateChanged: function(appSystem, app) {
        if (!(app.state == Shell.AppState.RUNNING ||
              app.state == Shell.AppState.STOPPED))
            return;

        if (this._isBogusWindow(app))
            return;

        appSystem.disconnect(this._appStateId);
        this._appStateId = 0;

        let aborted = this._abort;
        this._abort = false;

        if (aborted) {
            this._app.request_quit();
            this._clearSplash();
        } else if (app.state == Shell.AppState.STOPPED) {
            this._clearSplash();
        } else {
            this._recordLaunchTime();
            this._maybeClearSplash();
        }
    },

    _onFocusAppChanged: function(tracker) {
        if (this._splash == null)
            return;

        let app = tracker.focus_app;
        if (app == null || app.get_id() === this._app.get_id())
            return;

        // The focused application changed and it is not the one that we are showing
        // the splash for, so clear the splash after it times out (because we don't
        // want to risk hiding too early)
        this._appSystem.disconnect(this._appStateId);
        this._appStateId = 0;
        this._maybeClearSplash();
    }
});

const SpeedwagonIface = '<node> \
<interface name="com.endlessm.Speedwagon"> \
<method name="ShowSplash"> \
    <arg type="s" direction="in" name="desktopFile" /> \
</method> \
<method name="HideSplash"> \
    <arg type="s" direction="in" name="desktopFile" /> \
</method> \
<signal name="SplashClosed"> \
    <arg type="s" name="desktopFile" /> \
</signal> \
</interface> \
</node>';
const SpeedwagonProxy = Gio.DBusProxy.makeProxyWrapper(SpeedwagonIface);

const SpeedwagonSplash = new Lang.Class({
    Name: 'SpeedwagonSplash',

    _init: function(app) {
        this._app = app;

        this._proxy = new SpeedwagonProxy(Gio.DBus.session,
                                          'com.endlessm.Speedwagon',
                                          '/com/endlessm/Speedwagon');
        this._proxy.connectSignal('SplashClosed', Lang.bind(this, function() {
            this.emit('close-clicked');
        }));
    },

    show: function() {
        this._proxy.ShowSplashRemote(this._app.get_id());
    },

    rampOut: function() {
        this._proxy.HideSplashRemote(this._app.get_id());
    },
});
Signals.addSignalMethods(SpeedwagonSplash.prototype);

const DesktopAppClient = new Lang.Class({
    Name: 'DesktopAppClient',
    _init: function() {
        this._lastDesktopApp = null;
        this._subscription =
            Gio.DBus.session.signal_subscribe(null,
                                             'org.gtk.gio.DesktopAppInfo',
                                             'Launched',
                                             '/org/gtk/gio/DesktopAppInfo',
                                             null, 0,
                                             Lang.bind(this, this._onLaunched));

        global.display.connect('window-created', Lang.bind(this, this._windowCreated));
    },

    _onLaunched: function(connection, sender_name, object_path,
                          interface_name, signal_name,
                         parameters) {
        let [desktopIdByteString, display, pid, uris, extras] = parameters.deep_unpack();

        let desktopIdPath = desktopIdByteString.toString();
        let desktopIdFile = Gio.File.new_for_path(desktopIdPath);
        let desktopDirs = GLib.get_system_data_dirs();
        desktopDirs.push(GLib.get_user_data_dir());

        let desktopId = GLib.path_get_basename(desktopIdPath);

        // Convert subdirectories to app ID prefixes like GIO does
        desktopDirs.some(function(desktopDir) {
            let path = GLib.build_filenamev([desktopDir, 'applications']);
            let file = Gio.File.new_for_path(path);

            if (desktopIdFile.has_prefix(file)) {
                let relPath = file.get_relative_path(desktopIdFile);
                desktopId = relPath.replace(/\//g, '-');
                return true;
            }

            return false;
        });

        this._lastDesktopApp = Shell.AppSystem.get_default().lookup_app(desktopId);

        // Show the splash page if we didn't launch this ourselves, since in that case
        // we already explicitly control when the splash screen should be used
        let launchedByShell = (sender_name == Gio.DBus.session.get_unique_name());
        let showSplash =
            (this._lastDesktopApp != null) &&
            (this._lastDesktopApp.state != Shell.AppState.RUNNING) &&
            (this._lastDesktopApp.get_app_info().should_show()) &&
            !launchedByShell;

        if (showSplash) {
            let context = new AppActivationContext(this._lastDesktopApp);
            context.showSplash();
        }
    },

    _windowCreated: function(metaDisplay, metaWindow) {
        // Ignore splash screens, which will already be maximized.
        if (Shell.WindowTracker.is_speedwagon_window(metaWindow))
            return;

        // Don't maximize if key to disable default maximize is set
        if (global.settings.get_boolean(WindowManager.NO_DEFAULT_MAXIMIZE_KEY))
            return;

        // Don't maximize windows in non-overview sessions (e.g. initial setup)
        if (!Main.sessionMode.hasOverview)
            return;

        // Skip unknown applications
        let tracker = Shell.WindowTracker.get_default();
        let app = tracker.get_window_app(metaWindow);
        if (!app)
            return;

        // Skip applications we are not aware of
        if (!this._lastDesktopApp)
            return;

        // Don't maximize if the launch maximized key is false
        let info = app.get_app_info();
        if (info && info.has_key(LAUNCH_MAXIMIZED_DESKTOP_KEY) &&
            !info.get_boolean(LAUNCH_MAXIMIZED_DESKTOP_KEY))
            return;

        // Skip if the window does not belong to the launched app, but
        // special case eos-link launchers if we detect a browser window
        if (app != this._lastDesktopApp &&
            !(this._lastDesktopApp.get_id().indexOf('eos-link-') != -1 && app == Util.getBrowserApp()))
            return;

        this._lastDesktopApp = null;

        if (metaWindow.is_skip_taskbar() || !metaWindow.resizeable)
            return;

        // Position the window so it's where we want it to be if the user
        // unmaximizes the window.
        let workArea = Main.layoutManager.getWorkAreaForMonitor(metaWindow.get_monitor());
        let width = workArea.width * DEFAULT_MAXIMIZED_WINDOW_SIZE;
        let height = workArea.height * DEFAULT_MAXIMIZED_WINDOW_SIZE;
        let x = workArea.x + (workArea.width - width) / 2;
        let y = workArea.y + (workArea.height - height) / 2;
        metaWindow.move_resize_frame(false, x, y, width, height);

        metaWindow.maximize(Meta.MaximizeFlags.HORIZONTAL |
                            Meta.MaximizeFlags.VERTICAL);
    }
});
