// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const NetworkManager = imports.gi.NetworkManager;
const NMClient = imports.gi.NMClient;
const NMGtk = imports.gi.NMGtk;
const Signals = imports.signals;
const Shell = imports.gi.Shell;
const St = imports.gi.St;

const Animation = imports.ui.animation;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const MessageTray = imports.ui.messageTray;
const ModalDialog = imports.ui.modalDialog;
const ModemManager = imports.misc.modemManager;
const Rfkill = imports.ui.status.rfkill;
const Util = imports.misc.util;

const NMConnectionCategory = {
    INVALID: 'invalid',
    WIRED: 'wired',
    WIRELESS: 'wireless',
    WWAN: 'wwan',
    VPN: 'vpn'
};

const NMAccessPointSecurity = {
    NONE: 1,
    WEP: 2,
    WPA_PSK: 3,
    WPA2_PSK: 4,
    WPA_ENT: 5,
    WPA2_ENT: 6
};

var MAX_DEVICE_ITEMS = 4;

// small optimization, to avoid using [] all the time
const NM80211Mode = NetworkManager['80211Mode'];
const NM80211ApFlags = NetworkManager['80211ApFlags'];
const NM80211ApSecurityFlags = NetworkManager['80211ApSecurityFlags'];

var PortalHelperResult = {
    CANCELLED: 0,
    COMPLETED: 1,
    RECHECK: 2
};

const PortalHelperIface = '<node> \
<interface name="org.gnome.Shell.PortalHelper"> \
<method name="Authenticate"> \
    <arg type="o" direction="in" name="connection" /> \
    <arg type="s" direction="in" name="url" /> \
    <arg type="u" direction="in" name="timestamp" /> \
</method> \
<method name="Close"> \
    <arg type="o" direction="in" name="connection" /> \
</method> \
<method name="Refresh"> \
    <arg type="o" direction="in" name="connection" /> \
</method> \
<signal name="Done"> \
    <arg type="o" name="connection" /> \
    <arg type="u" name="result" /> \
</signal> \
</interface> \
</node>';
const PortalHelperProxy = Gio.DBusProxy.makeProxyWrapper(PortalHelperIface);

function ssidCompare(one, two) {
    if (!one || !two)
        return false;
    if (one.length != two.length)
        return false;
    for (let i = 0; i < one.length; i++) {
        if (one[i] != two[i])
            return false;
    }
    return true;
}

function signalToIcon(value) {
    if (value > 80)
        return 'excellent';
    if (value > 55)
        return 'good';
    if (value > 30)
        return 'ok';
    if (value > 5)
        return 'weak';
    return 'none';
}

function ssidToLabel(ssid) {
    let label = NetworkManager.utils_ssid_to_utf8(ssid);
    if (!label)
        label = _("<unknown>");
    return label;
}

function ensureActiveConnectionProps(active, settings) {
    if (!active._connection) {
        active._connection = settings.get_connection_by_path(active.connection);

        // This list is guaranteed to have only one device in it.
        let device = active.get_devices()[0]._delegate;
        active._primaryDevice = device;
    }
}

function createSettingsAction(label, device) {
    let item = new PopupMenu.PopupMenuItem(label);

    item.connect('activate', function() {
        Util.spawnApp(['gnome-control-center', 'network', 'show-device',
                       device.get_path()]);
    });

    return item;
}

