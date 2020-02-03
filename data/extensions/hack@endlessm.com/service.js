/* exported HackableApp, enable, disable */

const { Gio, GLib, Shell } = imports.gi;
const ShellDBus = imports.ui.shellDBus;

const ExtensionUtils = imports.misc.extensionUtils;
const Hack = ExtensionUtils.getCurrentExtension();
const Settings = Hack.imports.utils.getSettings();
const Utils = Hack.imports.utils;

const Main = imports.ui.main;

const IFACE = Utils.loadInterfaceXML('com.hack_computer.hack');
const CLUBHOUSE_ID = 'com.hack_computer.Clubhouse.desktop';

var Service = class {
    constructor() {
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        Gio.bus_own_name_on_connection(Gio.DBus.session, 'com.hack_computer.hack',
            Gio.BusNameOwnerFlags.REPLACE, null, null);

        try {
            this._dbusImpl.export(Gio.DBus.session, '/com/hack_computer/hack');
        } catch (e) {
            logError(e, 'Cannot export Hack service');
            return;
        }

        Shell.WindowTracker.get_default().connect('notify::focus-app',
            this._checkFocusAppChanged.bind(this));
        Settings.connect('changed::hack-mode-enabled', () => {
            this._dbusImpl.emit_property_changed('HackModeEnabled',
                new GLib.Variant('b', this.HackModeEnabled));
        });
        Settings.connect('changed::hack-icon-pulse', () => {
            this._dbusImpl.emit_property_changed('HackIconPulse',
                new GLib.Variant('b', this.HackIconPulse));
        });
        Settings.connect('changed::show-hack-launcher', () => {
            this._dbusImpl.emit_property_changed('ShowHackLauncher',
                new GLib.Variant('b', this.ShowHackLauncher));
        });

        Settings.connect('changed::wobbly-effect', () => {
            this._dbusImpl.emit_property_changed('WobblyEffect',
                new GLib.Variant('b', this.WobblyEffect));
        });
        Settings.connect('changed::wobbly-spring-k', () => {
            this._dbusImpl.emit_property_changed('WobblySpringK',
                new GLib.Variant('d', this.WobblySpringK));
        });
        Settings.connect('changed::wobbly-spring-friction', () => {
            this._dbusImpl.emit_property_changed('WobblySpringFriction',
                new GLib.Variant('d', this.WobblySpringFriction));
        });
        Settings.connect('changed::wobbly-slowdown-factor', () => {
            this._dbusImpl.emit_property_changed('WobblySlowdownFactor',
                new GLib.Variant('d', this.WobblySlowdownFactor));
        });
        Settings.connect('changed::wobbly-object-movement-range', () => {
            this._dbusImpl.emit_property_changed('WobblyObjectMovementRange',
                new GLib.Variant('d', this.WobblyObjectMovementRange));
        });
    }

    MinimizeAll() {
        void this;
        global.get_window_actors().forEach(actor => {
            actor.metaWindow.minimize();
        });
    }

    Pulse(activate) {
        this.HackIconPulse = activate;
    }

    _checkFocusAppChanged() {
        this._dbusImpl.emit_property_changed('FocusedApp', new GLib.Variant('s', this.FocusedApp));
    }

    get FocusedApp() {
        void this;
        let appId = '';
        const tracker = Shell.WindowTracker.get_default();
        if (tracker.focus_app)
            appId = tracker.focus_app.get_id();
        return appId;
    }

    get HackModeEnabled() {
        void this;
        return Settings.get_boolean('hack-mode-enabled');
    }

    set HackModeEnabled(enabled) {
        void this;
        Settings.set_boolean('hack-mode-enabled', enabled);
    }

    get HackIconPulse() {
        void this;
        return Settings.get_boolean('hack-icon-pulse');
    }

    set HackIconPulse(enabled) {
        void this;
        Settings.set_boolean('hack-icon-pulse', enabled);
    }

    get ShowHackLauncher() {
        void this;
        return Settings.get_boolean('show-hack-launcher');
    }

    set ShowHackLauncher(enabled) {
        void this;
        Settings.set_boolean('show-hack-launcher', enabled);
    }

    get WobblyEffect() {
        void this;
        return Settings.get_boolean('wobbly-effect');
    }

    set WobblyEffect(enabled) {
        void this;
        Settings.set_boolean('wobbly-effect', enabled);
    }

    get WobblySpringK() {
        void this;
        return Settings.get_double('wobbly-spring-k');
    }

    set WobblySpringK(value) {
        void this;
        Settings.set_double('wobbly-spring-k', value);
    }

    get WobblySpringFriction() {
        void this;
        return Settings.get_double('wobbly-spring-friction');
    }

    set WobblySpringFriction(value) {
        void this;
        Settings.set_double('wobbly-spring-friction', value);
    }

    get WobblySlowdownFactor() {
        void this;
        return Settings.get_double('wobbly-slowdown-factor');
    }

    set WobblySlowdownFactor(value) {
        void this;
        Settings.set_double('wobbly-slowdown-factor', value);
    }

    get WobblyObjectMovementRange() {
        void this;
        return Settings.get_double('wobbly-object-movement-range');
    }

    set WobblyObjectMovementRange(value) {
        void this;
        Settings.set_double('wobbly-object-movement-range', value);
    }
};

