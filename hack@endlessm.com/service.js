const { Gio, GLib, Shell } = imports.gi;
const ShellDBus = imports.ui.shellDBus;

const ExtensionUtils = imports.misc.extensionUtils;
const Hack = ExtensionUtils.getCurrentExtension();
const Settings = Hack.imports.utils.getSettings();

const Main = imports.ui.main;

const { loadInterfaceXML } = Hack.imports.utils;

const Codeview = Hack.imports.ui.codeView;

const IFACE = loadInterfaceXML('com.hack_computer.hack');
const CLUBHOUSE_ID = 'com.hack_computer.Clubhouse.desktop';

var Service = class {
    constructor() {
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        Gio.bus_own_name_on_connection(Gio.DBus.session, 'com.hack_computer.hack',
                                       Gio.BusNameOwnerFlags.REPLACE, null, null);

        try {
            this._dbusImpl.export(Gio.DBus.session, '/com/hack_computer/hack');
        } catch(e) {
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
        let appId = '';
        let tracker = Shell.WindowTracker.get_default();
        if (tracker.focus_app)
            appId = tracker.focus_app.get_id();
        return appId;
    }

    get HackModeEnabled() {
        return Settings.get_boolean('hack-mode-enabled');
    }

    set HackModeEnabled(enabled) {
        Settings.set_boolean('hack-mode-enabled', enabled);
    }

    get HackIconPulse() {
        return Settings.get_boolean('hack-icon-pulse');
    }

    set HackIconPulse(enabled) {
        Settings.set_boolean('hack-icon-pulse', enabled);
    }

    get ShowHackLauncher() {
        return Settings.get_boolean('show-hack-launcher');
    }

    set ShowHackLauncher(enabled) {
        Settings.set_boolean('show-hack-launcher', enabled);
    }

    get WobblyEffect() {
        return Settings.get_boolean('wobbly-effect');
    }

    set WobblyEffect(enabled) {
        Settings.set_boolean('wobbly-effect', enabled);
    }

    get WobblySpringK() {
        return Settings.get_double('wobbly-spring-k');
    }

    set WobblySpringK(value) {
        Settings.set_double('wobbly-spring-k', value);
    }

    get WobblySpringFriction() {
        return Settings.get_double('wobbly-spring-friction');
    }

    set WobblySpringFriction(value) {
        Settings.set_double('wobbly-spring-friction', value);
    }

    get WobblySlowdownFactor() {
        return Settings.get_double('wobbly-slowdown-factor');
    }

    set WobblySlowdownFactor(value) {
        Settings.set_double('wobbly-slowdown-factor', value);
    }

    get WobblyObjectMovementRange() {
        return Settings.get_double('wobbly-object-movement-range');
    }

    set WobblyObjectMovementRange(value) {
        Settings.set_double('wobbly-object-movement-range', value);
    }
};

const HackableAppIface = loadInterfaceXML('com.hack_computer.HackableApp');
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
        } catch(e) {
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

const HackableAppsManagerIface = loadInterfaceXML('com.hack_computer.HackableAppsManager');
var HackableAppsManager = class {
    constructor() {
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(HackableAppsManagerIface, this);
        Gio.bus_own_name_on_connection(Gio.DBus.session, 'com.hack_computer.HackableAppsManager',
                                       Gio.BusNameOwnerFlags.REPLACE, null, null);

        try {
            this._dbusImpl.export(Gio.DBus.session, '/com/hack_computer/HackableAppsManager');
        } catch(e) {
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

var STORE_SERVICE = {
    AddApplication: null,
    AddAppIfNotVisible: null,
    RemoveApplication: null,
};

var storeServiceAddApplication = null;
var storeServiceAddAppIfNotVisible = null;
var storeServiceAddAppIfNotVisible = null;

var MAIN_START = Main.start;


function enable() {
    SHELL_DBUS_SERVICE = new Service();
    HACKABLE_APPS_MANAGER_SERVICE = new HackableAppsManager();

    Main.start = () => {
        MAIN_START();
        let storeService = Main.shellDBusService._appStoreService;
        if (storeService) {
            STORE_SERVICE.AddApplication = storeService.AddApplication.bind(storeService);
            STORE_SERVICE.AddAppIfNotVisible = storeService.AddAppIfNotVisible.bind(storeService);
            STORE_SERVICE.RemoveApplication = storeService.RemoveApplication.bind(storeService);

            storeService.AddApplication = (id) => {
                ShellDBus._reportAppAddedMetric(id);

                if (id === CLUBHOUSE_ID) {
                    Settings.set_boolean('show-hack-launcher', true);
                    storeService._iconGridLayout.emit('changed');
                    return;
                }

                STORE_SERVICE.AddApplication(id);
            }

            storeService.AddAppIfNotVisible = (id) => {
                if (id === CLUBHOUSE_ID) {
                    Settings.set_boolean('show-hack-launcher', true);
                    storeService._iconGridLayout.emit('changed');
                    ShellDBus._reportAppAddedMetric(id);
                    return;
                }

                STORE_SERVICE.AddAppIfNotVisible(id);
            }

            storeService.RemoveApplication = (id) => {
                if (id === CLUBHOUSE_ID) {
                    global.settings.set_boolean('show-hack-launcher', false);
                    storeService._iconGridLayout.emit('changed');
                    return;
                }

                STORE_SERVICE.RemoveApplication(id);
            }
        }
    };
}

function disable() {
    Main.start = MAIN_START;

    let storeService = Main.shellDBusService._appStoreService;
    if (storeService) {
        storeService.AddApplication = STORE_SERVICE.AddApplication;
        storeService.AddAppIfNotVisible = STORE_SERVICE.AddAppIfNotVisible;
        storeService.RemoveApplication = STORE_SERVICE.RemoveApplication;
    }

    if (SHELL_DBUS_SERVICE) {
        delete SHELL_DBUS_SERVICE;
        SHELL_DBUS_SERVICE = null;
    }

    if (HACKABLE_APPS_MANAGER_SERVICE) {
        delete HACKABLE_APPS_MANAGER_SERVICE;
        HACKABLE_APPS_MANAGER_SERVICE = null;
    }
}