var NMConnectionItem = new Lang.Class({
    Name: 'NMConnectionItem',

    _init: function(section, connection) {
        this._section = section;
        this._connection = connection;
        this._activeConnection = null;
        this._activeConnectionChangedId = 0;

        this._buildUI();
        this._sync();
    },

    _buildUI: function() {
        this.labelItem = new PopupMenu.PopupMenuItem('');
        this.labelItem.connect('activate', Lang.bind(this, this._toggle));

        this.radioItem = new PopupMenu.PopupMenuItem(this._connection.get_id(), false);
        this.radioItem.connect('activate', Lang.bind(this, this._activate));
    },

    destroy: function() {
        this.labelItem.destroy();
        this.radioItem.destroy();
    },

    updateForConnection: function(connection) {
        // connection should always be the same object
        // (and object path) as this._connection, but
        // this can be false if NetworkManager was restarted
        // and picked up connections in a different order
        // Just to be safe, we set it here again

        this._connection = connection;
        this.radioItem.label.text = connection.get_id();
        this._sync();
        this.emit('name-changed');
    },

    getName: function() {
        return this._connection.get_id();
    },

    isActive: function() {
        if (this._activeConnection == null)
            return false;

        return this._activeConnection.state <= NetworkManager.ActiveConnectionState.ACTIVATED;
    },

    _sync: function() {
        let isActive = this.isActive();
        this.labelItem.label.text = isActive ? _("Turn Off") : this._section.getConnectLabel();
        this.radioItem.setOrnament(isActive ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        this.emit('icon-changed');
    },

    _toggle: function() {
        if (this._activeConnection == null)
            this._section.activateConnection(this._connection);
        else
            this._section.deactivateConnection(this._activeConnection);

        this._sync();
    },

    _activate: function() {
        if (this._activeConnection == null)
            this._section.activateConnection(this._connection);

        this._sync();
    },

    _connectionStateChanged: function(ac, newstate, reason) {
        this._sync();
    },

    setActiveConnection: function(activeConnection) {
        if (this._activeConnectionChangedId > 0) {
            this._activeConnection.disconnect(this._activeConnectionChangedId);
            this._activeConnectionChangedId = 0;
        }

        this._activeConnection = activeConnection;

        if (this._activeConnection)
            this._activeConnectionChangedId = this._activeConnection.connect('notify::state',
                                                                             Lang.bind(this, this._connectionStateChanged));

        this._sync();
    },
});
Signals.addSignalMethods(NMConnectionItem.prototype);

var NMConnectionSection = new Lang.Class({
    Name: 'NMConnectionSection',
    Abstract: true,

    _init: function(client) {
        this._client = client;

        this._connectionItems = new Map();
        this._connections = [];

        this._labelSection = new PopupMenu.PopupMenuSection();
        this._radioSection = new PopupMenu.PopupMenuSection();

        this.item = new PopupMenu.PopupSubMenuMenuItem('', true);
        this.item.menu.addMenuItem(this._labelSection);
        this.item.menu.addMenuItem(this._radioSection);

        this._notifyConnectivityId = this._client.connect('notify::connectivity', Lang.bind(this, this._iconChanged));
    },

    destroy: function() {
        if (this._notifyConnectivityId != 0) {
            this._client.disconnect(this._notifyConnectivityId);
            this._notifyConnectivityId = 0;
        }

        this.item.destroy();
    },

    _iconChanged: function() {
        this._sync();
        this.emit('icon-changed');
    },

    _sync: function() {
        let nItems = this._connectionItems.size;

        this._radioSection.actor.visible = (nItems > 1);
        this._labelSection.actor.visible = (nItems == 1);

        this.item.label.text = this._getStatus();
        this.item.icon.icon_name = this._getMenuIcon();
    },

    _getMenuIcon: function() {
        return this.getIndicatorIcon();
    },

    getConnectLabel: function() {
        return _("Connect");
    },

    _connectionValid: function(connection) {
        return true;
    },

    _connectionSortFunction: function(one, two) {
        return GLib.utf8_collate(one.get_id(), two.get_id());
    },

    _makeConnectionItem: function(connection) {
        return new NMConnectionItem(this, connection);
    },

    checkConnection: function(connection) {
        if (!this._connectionValid(connection))
            return;

        // This function is called everytime connection is added or updated
        // In the usual case, we already added this connection and UUID
        // didn't change. So we need to check if we already have an item,
        // and update it for properties in the connection that changed
        // (the only one we care about is the name)
        // But it's also possible we didn't know about this connection
        // (eg, during coldplug, or because it was updated and suddenly
        // it's valid for this device), in which case we add a new item

        let item = this._connectionItems.get(connection.get_uuid());
        if (item)
            this._updateForConnection(item, connection);
        else
            this._addConnection(connection);
    },

    _updateForConnection: function(item, connection) {
        let pos = this._connections.indexOf(connection);

        this._connections.splice(pos, 1);
        pos = Util.insertSorted(this._connections, connection, Lang.bind(this, this._connectionSortFunction));
        this._labelSection.moveMenuItem(item.labelItem, pos);
        this._radioSection.moveMenuItem(item.radioItem, pos);

        item.updateForConnection(connection);
    },

    _addConnection: function(connection) {
        let item = this._makeConnectionItem(connection);
        if (!item)
            return;

        item.connect('icon-changed', Lang.bind(this, function() {
            this._iconChanged();
        }));
        item.connect('activation-failed', Lang.bind(this, function(item, reason) {
            this.emit('activation-failed', reason);
        }));
        item.connect('name-changed', Lang.bind(this, this._sync));

        let pos = Util.insertSorted(this._connections, connection, Lang.bind(this, this._connectionSortFunction));
        this._labelSection.addMenuItem(item.labelItem, pos);
        this._radioSection.addMenuItem(item.radioItem, pos);
        this._connectionItems.set(connection.get_uuid(), item);
        this._sync();
    },

    removeConnection: function(connection) {
        let uuid = connection.get_uuid();
        let item = this._connectionItems.get(uuid);
        if (item == undefined)
            return;

        item.destroy();
        this._connectionItems.delete(uuid);

        let pos = this._connections.indexOf(connection);
        this._connections.splice(pos, 1);

        this._sync();
    },
});
Signals.addSignalMethods(NMConnectionSection.prototype);

var NMConnectionDevice = new Lang.Class({
    Name: 'NMConnectionDevice',
    Extends: NMConnectionSection,
    Abstract: true,

    _init: function(client, device, settings) {
        this.parent(client);
        this._device = device;
        this._settings = settings;
        this._description = '';

        this._autoConnectItem = this.item.menu.addAction(_("Connect"), Lang.bind(this, this._autoConnect));
        this._deactivateItem = this._radioSection.addAction(_("Turn Off"), Lang.bind(this, this.deactivateConnection));

        this._stateChangedId = this._device.connect('state-changed', Lang.bind(this, this._deviceStateChanged));
        this._activeConnectionChangedId = this._device.connect('notify::active-connection', Lang.bind(this, this._activeConnectionChanged));
    },

    _canReachInternet: function() {
        if (this._client.primary_connection != this._device.active_connection)
            return true;

        return this._client.connectivity == NetworkManager.ConnectivityState.FULL;
    },

    _autoConnect: function() {
        let connection = new NetworkManager.Connection();
        this._client.add_and_activate_connection(connection, this._device, null, null);
    },

    destroy: function() {
        if (this._stateChangedId) {
            GObject.Object.prototype.disconnect.call(this._device, this._stateChangedId);
            this._stateChangedId = 0;
        }
        if (this._activeConnectionChangedId) {
            GObject.Object.prototype.disconnect.call(this._device, this._activeConnectionChangedId);
            this._activeConnectionChangedId = 0;
        }

        this.parent();
    },

    _activeConnectionChanged: function() {
        if (this._activeConnection) {
            let item = this._connectionItems.get(this._activeConnection._connection.get_uuid());
            item.setActiveConnection(null);
        }

        this._activeConnection = this._device.active_connection;

        if (this._activeConnection) {
            ensureActiveConnectionProps(this._activeConnection, this._settings);
            let item = this._connectionItems.get(this._activeConnection._connection.get_uuid());
            item.setActiveConnection(this._activeConnection);
        }
    },

    _deviceStateChanged: function(device, newstate, oldstate, reason) {
        if (newstate == oldstate) {
            log('device emitted state-changed without actually changing state');
            return;
        }

        /* Emit a notification if activation fails, but don't do it
           if the reason is no secrets, as that indicates the user
           cancelled the agent dialog */
        if (newstate == NetworkManager.DeviceState.FAILED &&
            reason != NetworkManager.DeviceStateReason.NO_SECRETS) {
            this.emit('activation-failed', reason);
        }

        this._sync();
    },

    _connectionValid: function(connection) {
        return this._device.connection_valid(connection);
    },

    activateConnection: function(connection) {
        this._client.activate_connection(connection, this._device, null, null);
    },

    deactivateConnection: function(activeConnection) {
        this._device.disconnect(null);
    },

    setDeviceDescription: function(desc) {
        this._description = desc;
        this._sync();
    },

    _getDescription: function() {
        return this._description;
    },

    _sync: function() {
        let nItems = this._connectionItems.size;
        this._autoConnectItem.actor.visible = (nItems == 0);
        this._deactivateItem.actor.visible = this._device.state > NetworkManager.DeviceState.DISCONNECTED;
        this.parent();
    },

    _getStatus: function() {
        if (!this._device)
            return '';

        switch(this._device.state) {
        case NetworkManager.DeviceState.DISCONNECTED:
            /* Translators: %s is a network identifier */
            return _("%s Off").format(this._getDescription());
        case NetworkManager.DeviceState.ACTIVATED:
            /* Translators: %s is a network identifier */
            return _("%s Connected").format(this._getDescription());
        case NetworkManager.DeviceState.UNMANAGED:
            /* Translators: this is for network devices that are physically present but are not
               under NetworkManager's control (and thus cannot be used in the menu);
               %s is a network identifier */
            return _("%s Unmanaged").format(this._getDescription());
        case NetworkManager.DeviceState.DEACTIVATING:
            /* Translators: %s is a network identifier */
            return _("%s Disconnecting").format(this._getDescription());
        case NetworkManager.DeviceState.PREPARE:
        case NetworkManager.DeviceState.CONFIG:
        case NetworkManager.DeviceState.IP_CONFIG:
        case NetworkManager.DeviceState.IP_CHECK:
        case NetworkManager.DeviceState.SECONDARIES:
            /* Translators: %s is a network identifier */
            return _("%s Connecting").format(this._getDescription());
        case NetworkManager.DeviceState.NEED_AUTH:
            /* Translators: this is for network connections that require some kind of key or password; %s is a network identifier */
            return _("%s Requires Authentication").format(this._getDescription());
        case NetworkManager.DeviceState.UNAVAILABLE:
            // This state is actually a compound of various states (generically unavailable,
            // firmware missing), that are exposed by different properties (whose state may
            // or may not updated when we receive state-changed).
            if (this._device.firmware_missing) {
                /* Translators: this is for devices that require some kind of firmware or kernel
                   module, which is missing; %s is a network identifier */
                return _("Firmware Missing For %s").format(this._getDescription());
            }
            /* Translators: this is for a network device that cannot be activated (for example it
               is disabled by rfkill, or it has no coverage; %s is a network identifier */
            return _("%s Unavailable").format(this._getDescription());
        case NetworkManager.DeviceState.FAILED:
            /* Translators: %s is a network identifier */
            return _("%s Connection Failed").format(this._getDescription());
        default:
            log('Device state invalid, is %d'.format(this._device.state));
            return 'invalid';
        }
    },
});

var NMDeviceWired = new Lang.Class({
    Name: 'NMDeviceWired',
    Extends: NMConnectionDevice,
    category: NMConnectionCategory.WIRED,

    _init: function(client, device, settings) {
        this.parent(client, device, settings);

        this.item.menu.addMenuItem(createSettingsAction(_("Wired Settings"), device));
    },

    _hasCarrier: function() {
        if (this._device instanceof NMClient.DeviceEthernet)
            return this._device.carrier;
        else
            return true;
    },

    _sync: function() {
        this.item.actor.visible = this._hasCarrier();
        this.parent();
    },

    getIndicatorIcon: function() {
        if (this._device.active_connection) {
            let state = this._device.active_connection.state;

            if (state == NetworkManager.ActiveConnectionState.ACTIVATING) {
                return 'network-wired-acquiring-symbolic';
            } else if (state == NetworkManager.ActiveConnectionState.ACTIVATED) {
                if (this._canReachInternet())
                    return 'network-wired-symbolic';
                else
                    return 'network-wired-no-route-symbolic';
            } else {
                return 'network-wired-disconnected-symbolic';
            }
        } else
            return 'network-wired-disconnected-symbolic';
    }
});

var NMDeviceModem = new Lang.Class({
    Name: 'NMDeviceModem',
    Extends: NMConnectionDevice,
    category: NMConnectionCategory.WWAN,

    _init: function(client, device, settings) {
        this.parent(client, device, settings);

        this.item.menu.addMenuItem(createSettingsAction(_("Mobile Broadband Settings"), device));

        this._mobileDevice = null;

        let capabilities = device.current_capabilities;
        if (device.udi.indexOf('/org/freedesktop/ModemManager1/Modem') == 0)
            this._mobileDevice = new ModemManager.BroadbandModem(device.udi, capabilities);
        else if (capabilities & NetworkManager.DeviceModemCapabilities.GSM_UMTS)
            this._mobileDevice = new ModemManager.ModemGsm(device.udi);
        else if (capabilities & NetworkManager.DeviceModemCapabilities.CDMA_EVDO)
            this._mobileDevice = new ModemManager.ModemCdma(device.udi);
        else if (capabilities & NetworkManager.DeviceModemCapabilities.LTE)
            this._mobileDevice = new ModemManager.ModemGsm(device.udi);

        if (this._mobileDevice) {
            this._operatorNameId = this._mobileDevice.connect('notify::operator-name', Lang.bind(this, this._sync));
            this._signalQualityId = this._mobileDevice.connect('notify::signal-quality', Lang.bind(this, function() {
                this._iconChanged();
            }));
        }
    },

    _autoConnect: function() {
        Util.spawn(['gnome-control-center', 'network',
                    'connect-3g', this._device.get_path()]);
    },

    destroy: function() {
        if (this._operatorNameId) {
            this._mobileDevice.disconnect(this._operatorNameId);
            this._operatorNameId = 0;
        }
        if (this._signalQualityId) {
            this._mobileDevice.disconnect(this._signalQualityId);
            this._signalQualityId = 0;
        }

        this.parent();
    },

    _getStatus: function() {
        if (!this._client.wwan_hardware_enabled)
            /* Translators: %s is a network identifier */
            return _("%s Hardware Disabled").format(this._getDescription());
        else if (!this._client.wwan_enabled)
            /* Translators: this is for a network device that cannot be activated
               because it's disabled by rfkill (airplane mode); %s is a network identifier */
            return _("%s Disabled").format(this._getDescription());
        else if (this._device.state == NetworkManager.DeviceState.ACTIVATED &&
                 this._mobileDevice && this._mobileDevice.operator_name)
            return this._mobileDevice.operator_name;
        else
            return this.parent();
    },

    getIndicatorIcon: function() {
        if (this._device.active_connection) {
            if (this._device.active_connection.state == NetworkManager.ActiveConnectionState.ACTIVATING)
                return 'network-cellular-acquiring-symbolic';

            return this._getSignalIcon();
        } else {
            return 'network-cellular-signal-none-symbolic';
        }
    },

    _getSignalIcon: function() {
        return 'network-cellular-signal-' + signalToIcon(this._mobileDevice.signal_quality) + '-symbolic';
    },
});

var NMDeviceBluetooth = new Lang.Class({
    Name: 'NMDeviceBluetooth',
    Extends: NMConnectionDevice,
    category: NMConnectionCategory.WWAN,

    _init: function(client, device, settings) {
        this.parent(client, device, settings);

        this.item.menu.addMenuItem(createSettingsAction(_("Bluetooth Settings"), device));
    },

    _getDescription: function() {
        return this._device.name;
    },

    getConnectLabel: function() {
        return _("Connect to Internet");
    },

    getIndicatorIcon: function() {
        if (this._device.active_connection) {
            let state = this._device.active_connection.state;
            if (state == NetworkManager.ActiveConnectionState.ACTIVATING)
                return 'network-cellular-acquiring-symbolic';
            else if (state == NetworkManager.ActiveConnectionState.ACTIVATED)
                return 'network-cellular-connected-symbolic';
            else
                return 'network-cellular-signal-none-symbolic';
        } else {
            return 'network-cellular-signal-none-symbolic';
        }
    }
});

var NMWirelessDialogItem = new Lang.Class({
    Name: 'NMWirelessDialogItem',

    _init: function(network) {
        this._network = network;
        this._ap = network.accessPoints[0];

        this.actor = new St.BoxLayout({ style_class: 'nm-dialog-item',
                                        can_focus: true,
                                        reactive: true });
        this.actor.connect('key-focus-in', Lang.bind(this, function() {
            this.emit('selected');
        }));
        let action = new Clutter.ClickAction();
        action.connect('clicked', Lang.bind(this, function() {
            this.actor.grab_key_focus();
        }));
        this.actor.add_action(action);

        let title = ssidToLabel(this._ap.get_ssid());
        this._label = new St.Label({ text: title });

        this.actor.label_actor = this._label;
        this.actor.add(this._label, { x_align: St.Align.START });

        this._selectedIcon = new St.Icon({ style_class: 'nm-dialog-icon',
                                           icon_name: 'object-select-symbolic' });
        this.actor.add(this._selectedIcon);

        this._icons = new St.BoxLayout({ style_class: 'nm-dialog-icons' });
        this.actor.add(this._icons, { expand: true, x_fill: false, x_align: St.Align.END });

        this._secureIcon = new St.Icon({ style_class: 'nm-dialog-icon' });
        if (this._ap._secType != NMAccessPointSecurity.NONE)
            this._secureIcon.icon_name = 'network-wireless-encrypted-symbolic';
        this._icons.add_actor(this._secureIcon);

        this._signalIcon = new St.Icon({ style_class: 'nm-dialog-icon' });
        this._icons.add_actor(this._signalIcon);

        this._sync();
    },

    _sync: function() {
        this._signalIcon.icon_name = this._getSignalIcon();
    },

    updateBestAP: function(ap) {
        this._ap = ap;
        this._sync();
    },

    setActive: function(isActive) {
        this._selectedIcon.opacity = isActive ? 255 : 0;
    },

    _getSignalIcon: function() {
        if (this._ap.mode == NM80211Mode.ADHOC)
            return 'network-workgroup-symbolic';
        else
            return 'network-wireless-signal-' + signalToIcon(this._ap.strength) + '-symbolic';
    }
});
Signals.addSignalMethods(NMWirelessDialogItem.prototype);

var NMWirelessDialog = new Lang.Class({
    Name: 'NMWirelessDialog',
    Extends: ModalDialog.ModalDialog,

    _init: function(client, device, settings) {
        this.parent({ styleClass: 'nm-dialog' });

        this._client = client;
        this._device = device;

        this._wirelessEnabledChangedId = this._client.connect('notify::wireless-enabled',
                                                              Lang.bind(this, this._syncView));

        this._rfkill = Rfkill.getRfkillManager();
        this._airplaneModeChangedId = this._rfkill.connect('airplane-mode-changed',
                                                           Lang.bind(this, this._syncView));

        this._networks = [];
        this._buildLayout();

        let connections = settings.list_connections();
        this._connections = connections.filter(Lang.bind(this, function(connection) {
            return device.connection_valid(connection);
        }));

        this._apAddedId = device.connect('access-point-added', Lang.bind(this, this._accessPointAdded));
        this._apRemovedId = device.connect('access-point-removed', Lang.bind(this, this._accessPointRemoved));
        this._activeApChangedId = device.connect('notify::active-access-point', Lang.bind(this, this._activeApChanged));

        // accessPointAdded will also create dialog items
        let accessPoints = device.get_access_points() || [ ];
        accessPoints.forEach(Lang.bind(this, function(ap) {
            this._accessPointAdded(this._device, ap);
        }));

        this._selectedNetwork = null;
        this._activeApChanged();
        this._updateSensitivity();
        this._syncView();

        this._scanTimeoutId = Mainloop.timeout_add_seconds(15, Lang.bind(this, this._onScanTimeout));
        GLib.Source.set_name_by_id(this._scanTimeoutId, '[gnome-shell] this._onScanTimeout');
        this._onScanTimeout();

        let id = Main.sessionMode.connect('updated', () => {
            if (Main.sessionMode.allowSettings)
                return;

            Main.sessionMode.disconnect(id);
            this.close();
        });
    },

    destroy: function() {
        if (this._apAddedId) {
            GObject.Object.prototype.disconnect.call(this._device, this._apAddedId);
            this._apAddedId = 0;
        }
        if (this._apRemovedId) {
            GObject.Object.prototype.disconnect.call(this._device, this._apRemovedId);
            this._apRemovedId = 0;
        }
        if (this._activeApChangedId) {
            GObject.Object.prototype.disconnect.call(this._device, this._activeApChangedId);
            this._activeApChangedId = 0;
        }
        if (this._wirelessEnabledChangedId) {
            this._client.disconnect(this._wirelessEnabledChangedId);
            this._wirelessEnabledChangedId = 0;
        }
        if (this._airplaneModeChangedId) {
            this._rfkill.disconnect(this._airplaneModeChangedId);
            this._airplaneModeChangedId = 0;
        }

        if (this._scanTimeoutId) {
            Mainloop.source_remove(this._scanTimeoutId);
            this._scanTimeoutId = 0;
        }

        this.parent();
    },

    _onScanTimeout: function() {
        this._device.request_scan_simple(null);
        return GLib.SOURCE_CONTINUE;
    },

    _activeApChanged: function() {
        if (this._activeNetwork)
            this._activeNetwork.item.setActive(false);

        this._activeNetwork = null;
        if (this._device.active_access_point) {
            let idx = this._findNetwork(this._device.active_access_point);
            if (idx >= 0)
                this._activeNetwork = this._networks[idx];
        }

        if (this._activeNetwork)
            this._activeNetwork.item.setActive(true);
        this._updateSensitivity();
    },

    _updateSensitivity: function() {
        let connectSensitive = this._client.wireless_enabled && this._selectedNetwork && (this._selectedNetwork != this._activeNetwork);
        this._connectButton.reactive = connectSensitive;
        this._connectButton.can_focus = connectSensitive;
    },

    _syncView: function() {
        if (this._rfkill.airplaneMode) {
            this._airplaneBox.show();

            this._airplaneIcon.icon_name = 'airplane-mode-symbolic';
            this._airplaneHeadline.text = _("Airplane Mode is On");
            this._airplaneText.text = _("Wi-Fi is disabled when airplane mode is on.");
            this._airplaneButton.label = _("Turn Off Airplane Mode");

            this._airplaneButton.visible = !this._rfkill.hwAirplaneMode;
            this._airplaneInactive.visible = this._rfkill.hwAirplaneMode;
            this._noNetworksBox.hide();
        } else if (!this._client.wireless_enabled) {
            this._airplaneBox.show();

            this._airplaneIcon.icon_name = 'dialog-information-symbolic';
            this._airplaneHeadline.text = _("Wi-Fi is Off");
            this._airplaneText.text = _("Wi-Fi needs to be turned on in order to connect to a network.");
            this._airplaneButton.label = _("Turn On Wi-Fi");

            this._airplaneButton.show();
            this._airplaneInactive.hide();
            this._noNetworksBox.hide();
        } else {
            this._airplaneBox.hide();

            this._noNetworksBox.visible = (this._networks.length == 0);
        }

        if (this._noNetworksBox.visible)
            this._noNetworksSpinner.play();
        else
            this._noNetworksSpinner.stop();
    },

    _buildLayout: function() {
        let headline = new St.BoxLayout({ style_class: 'nm-dialog-header-hbox' });

        let icon = new St.Icon({ style_class: 'nm-dialog-header-icon',
                                 icon_name: 'network-wireless-signal-excellent-symbolic' });

        let titleBox = new St.BoxLayout({ vertical: true });
        let title = new St.Label({ style_class: 'nm-dialog-header',
                                   text: _("Wi-Fi Networks") });
        let subtitle = new St.Label({ style_class: 'nm-dialog-subheader',
                                      text: _("Select a network") });
        titleBox.add(title);
        titleBox.add(subtitle);

        headline.add(icon);
        headline.add(titleBox);

        this.contentLayout.style_class = 'nm-dialog-content';
        this.contentLayout.add(headline);

        this._stack = new St.Widget({ layout_manager: new Clutter.BinLayout() });

        this._itemBox = new St.BoxLayout({ vertical: true });
        this._scrollView = new St.ScrollView({ style_class: 'nm-dialog-scroll-view' });
        this._scrollView.set_x_expand(true);
        this._scrollView.set_y_expand(true);
        this._scrollView.set_policy(Gtk.PolicyType.NEVER,
                                    Gtk.PolicyType.AUTOMATIC);
        this._scrollView.add_actor(this._itemBox);
        this._stack.add_child(this._scrollView);

        this._noNetworksBox = new St.BoxLayout({ vertical: true,
                                                 style_class: 'no-networks-box',
                                                 x_align: Clutter.ActorAlign.CENTER,
                                                 y_align: Clutter.ActorAlign.CENTER });

        let file = Gio.File.new_for_uri('resource:///org/gnome/shell/theme/process-working.svg');
        this._noNetworksSpinner = new Animation.AnimatedIcon(file, 16, 16);
        this._noNetworksBox.add_actor(this._noNetworksSpinner.actor);
        this._noNetworksBox.add_actor(new St.Label({ style_class: 'no-networks-label',
                                                     text: _("No Networks") }));
        this._stack.add_child(this._noNetworksBox);

        this._airplaneBox = new St.BoxLayout({ vertical: true,
                                               style_class: 'nm-dialog-airplane-box',
                                               x_align: Clutter.ActorAlign.CENTER,
                                               y_align: Clutter.ActorAlign.CENTER });
        this._airplaneIcon = new St.Icon({ icon_size: 48 });
        this._airplaneHeadline = new St.Label({ style_class: 'nm-dialog-airplane-headline headline' });
        this._airplaneText = new St.Label({ style_class: 'nm-dialog-airplane-text' });

        let airplaneSubStack = new St.Widget({ layout_manager: new Clutter.BinLayout });
        this._airplaneButton = new St.Button({ style_class: 'modal-dialog-button button' });
        this._airplaneButton.connect('clicked', Lang.bind(this, function() {
            if (this._rfkill.airplaneMode)
                this._rfkill.airplaneMode = false;
            else
                this._client.wireless_enabled = true;
        }));
        airplaneSubStack.add_actor(this._airplaneButton);
        this._airplaneInactive = new St.Label({ style_class: 'nm-dialog-airplane-text',
                                                text: _("Use hardware switch to turn off") });
        airplaneSubStack.add_actor(this._airplaneInactive);

        this._airplaneBox.add(this._airplaneIcon, { x_align: St.Align.MIDDLE });
        this._airplaneBox.add(this._airplaneHeadline, { x_align: St.Align.MIDDLE });
        this._airplaneBox.add(this._airplaneText, { x_align: St.Align.MIDDLE });
        this._airplaneBox.add(airplaneSubStack, { x_align: St.Align.MIDDLE });
        this._stack.add_child(this._airplaneBox);

        this.contentLayout.add(this._stack, { expand: true });

        this._disconnectButton = this.addButton({ action: Lang.bind(this, this.close),
                                                  label: _("Cancel"),
                                                  key: Clutter.Escape });
        this._connectButton = this.addButton({ action: Lang.bind(this, this._connect),
                                               label: _("Connect"),
                                               key: Clutter.Return });
    },

    _connect: function() {
        let network = this._selectedNetwork;
        if (network.connections.length > 0) {
            let connection = network.connections[0];
            this._client.activate_connection(connection, this._device, null, null);
        } else {
            let accessPoints = network.accessPoints;
            if ((accessPoints[0]._secType == NMAccessPointSecurity.WPA2_ENT)
                || (accessPoints[0]._secType == NMAccessPointSecurity.WPA_ENT)) {
                // 802.1x-enabled APs require further configuration, so they're
                // handled in gnome-control-center
                Util.spawn(['gnome-control-center', 'network', 'connect-8021x-wifi',
                            this._device.get_path(), accessPoints[0].dbus_path]);
            } else {
                let connection = new NetworkManager.Connection();
                this._client.add_and_activate_connection(connection, this._device, accessPoints[0].dbus_path, null)
            }
        }

        this.close();
    },

    _notifySsidCb: function(accessPoint) {
        if (accessPoint.get_ssid() != null) {
            accessPoint.disconnect(accessPoint._notifySsidId);
            accessPoint._notifySsidId = 0;
            this._accessPointAdded(this._device, accessPoint);
        }
    },

    _getApSecurityType: function(accessPoint) {
        if (accessPoint._secType)
            return accessPoint._secType;

        let flags = accessPoint.flags;
        let wpa_flags = accessPoint.wpa_flags;
        let rsn_flags = accessPoint.rsn_flags;
        let type;
        if (rsn_flags != NM80211ApSecurityFlags.NONE) {
            /* RSN check first so that WPA+WPA2 APs are treated as RSN/WPA2 */
            if (rsn_flags & NM80211ApSecurityFlags.KEY_MGMT_802_1X)
	        type = NMAccessPointSecurity.WPA2_ENT;
	    else if (rsn_flags & NM80211ApSecurityFlags.KEY_MGMT_PSK)
	        type = NMAccessPointSecurity.WPA2_PSK;
        } else if (wpa_flags != NM80211ApSecurityFlags.NONE) {
            if (wpa_flags & NM80211ApSecurityFlags.KEY_MGMT_802_1X)
                type = NMAccessPointSecurity.WPA_ENT;
            else if (wpa_flags & NM80211ApSecurityFlags.KEY_MGMT_PSK)
	        type = NMAccessPointSecurity.WPA_PSK;
        } else {
            if (flags & NM80211ApFlags.PRIVACY)
                type = NMAccessPointSecurity.WEP;
            else
                type = NMAccessPointSecurity.NONE;
        }

        // cache the found value to avoid checking flags all the time
        accessPoint._secType = type;
        return type;
    },

    _networkSortFunction: function(one, two) {
        let oneHasConnection = one.connections.length != 0;
        let twoHasConnection = two.connections.length != 0;

        // place known connections first
        // (-1 = good order, 1 = wrong order)
        if (oneHasConnection && !twoHasConnection)
            return -1;
        else if (!oneHasConnection && twoHasConnection)
            return 1;

        let oneStrength = one.accessPoints[0].strength;
        let twoStrength = two.accessPoints[0].strength;

        // place stronger connections first
        if (oneStrength != twoStrength)
            return oneStrength < twoStrength ? 1 : -1;

        let oneHasSecurity = one.security != NMAccessPointSecurity.NONE;
        let twoHasSecurity = two.security != NMAccessPointSecurity.NONE;

        // place secure connections first
        // (we treat WEP/WPA/WPA2 the same as there is no way to
        // take them apart from the UI)
        if (oneHasSecurity && !twoHasSecurity)
            return -1;
        else if (!oneHasSecurity && twoHasSecurity)
            return 1;

        // sort alphabetically
        return GLib.utf8_collate(one.ssidText, two.ssidText);
    },

    _networkCompare: function(network, accessPoint) {
        if (!ssidCompare(network.ssid, accessPoint.get_ssid()))
            return false;
        if (network.mode != accessPoint.mode)
            return false;
        if (network.security != this._getApSecurityType(accessPoint))
            return false;

        return true;
    },

    _findExistingNetwork: function(accessPoint) {
        for (let i = 0; i < this._networks.length; i++) {
            let network = this._networks[i];
            for (let j = 0; j < network.accessPoints.length; j++) {
                if (network.accessPoints[j] == accessPoint)
                    return { network: i, ap: j };
            }
        }

        return null;
    },

    _findNetwork: function(accessPoint) {
        if (accessPoint.get_ssid() == null)
            return -1;

        for (let i = 0; i < this._networks.length; i++) {
            if (this._networkCompare(this._networks[i], accessPoint))
                return i;
        }
        return -1;
    },

    _checkConnections: function(network, accessPoint) {
        this._connections.forEach(function(connection) {
            if (accessPoint.connection_valid(connection) &&
                network.connections.indexOf(connection) == -1) {
                network.connections.push(connection);
            }
        });
    },

    _accessPointAdded: function(device, accessPoint) {
        if (accessPoint.get_ssid() == null) {
            // This access point is not visible yet
            // Wait for it to get a ssid
            accessPoint._notifySsidId = accessPoint.connect('notify::ssid', Lang.bind(this, this._notifySsidCb));
            return;
        }

        let pos = this._findNetwork(accessPoint);
        let network;

        if (pos != -1) {
            network = this._networks[pos];
            if (network.accessPoints.indexOf(accessPoint) != -1) {
                log('Access point was already seen, not adding again');
                return;
            }

            Util.insertSorted(network.accessPoints, accessPoint, function(one, two) {
                return two.strength - one.strength;
            });
            network.item.updateBestAP(network.accessPoints[0]);
            this._checkConnections(network, accessPoint);

            this._resortItems();
        } else {
            network = { ssid: accessPoint.get_ssid(),
                        mode: accessPoint.mode,
                        security: this._getApSecurityType(accessPoint),
                        connections: [ ],
                        item: null,
                        accessPoints: [ accessPoint ]
                      };
            network.ssidText = ssidToLabel(network.ssid);
            this._checkConnections(network, accessPoint);

            let newPos = Util.insertSorted(this._networks, network, this._networkSortFunction);
            this._createNetworkItem(network);
            this._itemBox.insert_child_at_index(network.item.actor, newPos);
        }

        this._syncView();
    },

    _accessPointRemoved: function(device, accessPoint) {
        let res = this._findExistingNetwork(accessPoint);

        if (res == null) {
            log('Removing an access point that was never added');
            return;
        }

        let network = this._networks[res.network];
        network.accessPoints.splice(res.ap, 1);

        if (network.accessPoints.length == 0) {
            network.item.actor.destroy();
            this._networks.splice(res.network, 1);
        } else {
            network.item.updateBestAP(network.accessPoints[0]);
            this._resortItems();
        }

        this._syncView();
    },

    _resortItems: function() {
        let adjustment = this._scrollView.vscroll.adjustment;
        let scrollValue = adjustment.value;

        this._itemBox.remove_all_children();
        this._networks.forEach(Lang.bind(this, function(network) {
            this._itemBox.add_child(network.item.actor);
        }));

        adjustment.value = scrollValue;
    },

    _selectNetwork: function(network) {
        if (this._selectedNetwork)
            this._selectedNetwork.item.actor.remove_style_pseudo_class('selected');

        this._selectedNetwork = network;
        this._updateSensitivity();

        if (this._selectedNetwork)
            this._selectedNetwork.item.actor.add_style_pseudo_class('selected');
    },

    _createNetworkItem: function(network) {
        network.item = new NMWirelessDialogItem(network);
        network.item.setActive(network == this._selectedNetwork);
        network.item.connect('selected', Lang.bind(this, function() {
            Util.ensureActorVisibleInScrollView(this._scrollView, network.item.actor);
            this._selectNetwork(network);
        }));
    },
});

var NMDeviceWireless = new Lang.Class({
    Name: 'NMDeviceWireless',
    category: NMConnectionCategory.WIRELESS,

    _init: function(client, device, settings) {
        this._client = client;
        this._device = device;
        this._settings = settings;

        this._description = '';

        this.item = new PopupMenu.PopupSubMenuMenuItem('', true);
        this.item.menu.addAction(_("Select Network"), Lang.bind(this, this._showDialog));

        this._toggleItem = new PopupMenu.PopupMenuItem('');
        this._toggleItem.connect('activate', Lang.bind(this, this._toggleWifi));
        this.item.menu.addMenuItem(this._toggleItem);

        this.item.menu.addMenuItem(createSettingsAction(_("Wi-Fi Settings"), device));

        this._wirelessEnabledChangedId = this._client.connect('notify::wireless-enabled', Lang.bind(this, this._sync));
        this._wirelessHwEnabledChangedId = this._client.connect('notify::wireless-hardware-enabled', Lang.bind(this, this._sync));
        this._activeApChangedId = this._device.connect('notify::active-access-point', Lang.bind(this, this._activeApChanged));
        this._stateChangedId = this._device.connect('state-changed', Lang.bind(this, this._deviceStateChanged));
        this._notifyConnectivityId = this._client.connect('notify::connectivity', Lang.bind(this, this._iconChanged));

        this._sync();
    },

    _iconChanged: function() {
        this._sync();
        this.emit('icon-changed');
    },

    destroy: function() {
        if (this._activeApChangedId) {
            GObject.Object.prototype.disconnect.call(this._device, this._activeApChangedId);
            this._activeApChangedId = 0;
        }
        if (this._stateChangedId) {
            GObject.Object.prototype.disconnect.call(this._device, this._stateChangedId);
            this._stateChangedId = 0;
        }
        if (this._strengthChangedId > 0) {
            this._activeAccessPoint.disconnect(this._strengthChangedId);
            this._strengthChangedId = 0;
        }
        if (this._wirelessEnabledChangedId) {
            this._client.disconnect(this._wirelessEnabledChangedId);
            this._wirelessEnabledChangedId = 0;
        }
        if (this._wirelessHwEnabledChangedId) {
            this._client.disconnect(this._wirelessHwEnabledChangedId);
            this._wirelessHwEnabledChangedId = 0;
        }
        if (this._dialog) {
            this._dialog.destroy();
            this._dialog = null;
        }
        if (this._notifyConnectivityId) {
            this._client.disconnect(this._notifyConnectivityId);
            this._notifyConnectivityId = 0;
        }

        this.item.destroy();
    },

    _deviceStateChanged: function(device, newstate, oldstate, reason) {
        if (newstate == oldstate) {
            log('device emitted state-changed without actually changing state');
            return;
        }

        /* Emit a notification if activation fails, but don't do it
           if the reason is no secrets, as that indicates the user
           cancelled the agent dialog */
        if (newstate == NetworkManager.DeviceState.FAILED &&
            reason != NetworkManager.DeviceStateReason.NO_SECRETS) {
            this.emit('activation-failed', reason);
        }

        this._sync();
    },

    _toggleWifi: function() {
        this._client.wireless_enabled = !this._client.wireless_enabled;
    },

    _showDialog: function() {
        this._dialog = new NMWirelessDialog(this._client, this._device, this._settings);
        this._dialog.connect('closed', Lang.bind(this, this._dialogClosed));
        this._dialog.open();
    },

    _dialogClosed: function() {
        this._dialog.destroy();
        this._dialog = null;
    },

    _strengthChanged: function() {
        this._iconChanged();
    },

    _activeApChanged: function() {
        if (this._activeAccessPoint) {
            this._activeAccessPoint.disconnect(this._strengthChangedId);
            this._strengthChangedId = 0;
        }

        this._activeAccessPoint = this._device.active_access_point;

        if (this._activeAccessPoint) {
            this._strengthChangedId = this._activeAccessPoint.connect('notify::strength',
                                                                      Lang.bind(this, this._strengthChanged));
        }

        this._sync();
    },

    _sync: function() {
        this._toggleItem.label.text = this._client.wireless_enabled ? _("Turn Off") : _("Turn On");
        this._toggleItem.actor.visible = this._client.wireless_hardware_enabled;

        this.item.icon.icon_name = this._getMenuIcon();
        this.item.label.text = this._getStatus();
    },

    setDeviceDescription: function(desc) {
        this._description = desc;
        this._sync();
    },

    _getStatus: function() {
        let ap = this._device.active_access_point;

        if (this._isHotSpotMaster())
            /* Translators: %s is a network identifier */
            return _("%s Hotspot Active").format(this._description);
        else if (this._device.state >= NetworkManager.DeviceState.PREPARE &&
                 this._device.state < NetworkManager.DeviceState.ACTIVATED)
            /* Translators: %s is a network identifier */
            return _("%s Connecting").format(this._description);
        else if (ap)
            return ssidToLabel(ap.get_ssid());
        else if (!this._client.wireless_hardware_enabled)
            /* Translators: %s is a network identifier */
            return _("%s Hardware Disabled").format(this._description);
        else if (!this._client.wireless_enabled)
            /* Translators: %s is a network identifier */
            return _("%s Off").format(this._description);
        else if (this._device.state == NetworkManager.DeviceState.DISCONNECTED)
            /* Translators: %s is a network identifier */
            return _("%s Not Connected").format(this._description);
        else
            return '';
    },

    _getMenuIcon: function() {
        if (this._device.active_connection)
            return this.getIndicatorIcon();
        else
            return 'network-wireless-signal-none-symbolic';
    },

    _canReachInternet: function() {
        if (this._client.primary_connection != this._device.active_connection)
            return true;

        return this._client.connectivity == NetworkManager.ConnectivityState.FULL;
    },

    _isHotSpotMaster: function() {
        if (!this._device.active_connection)
            return false;

        let connectionPath = this._device.active_connection.connection;
        if (!connectionPath)
            return false;

        let connection = this._settings.get_connection_by_path(connectionPath);
        if (!connection)
            return false;

        let ip4config = connection.get_setting_ip4_config();
        if (!ip4config)
            return false;

        return ip4config.get_method() == NetworkManager.SETTING_IP4_CONFIG_METHOD_SHARED;
    },

    getIndicatorIcon: function() {
        if (this._device.state < NetworkManager.DeviceState.PREPARE)
            return 'network-wireless-disconnected-symbolic';
        if (this._device.state < NetworkManager.DeviceState.ACTIVATED)
            return 'network-wireless-acquiring-symbolic';

        if (this._isHotSpotMaster())
            return 'network-wireless-hotspot-symbolic';

        let ap = this._device.active_access_point;
        if (!ap) {
            if (this._device.mode != NM80211Mode.ADHOC)
                log('An active wireless connection, in infrastructure mode, involves no access point?');

            if (this._canReachInternet())
                return 'network-wireless-connected-symbolic';
            else
                return 'network-wireless-no-route-symbolic';
        }

        if (this._canReachInternet())
            return 'network-wireless-signal-' + signalToIcon(ap.strength) + '-symbolic';
        else
            return 'network-wireless-no-route-symbolic';
    },
});
Signals.addSignalMethods(NMDeviceWireless.prototype);

var NMVPNConnectionItem = new Lang.Class({
    Name: 'NMVPNConnectionItem',
    Extends: NMConnectionItem,

    isActive: function() {
        if (this._activeConnection == null)
            return false;

        return this._activeConnection.vpn_state != NetworkManager.VPNConnectionState.DISCONNECTED;
    },

    _buildUI: function() {
        this.labelItem = new PopupMenu.PopupMenuItem('');
        this.labelItem.connect('activate', Lang.bind(this, this._toggle));

        this.radioItem = new PopupMenu.PopupSwitchMenuItem(this._connection.get_id(), false);
        this.radioItem.connect('toggled', Lang.bind(this, this._toggle));
    },

    _sync: function() {
        let isActive = this.isActive();
        this.labelItem.label.text = isActive ? _("Turn Off") : this._section.getConnectLabel();
        this.radioItem.setToggleState(isActive);
        this.radioItem.setStatus(this._getStatus());
        this.emit('icon-changed');
    },

    _getStatus: function() {
        if (this._activeConnection == null)
            return null;

        switch(this._activeConnection.vpn_state) {
        case NetworkManager.VPNConnectionState.DISCONNECTED:
        case NetworkManager.VPNConnectionState.ACTIVATED:
            return null;
        case NetworkManager.VPNConnectionState.PREPARE:
        case NetworkManager.VPNConnectionState.CONNECT:
        case NetworkManager.VPNConnectionState.IP_CONFIG_GET:
            return _("connecting…");
        case NetworkManager.VPNConnectionState.NEED_AUTH:
            /* Translators: this is for network connections that require some kind of key or password */
            return _("authentication required");
        case NetworkManager.VPNConnectionState.FAILED:
            return _("connection failed");
        default:
            return 'invalid';
        }
    },

    _connectionStateChanged: function(ac, newstate, reason) {
        if (newstate == NetworkManager.VPNConnectionState.FAILED &&
            reason != NetworkManager.VPNConnectionStateReason.NO_SECRETS) {
            // FIXME: if we ever want to show something based on reason,
            // we need to convert from NetworkManager.VPNConnectionStateReason
            // to NetworkManager.DeviceStateReason
            this.emit('activation-failed', reason);
        }

        this.emit('icon-changed');
        this.parent();
    },

    setActiveConnection: function(activeConnection) {
        if (this._activeConnectionChangedId > 0) {
            this._activeConnection.disconnect(this._activeConnectionChangedId);
            this._activeConnectionChangedId = 0;
        }

        this._activeConnection = activeConnection;

        if (this._activeConnection)
            this._activeConnectionChangedId = this._activeConnection.connect('vpn-state-changed',
                                                                             Lang.bind(this, this._connectionStateChanged));

        this._sync();
    },

    getIndicatorIcon: function() {
        if (this._activeConnection) {
            if (this._activeConnection.vpn_state < NetworkManager.VPNConnectionState.ACTIVATED)
                return 'network-vpn-acquiring-symbolic';
            else
                return 'network-vpn-symbolic';
        } else {
            return '';
        }
    },
});

var NMVPNSection = new Lang.Class({
    Name: 'NMVPNSection',
    Extends: NMConnectionSection,
    category: NMConnectionCategory.VPN,

    _init: function(client) {
        this.parent(client);

        this._vpnSettings = new PopupMenu.PopupMenuItem('');
        this.item.menu.addMenuItem(this._vpnSettings);
        this._vpnSettings.connect('activate', Lang.bind(this, this._onSettingsActivate));

        this._sync();
    },

    _sync: function() {
        let nItems = this._connectionItems.size;
        this.item.actor.visible = (nItems > 0);

        if (nItems > 1)
            this._vpnSettings.label.text = _("Network Settings");
        else
            this._vpnSettings.label.text = _("VPN Settings");

        this.parent();
    },

    _onSettingsActivate: function() {
        let nItems = this._connectionItems.size;
        if (nItems > 1) {
            let appSys = Shell.AppSystem.get_default();
            let app = appSys.lookup_app('gnome-network-panel.desktop');
            app.launch(0, -1, false);
        } else {
            let connection = this._connections[0];
            Util.spawnApp(['gnome-control-center', 'network', 'show-device',
                           connection.get_path()]);
        }
    },

    _getDescription: function() {
        return _("VPN");
    },

    _getStatus: function() {
        let values = this._connectionItems.values();
        for (let item of values) {
            if (item.isActive())
                return item.getName();
        }

        return _("VPN Off");
    },

    _getMenuIcon: function() {
        return this.getIndicatorIcon() || 'network-vpn-symbolic';
    },

    activateConnection: function(connection) {
        this._client.activate_connection(connection, null, null, null);
    },

    deactivateConnection: function(activeConnection) {
        this._client.deactivate_connection(activeConnection);
    },

    setActiveConnections: function(vpnConnections) {
        let connections = this._connectionItems.values();
        for (let item of connections) {
            item.setActiveConnection(null);
        }
        vpnConnections.forEach(Lang.bind(this, function(a) {
            if (a._connection) {
                let item = this._connectionItems.get(a._connection.get_uuid());
                item.setActiveConnection(a);
            }
        }));
    },

    _makeConnectionItem: function(connection) {
        return new NMVPNConnectionItem(this, connection);
    },

    getIndicatorIcon: function() {
        let items = this._connectionItems.values();
        for (let item of items) {
            let icon = item.getIndicatorIcon();
            if (icon)
                return icon;
        }
        return '';
    },
});
Signals.addSignalMethods(NMVPNSection.prototype);

var DeviceCategory = new Lang.Class({
    Name: 'DeviceCategory',
    Extends: PopupMenu.PopupMenuSection,

    _init: function(category) {
        this.parent();

        this._category = category;

        this.devices = [];

        this.section = new PopupMenu.PopupMenuSection();
        this.section.box.connect('actor-added', Lang.bind(this, this._sync));
        this.section.box.connect('actor-removed', Lang.bind(this, this._sync));
        this.addMenuItem(this.section);

        this._summaryItem = new PopupMenu.PopupSubMenuMenuItem('', true);
        this._summaryItem.icon.icon_name = this._getSummaryIcon();
        this.addMenuItem(this._summaryItem);

        this._summaryItem.menu.addSettingsAction(_('Network Settings'),
                                                 'gnome-network-panel.desktop');
        this._summaryItem.actor.hide();

    },

    _sync: function() {
        let nDevices = this.section.box.get_children().reduce(
            function(prev, child) {
                return prev + (child.visible ? 1 : 0);
            }, 0);
        this._summaryItem.label.text = this._getSummaryLabel(nDevices);
        let shouldSummarize = nDevices > MAX_DEVICE_ITEMS;
        this._summaryItem.actor.visible = shouldSummarize;
        this.section.actor.visible = !shouldSummarize;
    },

    _getSummaryIcon: function() {
        switch(this._category) {
            case NMConnectionCategory.WIRED:
                return 'network-wired-symbolic';
            case NMConnectionCategory.WIRELESS:
            case NMConnectionCategory.WWAN:
                return 'network-wireless-symbolic';
        }
        return '';
    },

    _getSummaryLabel: function(nDevices) {
        switch(this._category) {
            case NMConnectionCategory.WIRED:
                return ngettext("%s Wired Connection",
                                "%s Wired Connections",
                                nDevices).format(nDevices);
            case NMConnectionCategory.WIRELESS:
                return ngettext("%s Wi-Fi Connection",
                                "%s Wi-Fi Connections",
                                nDevices).format(nDevices);
            case NMConnectionCategory.WWAN:
                return ngettext("%s Modem Connection",
                                "%s Modem Connections",
                                nDevices).format(nDevices);
        }
        return '';
    }
});

var NMApplet = new Lang.Class({
    Name: 'NMApplet',
    Extends: PanelMenu.SystemIndicator,

    _init: function() {
        this.parent();

        this._primaryIndicator = this._addIndicator();
        this._vpnIndicator = this._addIndicator();

        // Device types
        this._dtypes = { };
        this._dtypes[NetworkManager.DeviceType.ETHERNET] = NMDeviceWired;
        this._dtypes[NetworkManager.DeviceType.WIFI] = NMDeviceWireless;
        this._dtypes[NetworkManager.DeviceType.MODEM] = NMDeviceModem;
        this._dtypes[NetworkManager.DeviceType.BT] = NMDeviceBluetooth;
        // TODO: WiMax support

        // Connection types
        this._ctypes = { };
        this._ctypes[NetworkManager.SETTING_WIRED_SETTING_NAME] = NMConnectionCategory.WIRED;
        this._ctypes[NetworkManager.SETTING_WIRELESS_SETTING_NAME] = NMConnectionCategory.WIRELESS;
        this._ctypes[NetworkManager.SETTING_BLUETOOTH_SETTING_NAME] = NMConnectionCategory.WWAN;
        this._ctypes[NetworkManager.SETTING_CDMA_SETTING_NAME] = NMConnectionCategory.WWAN;
        this._ctypes[NetworkManager.SETTING_GSM_SETTING_NAME] = NMConnectionCategory.WWAN;
        this._ctypes[NetworkManager.SETTING_VPN_SETTING_NAME] = NMConnectionCategory.VPN;

        NMClient.Client.new_async(null, Lang.bind(this, this._clientGot));
        NMClient.RemoteSettings.new_async(null, null, Lang.bind(this, this._remoteSettingsGot));
    },

    _clientGot: function(obj, result) {
        this._client = NMClient.Client.new_finish(result);

        this._tryLateInit();
    },

    _remoteSettingsGot: function(obj, result) {
        this._settings = NMClient.RemoteSettings.new_finish(result);

        this._tryLateInit();
    },

    _tryLateInit: function() {
        if (!this._client || !this._settings)
            return;

        this._activeConnections = [ ];
        this._connections = [ ];
        this._connectivityQueue = [ ];

        this._mainConnection = null;
        this._mainConnectionIconChangedId = 0;
        this._mainConnectionStateChangedId = 0;

        this._notification = null;

        this._nmDevices = [];
        this._devices = { };

        let categories = [NMConnectionCategory.WIRED,
                          NMConnectionCategory.WIRELESS,
                          NMConnectionCategory.WWAN];
        for (let category of categories) {
            this._devices[category] = new DeviceCategory(category);
            this.menu.addMenuItem(this._devices[category]);
        }

        this._vpnSection = new NMVPNSection(this._client);
        this._vpnSection.connect('activation-failed', Lang.bind(this, this._onActivationFailed));
        this._vpnSection.connect('icon-changed', Lang.bind(this, this._updateIcon));
        this.menu.addMenuItem(this._vpnSection.item);

        this._readConnections();
        this._readDevices();
        this._syncNMState();
        this._syncMainConnection();
        this._syncVPNConnections();

        this._client.connect('notify::manager-running', Lang.bind(this, this._syncNMState));
        this._client.connect('notify::networking-enabled', Lang.bind(this, this._syncNMState));
        this._client.connect('notify::state', Lang.bind(this, this._syncNMState));
        this._client.connect('notify::primary-connection', Lang.bind(this, this._syncMainConnection));
        this._client.connect('notify::activating-connection', Lang.bind(this, this._syncMainConnection));
        this._client.connect('notify::active-connections', Lang.bind(this, this._syncVPNConnections));
        this._client.connect('notify::connectivity', Lang.bind(this, this._syncConnectivity));
        this._client.connect('device-added', Lang.bind(this, this._deviceAdded));
        this._client.connect('device-removed', Lang.bind(this, this._deviceRemoved));
        this._settings.connect('new-connection', Lang.bind(this, this._newConnection));

        Main.sessionMode.connect('updated', Lang.bind(this, this._sessionUpdated));
        this._sessionUpdated();
    },

    _sessionUpdated: function() {
        let sensitive = !Main.sessionMode.isLocked && !Main.sessionMode.isGreeter;
        this.menu.setSensitive(sensitive);
    },

    _ensureSource: function() {
        if (!this._source) {
            this._source = new MessageTray.Source(_("Network Manager"),
                                                  'network-transmit-receive');
            this._source.policy = new MessageTray.NotificationApplicationPolicy('gnome-network-panel');

            this._source.connect('destroy', Lang.bind(this, function() {
                this._source = null;
            }));
            Main.messageTray.add(this._source);
        }
    },

    _readDevices: function() {
        let devices = this._client.get_devices() || [ ];
        for (let i = 0; i < devices.length; ++i) {
            this._deviceAdded(this._client, devices[i], true);
        }
        this._syncDeviceNames();
    },

    _notify: function(iconName, title, text, urgency) {
        if (this._notification)
            this._notification.destroy();

        this._ensureSource();

        let gicon = new Gio.ThemedIcon({ name: iconName });
        this._notification = new MessageTray.Notification(this._source, title, text, { gicon: gicon });
        this._notification.setUrgency(urgency);
        this._notification.setTransient(true);
        this._notification.connect('destroy', function() {
            this._notification = null;
        });
        this._source.notify(this._notification);
    },

    _onActivationFailed: function(device, reason) {
        // XXX: nm-applet has no special text depending on reason
        // but I'm not sure of this generic message
        this._notify('network-error-symbolic',
                     _("Connection failed"),
                     _("Activation of network connection failed"),
                     MessageTray.Urgency.HIGH);
    },

    _syncDeviceNames: function() {
        let names = NMGtk.utils_disambiguate_device_names(this._nmDevices);
        for (let i = 0; i < this._nmDevices.length; i++) {
            let device = this._nmDevices[i];
            let description = names[i];
            if (device._delegate)
                device._delegate.setDeviceDescription(description);
        }
    },

    _deviceAdded: function(client, device, skipSyncDeviceNames) {
        if (device._delegate) {
            // already seen, not adding again
            return;
        }

        let wrapperClass = this._dtypes[device.get_device_type()];
        if (wrapperClass) {
            let wrapper = new wrapperClass(this._client, device, this._settings);
            device._delegate = wrapper;
            this._addDeviceWrapper(wrapper);

            this._nmDevices.push(device);
            if (!skipSyncDeviceNames)
                this._syncDeviceNames();

            if (wrapper instanceof NMConnectionSection) {
                this._connections.forEach(function(connection) {
                    wrapper.checkConnection(connection);
                });
            }
        }
    },

    _addDeviceWrapper: function(wrapper) {
        wrapper._activationFailedId = wrapper.connect('activation-failed',
                                                      Lang.bind(this, this._onActivationFailed));

        let section = this._devices[wrapper.category].section;
        section.addMenuItem(wrapper.item);

        let devices = this._devices[wrapper.category].devices;
        devices.push(wrapper);
    },

    _deviceRemoved: function(client, device) {
        let pos = this._nmDevices.indexOf(device);
        if (pos != -1) {
            this._nmDevices.splice(pos, 1);
            this._syncDeviceNames();
        }

        let wrapper = device._delegate;
        if (!wrapper) {
            log('Removing a network device that was not added');
            return;
        }

        this._removeDeviceWrapper(wrapper);
    },

    _removeDeviceWrapper: function(wrapper) {
        wrapper.disconnect(wrapper._activationFailedId);
        wrapper.destroy();

        let devices = this._devices[wrapper.category].devices;
        let pos = devices.indexOf(wrapper);
        devices.splice(pos, 1);
    },

    _getMainConnection: function() {
        let connection;

        connection = this._client.get_primary_connection();
        if (connection) {
            ensureActiveConnectionProps(connection, this._settings);
            return connection;
        }

        connection = this._client.get_activating_connection();
        if (connection) {
            ensureActiveConnectionProps(connection, this._settings);
            return connection;
        }

        return null;
    },

    _syncMainConnection: function() {
        if (this._mainConnectionIconChangedId > 0) {
            this._mainConnection._primaryDevice.disconnect(this._mainConnectionIconChangedId);
            this._mainConnectionIconChangedId = 0;
        }

        if (this._mainConnectionStateChangedId > 0) {
            this._mainConnection.disconnect(this._mainConnectionStateChangedId);
            this._mainConnectionStateChangedId = 0;
        }

        this._mainConnection = this._getMainConnection();

        if (this._mainConnection) {
            if (this._mainConnection._primaryDevice)
                this._mainConnectionIconChangedId = this._mainConnection._primaryDevice.connect('icon-changed', Lang.bind(this, this._updateIcon));
            this._mainConnectionStateChangedId = this._mainConnection.connect('notify::state', Lang.bind(this, this._mainConnectionStateChanged));
            this._mainConnectionStateChanged();
        }

        this._updateIcon();
        this._syncConnectivity();
    },

    _syncVPNConnections: function() {
        let activeConnections = this._client.get_active_connections() || [];
        let vpnConnections = activeConnections.filter(function(a) {
            return (a instanceof NMClient.VPNConnection);
        });
        vpnConnections.forEach(Lang.bind(this, function(a) {
            ensureActiveConnectionProps(a, this._settings);
        }));
        this._vpnSection.setActiveConnections(vpnConnections);

        this._updateIcon();
    },

    _mainConnectionStateChanged: function() {
        if (this._mainConnection.state == NetworkManager.ActiveConnectionState.ACTIVATED && this._notification)
            this._notification.destroy();
    },

    _ignoreConnection: function(connection) {
        let setting = connection.get_setting_connection();
        if (!setting)
            return true;

        // Ignore slave connections
        if (setting.get_master())
            return true;

        return false;
    },

    _addConnection: function(connection) {
        if (this._ignoreConnection(connection))
            return;
        if (connection._updatedId) {
            // connection was already seen
            return;
        }

        connection._removedId = connection.connect('removed', Lang.bind(this, this._connectionRemoved));
        connection._updatedId = connection.connect('updated', Lang.bind(this, this._updateConnection));

        this._updateConnection(connection);
        this._connections.push(connection);
    },

    _readConnections: function() {
        let connections = this._settings.list_connections();
        connections.forEach(Lang.bind(this, this._addConnection));
    },

    _newConnection: function(settings, connection) {
        this._addConnection(connection);
    },

    _connectionRemoved: function(connection) {
        let pos = this._connections.indexOf(connection);
        if (pos != -1)
            this._connections.splice(pos, 1);

        let section = connection._section;

        if (section == NMConnectionCategory.INVALID)
            return;

        if (section == NMConnectionCategory.VPN) {
            this._vpnSection.removeConnection(connection);
        } else {
            let devices = this._devices[section].devices;
            for (let i = 0; i < devices.length; i++) {
                if (devices[i] instanceof NMConnectionSection)
                    devices[i].removeConnection(connection);
            }
        }

        connection.disconnect(connection._removedId);
        connection.disconnect(connection._updatedId);
        connection._removedId = connection._updatedId = 0;
    },

    _updateConnection: function(connection) {
        let connectionSettings = connection.get_setting_by_name(NetworkManager.SETTING_CONNECTION_SETTING_NAME);
        connection._type = connectionSettings.type;
        connection._section = this._ctypes[connection._type] || NMConnectionCategory.INVALID;

        let section = connection._section;

        if (section == NMConnectionCategory.INVALID)
            return;

        if (section == NMConnectionCategory.VPN) {
            this._vpnSection.checkConnection(connection);
        } else {
            let devices = this._devices[section].devices;
            devices.forEach(function(wrapper) {
                if (wrapper instanceof NMConnectionSection)
                    wrapper.checkConnection(connection);
            });
        }
    },

    _syncNMState: function() {
        this.indicators.visible = this._client.manager_running;
        this.menu.actor.visible = this._client.networking_enabled;

        this._syncConnectivity();
    },

    _flushConnectivityQueue: function() {
        if (this._portalHelperProxy) {
            for (let item of this._connectivityQueue)
                this._portalHelperProxy.CloseRemote(item);
        }

        this._connectivityQueue = [];
    },

    _closeConnectivityCheck: function(path) {
        let index = this._connectivityQueue.indexOf(path);

        if (index >= 0) {
            if (this._portalHelperProxy)
                this._portalHelperProxy.CloseRemote(path);

            this._connectivityQueue.splice(index, 1);
        }
    },

    _portalHelperDone: function(proxy, emitter, parameters) {
        let [path, result] = parameters;

        if (result == PortalHelperResult.CANCELLED) {
            // Keep the connection in the queue, so the user is not
            // spammed with more logins until we next flush the queue,
            // which will happen once he chooses a better connection
            // or we get to full connectivity through other means
        } else if (result == PortalHelperResult.COMPLETED) {
            this._closeConnectivityCheck(path);
            return;
        } else if (result == PortalHelperResult.RECHECK) {
            this._client.check_connectivity_async(null, Lang.bind(this, function(client, result) {
                try {
                    let state = client.check_connectivity_finish(result);
                    if (state >= NetworkManager.ConnectivityState.FULL)
                        this._closeConnectivityCheck(path);
                } catch(e) { }
            }));
        } else {
            log('Invalid result from portal helper: ' + result);
        }
    },

    _syncConnectivity: function() {
        if (this._mainConnection == null ||
            this._mainConnection.state != NetworkManager.ActiveConnectionState.ACTIVATED) {
            this._flushConnectivityQueue();
            return;
        }

        let isPortal = this._client.connectivity == NetworkManager.ConnectivityState.PORTAL;
        // For testing, allow interpreting any value != FULL as PORTAL, because
        // LIMITED (no upstream route after the default gateway) is easy to obtain
        // with a tethered phone
        // NONE is also possible, with a connection configured to force no default route
        // (but in general we should only prompt a portal if we know there is a portal)
        if (GLib.getenv('GNOME_SHELL_CONNECTIVITY_TEST') != null)
            isPortal = isPortal || this._client.connectivity < NetworkManager.ConnectivityState.FULL;
        if (!isPortal || Main.sessionMode.isGreeter)
            return;

        let path = this._mainConnection.get_path();
        for (let item of this._connectivityQueue) {
            if (item == path)
                return;
        }

        let timestamp = global.get_current_time();
        if (this._portalHelperProxy) {
            this._portalHelperProxy.AuthenticateRemote(path, '', timestamp);
        } else {
            new PortalHelperProxy(Gio.DBus.session, 'org.gnome.Shell.PortalHelper',
                                  '/org/gnome/Shell/PortalHelper', Lang.bind(this, function (proxy, error) {
                                      if (error) {
                                          log('Error launching the portal helper: ' + error);
                                          return;
                                      }

                                      this._portalHelperProxy = proxy;
                                      proxy.connectSignal('Done', Lang.bind(this, this._portalHelperDone));

                                      proxy.AuthenticateRemote(path, '', timestamp);
                                  }));
        }

        this._connectivityQueue.push(path);
    },

    _updateIcon: function() {
        if (!this._client.networking_enabled) {
            this._primaryIndicator.visible = false;
        } else {
            let dev = null;
            if (this._mainConnection)
                dev = this._mainConnection._primaryDevice;

            let state = this._client.get_state();
            let connected = state == NetworkManager.State.CONNECTED_GLOBAL;
            this._primaryIndicator.visible = (dev != null) || connected;
            if (dev) {
                this._primaryIndicator.icon_name = dev.getIndicatorIcon();
            } else if (connected) {
                if (this._client.connectivity == NetworkManager.ConnectivityState.FULL)
                    this._primaryIndicator.icon_name = 'network-wired-symbolic';
                else
                    this._primaryIndicator.icon_name = 'network-wired-no-route-symbolic';
            }
        }

        this._vpnIndicator.icon_name = this._vpnSection.getIndicatorIcon();
        this._vpnIndicator.visible = (this._vpnIndicator.icon_name != '');
    }
});