const HackableAppIface = Utils.loadInterfaceXML('com.hack_computer.HackableApp');
var HackableApp = class {
    constructor(session) {
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(HackableAppIface, this);

        this._session = session;
        this._session.connect('notify::state', this._stateChanged.bind(this));
    }

    export(objectId) {
        const objectPath = `/com/hack_computer/HackableApp/${objectId}`;
        try {
            this._dbusImpl.export(Gio.DBus.session, objectPath);
        } catch (e) {
            logError(e, `Cannot export HackableApp at path ${objectPath}`);
        }
    }

    unexport() {
        this._dbusImpl.unexport();
    }

    _stateChanged() {
        const value = new GLib.Variant('u', this.State);
        this._dbusImpl.emit_property_changed('State', value);
    }

    get objectPath() {
        return this._dbusImpl.get_object_path();
    }

    get AppId() {
        return this._session.appId;
    }

    get State() {
        return this._session.state;
    }

    get ToolboxVisible() {
        if (!this._session.toolbox)
            return false;
        return this._session.toolbox.visible;
    }

    set ToolboxVisible(value) {
        if (!this._session.toolbox)
            return;
        this._session.toolbox.visible = value;
    }

    get PulseFlipToHackButton() {
        return this._session._button.highlighted;
    }

    set PulseFlipToHackButton(value) {
        this._session._button.highlighted = value;
    }
};

const HackableAppsManagerIface = Utils.loadInterfaceXML('com.hack_computer.HackableAppsManager');
var HackableAppsManager = class {
    constructor() {
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(HackableAppsManagerIface, this);
        Gio.bus_own_name_on_connection(Gio.DBus.session, 'com.hack_computer.HackableAppsManager',
            Gio.BusNameOwnerFlags.REPLACE, null, null);

        try {
            this._dbusImpl.export(Gio.DBus.session, '/com/hack_computer/HackableAppsManager');
        } catch (e) {
            logError(e, 'Cannot export HackableAppsManager');
            return;
        }

        this._codeViewManager = Main.wm._codeViewManager;
        this._codeViewManager.connect('session-added', this._onSessionAdded.bind(this));
        this._codeViewManager.connect('session-removed', this._onSessionRemoved.bind(this));

        this._nextId = 0;
    }

    _emitCurrentlyHackableAppsChanged() {
        const value = new GLib.Variant('ao', this.CurrentlyHackableApps);
        this._dbusImpl.emit_property_changed('CurrentlyHackableApps', value);
    }

    _getNextId() {
        return ++this._nextId;
    }

    _onSessionAdded(_, session) {
        session.hackableApp.export(this._getNextId());
        this._emitCurrentlyHackableAppsChanged();
    }

    _onSessionRemoved(_, session) {
        session.hackableApp.unexport();
        this._emitCurrentlyHackableAppsChanged();
    }

    get CurrentlyHackableApps() {
        const paths = [];
        for (const session of this._codeViewManager.sessions)
            paths.push(session.hackableApp.objectPath);
        return paths;
    }
};

var SHELL_DBUS_SERVICE = null;
var HACKABLE_APPS_MANAGER_SERVICE = null;

function enable() {
    SHELL_DBUS_SERVICE = new Service();
    HACKABLE_APPS_MANAGER_SERVICE = new HackableAppsManager();

    Utils.override(ShellDBus.AppStoreService, 'AddApplication', function(id) {
        ShellDBus._reportAppAddedMetric(id);

        if (id === CLUBHOUSE_ID) {
            Settings.set_boolean('show-hack-launcher', true);
            this._iconGridLayout.emit('changed');
            return;
        }

        Utils.original(ShellDBus.AppStoreService, 'AddApplication').bind(this)(id);
    });

    Utils.override(ShellDBus.AppStoreService, 'AddAppIfNotVisible', function(id) {
        if (id === CLUBHOUSE_ID) {
            Settings.set_boolean('show-hack-launcher', true);
            this._iconGridLayout.emit('changed');
            ShellDBus._reportAppAddedMetric(id);
            return;
        }

        Utils.original(ShellDBus.AppStoreService, 'AddAppIfNotVisible').bind(this)(id);
    });

    Utils.override(ShellDBus.AppStoreService, 'RemoveApplication', function(id) {
        if (id === CLUBHOUSE_ID) {
            global.settings.set_boolean('show-hack-launcher', false);
            this._iconGridLayout.emit('changed');
            return;
        }

        Utils.original(ShellDBus.AppStoreService, 'RemoveApplication').bind(this)(id);
    });
}

function disable() {
    Utils.restore(ShellDBus.AppStoreService);

    if (SHELL_DBUS_SERVICE)
        SHELL_DBUS_SERVICE = null;

    if (HACKABLE_APPS_MANAGER_SERVICE)
        HACKABLE_APPS_MANAGER_SERVICE = null;
}
