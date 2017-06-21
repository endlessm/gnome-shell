// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;

const LoginManager = imports.misc.loginManager;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;

const UpdaterIface = '<node> \
<interface name="com.endlessm.Updater"> \
  <method name="Poll"/> \
  <method name="PollVolume"> \
    <arg type="s" name="path" /> \
  </method> \
  <method name="Fetch"/> \
  <method name="Apply"/> \
  <property name="State"            type="u" access="read"/> \
  <property name="UpdateID"         type="s" access="read"/> \
  <property name="UpdateRefspec"    type="s" access="read"/> \
  <property name="OriginalRefspec"  type="s" access="read"/> \
  <property name="CurrentID"        type="s" access="read"/> \
  <property name="UpdateLabel"      type="s" access="read"/> \
  <property name="UpdateMessage"    type="s" access="read"/> \
  <property name="DownloadSize"     type="x" access="read"/> \
  <property name="DownloadedBytes"  type="x" access="read"/> \
  <property name="UnpackedSize"     type="x" access="read"/> \
  <property name="FullDownloadSize" type="x" access="read"/> \
  <property name="FullUnpackedSize" type="x" access="read"/> \
  <property name="ErrorCode"        type="u" access="read"/> \
  <property name="ErrorName"        type="s" access="read"/> \
  <property name="ErrorMessage"     type="s" access="read"/> \
  <signal name="StateChanged"> \
    <arg type="u" name="state"/> \
  </signal> \
  <signal name="Progress"> \
    <arg type="x" name="fetched"/> \
    <arg type="x" name="expected"/> \
  </signal> \
</interface> \
</node>';

const UpdaterState = {
    NONE: 0,
    READY: 1,
    ERROR: 2,
    POLLING: 3,
    UPDATE_AVAILABLE: 4,
    FETCHING: 5,
    UPDATE_READY: 6,
    APPLYING_UPDATE: 7,
    UPDATE_APPLIED: 8
};

const UpdaterStep = {
    NONE: 0,
    POLL: 1,
    FETCH: 2,
    APPLY: 3
};
const AUTO_UPDATES_DEFAULT_STEP = UpdaterStep.POLL;

const AUTO_UPDATES_GROUP_NAME = 'Automatic Updates';
const AUTO_UPDATES_LAST_STEP_KEY = 'LastAutomaticStep';

const UpdaterNotification = new Lang.Class({
    Name: 'UpdaterNotification',
    Extends: MessageTray.Notification,

    _init: function(source, title, banner) {
        this.parent(source, title, banner);

        this.setResident(true);
        this.setUrgency(MessageTray.Urgency.CRITICAL);
    }
});

const UpdaterProxy = Gio.DBusProxy.makeProxyWrapper(UpdaterIface);

const UpdaterManager = new Lang.Class({
    Name: 'UpdaterManager',

    _init: function() {
        this._proxy = new UpdaterProxy(Gio.DBus.system, 'com.endlessm.Updater',
                                       '/com/endlessm/Updater', Lang.bind(this, this._onProxyConstructed));

        this._loginManager = LoginManager.getLoginManager();

        this._config = new GLib.KeyFile();
        this._lastAutoStep = AUTO_UPDATES_DEFAULT_STEP;

        this._constructed = false;
        this._enabled = false;
        this._notification = null;
        this._source = null;
        this._proxyChangedId = 0;
        this._currentState = UpdaterState.NONE;

        // In priority order; should be kept in sync with the list in
        // eos-autoupdater.c.
        // FIXME: Ideally, this should be loaded by a shared library from
        // eos-updater, rather than hard-coded here. Or eos-updater would
        // expose a new property indicating whether a state change was
        // triggered manually or automatically.
        let configFiles = [
            '/etc/eos-updater/eos-autoupdater.conf',  // new location
            '/etc/eos-updater.conf',  // old location
            '/usr/local/share/eos-updater/eos-autoupdater.conf',
            '/usr/share/eos-updater/eos-autoupdater.conf',
        ];

        for (let i = 0; i < configFiles.len; i++) {
            let configFile = configFiles[i];

            try {
                this._config.load_from_file(configFile, GLib.KeyFileFlags.NONE);
                this._lastAutoStep = this._config.get_integer(AUTO_UPDATES_GROUP_NAME,
                                                              AUTO_UPDATES_LAST_STEP_KEY);
                break;
            } catch (e) {
                // don't spam if the file doesn't exist
                if (!e.matches(GLib.FileError, GLib.FileError.NOENT))
                    logError(e, 'Can\'t load updater configuration');
            }
        }
    },

    enable: function() {
        this._proxyChangedId = this._proxy.connect('g-properties-changed',
                                                   Lang.bind(this, this._onPropertiesChanged));
        this._enabled = true;

        if (this._constructed)
            this._onStateChanged();
    },

    disable: function() {
        if (this._proxyChangedId > 0) {
            this._proxy.disconnect(this._proxyChangedId);
            this._proxyChangedId = 0;
        }

        this._enabled = false;
    },

    _onProxyConstructed: function() {
        this._constructed = true;

        if (this._enabled)
            this._onStateChanged();
    },

    _onPropertiesChanged: function(proxy, changedProps, invalidatedProps) {
        let propsDict = changedProps.deep_unpack();
        if (propsDict.hasOwnProperty('State'))
            this._onStateChanged();
    },

    _onStateChanged: function() {
        let state = this._proxy.State;

        if (state == this._currentState)
            return;

        // Clear any existing notifications (such as past errors), none of
        // which are relevant to the current state.
        if (this._notification) {
            this._notification.destroy();
            this._notification = null;
        }

        if (state == UpdaterState.UPDATE_AVAILABLE)
            this._notifyUpdateAvailable();
        else if (state == UpdaterState.UPDATE_READY)
            this._notifyUpdateReady();
        else if (state == UpdaterState.UPDATE_APPLIED)
            this._notifyUpdateApplied();
        else if (state == UpdaterState.ERROR)
            this._notifyError();

        // we update the _currentState here, so that the notify*
        // methods can access the previous state
        this._currentState = state;
    },

    _ensureSource: function() {
        if (this._source)
            return;

        this._source = new MessageTray.Source(_("Software Update"),
                                              'software-update-available-symbolic');
        this._source.connect('destroy', Lang.bind(this, function() {
            this._source = null;
        }));
        Main.messageTray.add(this._source);
    },

    _notifyUpdateAvailable: function() {
        if (this._lastAutoStep > UpdaterStep.POLL)
            return;

        this._ensureSource();

        this._notification = new UpdaterNotification(this._source,
            _("Updates Available"),
            _("Software updates are available for your system"));
        this._notification.addAction(_("Download Now"), Lang.bind(this, function() {
            this._notification.destroy();
            this._proxy.FetchRemote();
        }));

        this._source.notify(this._notification);
    },

    _notifyUpdateReady: function() {
        if (this._lastAutoStep > UpdaterStep.FETCH)
            return;

        this._ensureSource();

        this._notification = new UpdaterNotification(this._source,
            _("Updates Ready"),
            _("Software updates are ready to be installed on your system"));
        this._notification.addAction(_("Install Now"), Lang.bind(this, function() {
            this._notification.destroy();
            this._proxy.ApplyRemote();
        }));

        this._source.notify(this._notification);
    },

    _notifyUpdateApplied: function() {
        this._ensureSource();

        this._notification = new UpdaterNotification(this._source,
            _("Updates Installed"),
            _("Software updates were installed on your system"));
        this._notification.addAction(_("Restart Now"), Lang.bind(this, function() {
            this._notification.destroy();
            this._loginManager.reboot();
        }));

        this._source.notify(this._notification);
    },

    _notifyError: function() {
        // we want to show errors only when manually updating the system
        if (this._lastAutoStep > UpdaterStep.POLL)
            return;

        // we don't want to show errors if the network went away while
        // polling for, or fetching, an update
        let wasPolling = this._currentState == UpdaterState.POLLING;
        let wasFetching = this._currentState == UpdaterState.FETCHING;
        let networkMonitor = Gio.NetworkMonitor.get_default();
        if ((wasPolling || wasFetching) && !networkMonitor.get_network_available())
            return;

        // We don’t want to notify of errors arising from being a dev-converted
        // system or live system.
        if (this._proxy.ErrorName == 'com.endlessm.Updater.Error.NotOstreeSystem' ||
            this._proxy.ErrorName == 'com.endlessm.Updater.Error.LiveBoot')
            return;

        this._ensureSource();

        this._notification = new UpdaterNotification(this._source,
            _("Update Failed"),
            _("We could not update your system"));

        this._source.notify(this._notification);
    }
});
const Component = UpdaterManager;
