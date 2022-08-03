// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported NMApplet */
const {Atk, Clutter, Gio, GLib, GObject, NM, Polkit, St} = imports.gi;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const MessageTray = imports.ui.messageTray;
const ModemManager = imports.misc.modemManager;
const Util = imports.misc.util;

const {loadInterfaceXML} = imports.misc.fileUtils;
const {registerDestroyableType} = imports.misc.signalTracker;

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(NM.Client, 'new_async');
Gio._promisify(NM.Client.prototype, 'check_connectivity_async');

const MAX_VISIBLE_NETWORKS = 8;
var MAX_DEVICE_ITEMS = 4;

// small optimization, to avoid using [] all the time
const NM80211Mode = NM['80211Mode'];

var PortalHelperResult = {
    CANCELLED: 0,
    COMPLETED: 1,
    RECHECK: 2,
};

const PortalHelperIface = loadInterfaceXML('org.gnome.Shell.PortalHelper');
const PortalHelperInfo = Gio.DBusInterfaceInfo.new_for_xml(PortalHelperIface);

function signalToIcon(value) {
    if (value < 20)
        return 'none';
    else if (value < 40)
        return 'weak';
    else if (value < 50)
        return 'ok';
    else if (value < 80)
        return 'good';
    else
        return 'excellent';
}

function ssidToLabel(ssid) {
    let label = NM.utils_ssid_to_utf8(ssid.get_data());
    if (!label)
        label = _("<unknown>");
    return label;
}

function ensureActiveConnectionProps(active) {
    if (!active._primaryDevice) {
        let devices = active.get_devices();
        if (devices.length > 0) {
            // This list is guaranteed to have at most one device in it.
            let device = devices[0]._delegate;
            active._primaryDevice = device;
        }
    }
}

function launchSettingsPanel(panel, ...args) {
    const param = new GLib.Variant('(sav)',
        [panel, args.map(s => new GLib.Variant('s', s))]);
    const platformData = {
        'desktop-startup-id': new GLib.Variant('s',
            `_TIME${global.get_current_time()}`),
    };
    try {
        Gio.DBus.session.call(
            'org.gnome.Settings',
            '/org/gnome/Settings',
            'org.freedesktop.Application',
            'ActivateAction',
            new GLib.Variant('(sava{sv})',
                ['launch-panel', [param], platformData]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null);
    } catch (e) {
        log(`Failed to launch Settings panel: ${e.message}`);
    }
}

class ItemSorter {
    [Symbol.iterator] = this.items;

    /**
     * Maintains a list of sorted items. By default, items are
     * assumed to be objects with a name property.
     *
     * @param {object=} options - property object with options
     * @param {Function} options.sortFunc - a custom sort function
     **/
    constructor(options = {}) {
        const {sortFunc} = {
            sortFunc: this._sortByName.bind(this),
            ...options,
        };

        this._sortFunc = sortFunc;

        this._itemsOrder = [];
    }

    *items() {
        yield* this._itemsOrder;
    }

    _sortByName(one, two) {
        return GLib.utf8_collate(one.name, two.name);
    }

    /**
     * Insert or update item.
     *
     * @param {any} item - the item to upsert
     * @returns {number} - the sorted position of item
     */
    upsert(item) {
        this.delete(item);
        return Util.insertSorted(this._itemsOrder, item, this._sortFunc);
    }

    /**
     * @param {any} item - item to remove
     */
    delete(item) {
        const pos = this._itemsOrder.indexOf(item);
        if (pos >= 0)
            this._itemsOrder.splice(pos, 1);
    }
}

const NMMenuItem = GObject.registerClass({
    Properties: {
        'radio-mode': GObject.ParamSpec.boolean('radio-mode', '', '',
            GObject.ParamFlags.READWRITE,
            false),
        'is-active': GObject.ParamSpec.boolean('is-active', '', '',
            GObject.ParamFlags.READABLE,
            false),
        'name': GObject.ParamSpec.string('name', '', '',
            GObject.ParamFlags.READWRITE,
            ''),
        'icon-name': GObject.ParamSpec.string('icon-name', '', '',
            GObject.ParamFlags.READWRITE,
            ''),
    },
}, class NMMenuItem extends PopupMenu.PopupBaseMenuItem {
    get state() {
        return this._activeConnection?.state ??
            NM.ActiveConnectionState.DEACTIVATED;
    }

    get is_active() {
        return this.state <= NM.ActiveConnectionState.ACTIVATED;
    }

    get timestamp() {
        return 0;
    }

    activate() {
        super.activate(Clutter.get_current_event());
    }

    _activeConnectionStateChanged() {
        this.notify('is-active');
        this.notify('icon-name');

        this._sync();
    }

    _setActiveConnection(activeConnection) {
        this._activeConnection?.disconnectObject(this);

        this._activeConnection = activeConnection;

        this._activeConnection?.connectObject(
            'notify::state', () => this._activeConnectionStateChanged(),
            this);
        this._activeConnectionStateChanged();
    }

    _sync() {
        // Overridden by subclasses
    }
});

/**
 * Item that contains a section, and can be collapsed
 * into a submenu
 */
const NMSectionItem = GObject.registerClass({
    Properties: {
        'use-submenu': GObject.ParamSpec.boolean('use-submenu', '', '',
            GObject.ParamFlags.READWRITE,
            false),
    },
}, class NMSectionItem extends NMMenuItem {
    constructor() {
        super({
            activate: false,
            can_focus: false,
        });

        this._useSubmenu = false;

        // Turn into an empty container with no padding
        this.styleClass = '';
        this.setOrnament(PopupMenu.Ornament.HIDDEN);

        // Add intermediate section; we need this for submenu support
        this._mainSection = new PopupMenu.PopupMenuSection();
        this.add_child(this._mainSection.actor);

        this._submenuItem = new PopupMenu.PopupSubMenuMenuItem('', true);
        this._mainSection.addMenuItem(this._submenuItem);
        this._submenuItem.hide();

        this.section = new PopupMenu.PopupMenuSection();
        this._mainSection.addMenuItem(this.section);

        // Represents the item as a whole when shown
        this.bind_property('name',
            this._submenuItem.label, 'text',
            GObject.BindingFlags.DEFAULT);
        this.bind_property('icon-name',
            this._submenuItem.icon, 'icon-name',
            GObject.BindingFlags.DEFAULT);
    }

    _setParent(parent) {
        super._setParent(parent);
        this._mainSection._setParent(parent);

        parent?.connect('menu-closed',
            () => this._mainSection.emit('menu-closed'));
    }

    get use_submenu() {
        return this._useSubmenu;
    }

    set use_submenu(useSubmenu) {
        if (this._useSubmenu === useSubmenu)
            return;

        this._useSubmenu = useSubmenu;
        this._submenuItem.visible = useSubmenu;

        if (useSubmenu) {
            this._mainSection.box.remove_child(this.section.actor);
            this._submenuItem.menu.box.add_child(this.section.actor);
        } else {
            this._submenuItem.menu.box.remove_child(this.section.actor);
            this._mainSection.box.add_child(this.section.actor);
        }
    }
});

const NMConnectionItem = GObject.registerClass(
class NMConnectionItem extends NMMenuItem {
    constructor(section, connection) {
        super();

        this._section = section;
        this._connection = connection;
        this._activeConnection = null;

        this._icon = new St.Icon({
            style_class: 'popup-menu-icon',
            x_align: Clutter.ActorAlign.END,
            visible: !this.radio_mode,
        });
        this.add_child(this._icon);

        this._label = new St.Label({
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);
        this.label_actor = this._label;

        this.bind_property('icon-name',
            this._icon, 'icon-name',
            GObject.BindingFlags.DEFAULT);
        this.bind_property('radio-mode',
            this._icon, 'visible',
            GObject.BindingFlags.INVERT_BOOLEAN);

        this.connectObject(
            'notify::radio-mode', () => this._sync(),
            'notify::name', () => this._sync(),
            this);
        this._sync();
    }

    get name() {
        return this._connection.get_id();
    }

    get timestamp() {
        return this._connection.get_setting_connection()?.get_timestamp() ?? 0;
    }

    updateForConnection(connection) {
        // connection should always be the same object
        // (and object path) as this._connection, but
        // this can be false if NetworkManager was restarted
        // and picked up connections in a different order
        // Just to be safe, we set it here again

        this._connection = connection;
        this.notify('name');
        this._sync();
    }

    _updateOrnament() {
        this.setOrnament(this.radio_mode && this.is_active
            ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
    }

    _getRegularLabel() {
        return this.is_active
            // Translators: %s is a device name like "MyPhone"
            ? _('Disconnect %s').format(this.name)
            // Translators: %s is a device name like "MyPhone"
            : _('Connect to %s').format(this.name);
    }

    _sync() {
        if (this.radioMode) {
            this._label.text = this.name;
            this.accessible_role = Atk.Role.CHECK_MENU_ITEM;
        } else {
            this._label.text = this._getRegularLabel();
            this.accessible_role = Atk.Role.MENU_ITEM;
        }
        this._updateOrnament();
    }

    activate() {
        super.activate();

        if (this.radio_mode && this._activeConnection != null)
            return; // only activate in radio mode

        if (this._activeConnection == null)
            this._section.activateConnection(this._connection);
        else
            this._section.deactivateConnection(this._activeConnection);

        this._sync();
    }

    setActiveConnection(connection) {
        this._setActiveConnection(connection);
    }
});

const NMDeviceConnectionItem = GObject.registerClass({
    Properties: {
        'device-name': GObject.ParamSpec.string('device-name', '', '',
            GObject.ParamFlags.READWRITE,
            ''),
    },
}, class NMDeviceConnectionItem extends NMConnectionItem {
    constructor(section, connection) {
        super(section, connection);

        this.connectObject(
            'notify::radio-mode', () => this.notify('name'),
            'notify::device-name', () => this.notify('name'),
            this);
    }

    get name() {
        return this.radioMode
            ?  this._connection.get_id()
            : this.deviceName;
    }
});

const NMDeviceItem = GObject.registerClass({
    Properties: {
        'single-device-mode': GObject.ParamSpec.boolean('single-device-mode', '', '',
            GObject.ParamFlags.READWRITE,
            false),
    },
}, class NMDeviceItem extends NMSectionItem {
    constructor(client, device) {
        super();

        if (this.constructor === NMDeviceItem)
            throw new TypeError(`Cannot instantiate abstract type ${this.constructor.name}`);

        this._client = client;
        this._device = device;
        this._deviceName = '';

        this._connectionItems = new Map();
        this._itemSorter = new ItemSorter();

        // Item shown in the 0-connections case
        this._autoConnectItem =
            this.section.addAction(_('Connect'), () => this._autoConnect(), '');

        // Represents the device as a whole when shown
        this.bind_property('name',
            this._autoConnectItem.label, 'text',
            GObject.BindingFlags.SYNC_CREATE);
        this.bind_property('icon-name',
            this._autoConnectItem._icon, 'icon-name',
            GObject.BindingFlags.SYNC_CREATE);

        this._deactivateItem =
            this.section.addAction(_('Turn Off'), () => this.deactivateConnection());

        this._client.connectObject(
            'notify::connectivity', () => this.notify('icon-name'),
            'notify::primary-connection', () => this.notify('icon-name'),
            this);

        this._device.connectObject(
            'notify::available-connections', () => this._syncConnections(),
            'notify::active-connection', () => this._activeConnectionChanged(),
            this);

        this.connect('notify::single-device-mode', () => this._sync());

        this._syncConnections();
        this._activeConnectionChanged();
    }

    _canReachInternet() {
        if (this._client.primary_connection !== this._device.active_connection)
            return true;

        return this._client.connectivity === NM.ConnectivityState.FULL;
    }

    _autoConnect() {
        let connection = new NM.SimpleConnection();
        this._client.add_and_activate_connection_async(connection, this._device, null, null, null);
    }

    _activeConnectionChanged() {
        const oldItem = this._connectionItems.get(
            this._activeConnection?.connection);
        oldItem?.setActiveConnection(null);

        this._setActiveConnection(this._device.active_connection);

        const newItem = this._connectionItems.get(
            this._activeConnection?.connection);
        newItem?.setActiveConnection(this._activeConnection);
    }

    _syncConnections() {
        const available = this._device.get_available_connections();
        const removed = [...this._connectionItems.keys()]
            .filter(conn => !available.includes(conn));

        for (const conn of removed)
            this._removeConnection(conn);

        for (const conn of available)
            this._addConnection(conn);
    }

    activateConnection(connection) {
        this._client.activate_connection_async(connection, this._device, null, null, null);
    }

    deactivateConnection(_activeConnection) {
        this._device.disconnect(null);
    }

    _onConnectionChanged(connection) {
        const item = this._connectionItems.get(connection);
        item.updateForConnection(connection);
    }

    _resortItem(item) {
        const pos = this._itemSorter.upsert(item);
        this.section.moveMenuItem(item, pos);
    }

    _addConnection(connection) {
        if (this._connectionItems.has(connection))
            return;

        connection.connectObject(
            'changed', this._onConnectionChanged.bind(this),
            this);

        const item = new NMDeviceConnectionItem(this, connection);

        this.bind_property('radio-mode',
            item, 'radio-mode',
            GObject.BindingFlags.SYNC_CREATE);
        this.bind_property('name',
            item, 'device-name',
            GObject.BindingFlags.SYNC_CREATE);
        this.bind_property('icon-name',
            item, 'icon-name',
            GObject.BindingFlags.SYNC_CREATE);
        item.connectObject(
            'notify::name', () => this._resortItem(item),
            this);

        const pos = this._itemSorter.upsert(item);
        this.section.addMenuItem(item, pos);
        this._connectionItems.set(connection, item);
        this._sync();
    }

    _removeConnection(connection) {
        const item = this._connectionItems.get(connection);
        if (!item)
            return;

        this._itemSorter.delete(item);
        this._connectionItems.delete(connection);
        item.destroy();

        this._sync();
    }

    setDeviceName(name) {
        this._deviceName = name;
        this.notify('name');
    }

    _sync() {
        const nItems = this._connectionItems.size;
        this.radio_mode = nItems > 1;
        this.useSubmenu = this.radioMode && !this.singleDeviceMode;
        this._autoConnectItem.visible = nItems === 0;
        this._deactivateItem.visible = this.radioMode && this.isActive;
    }
});

const NMWiredDeviceItem = GObject.registerClass(
class NMWiredDeviceItem extends NMDeviceItem {
    get icon_name() {
        switch (this.state) {
        case NM.ActiveConnectionState.ACTIVATING:
            return 'network-wired-acquiring-symbolic';
        case NM.ActiveConnectionState.ACTIVATED:
            return this._canReachInternet()
                ? 'network-wired-symbolic'
                : 'network-wired-no-route-symbolic';
        default:
            return 'network-wired-disconnected-symbolic';
        }
    }

    get name() {
        return this._deviceName;
    }

    _hasCarrier() {
        if (this._device instanceof NM.DeviceEthernet)
            return this._device.carrier;
        else
            return true;
    }

    _sync() {
        this.visible = this._hasCarrier();
        super._sync();
    }
});

const NMModemDeviceItem = GObject.registerClass(
class NMModemDeviceItem extends NMDeviceItem {
    constructor(client, device) {
        super(client, device);

        this._mobileDevice = null;

        let capabilities = device.current_capabilities;
        if (device.udi.indexOf('/org/freedesktop/ModemManager1/Modem') == 0)
            this._mobileDevice = new ModemManager.BroadbandModem(device.udi, capabilities);
        else if (capabilities & NM.DeviceModemCapabilities.GSM_UMTS)
            this._mobileDevice = new ModemManager.ModemGsm(device.udi);
        else if (capabilities & NM.DeviceModemCapabilities.CDMA_EVDO)
            this._mobileDevice = new ModemManager.ModemCdma(device.udi);
        else if (capabilities & NM.DeviceModemCapabilities.LTE)
            this._mobileDevice = new ModemManager.ModemGsm(device.udi);

        this._mobileDevice?.connectObject(
            'notify::operator-name', this._sync.bind(this),
            'notify::signal-quality', () => this.notify('icon-name'), this);

        Main.sessionMode.connectObject('updated',
            this._sessionUpdated.bind(this), this);
        this._sessionUpdated();
    }

    get icon_name() {
        switch (this.state) {
        case NM.ActiveConnectionState.ACTIVATING:
            return 'network-cellular-acquiring-symbolic';
        case NM.ActiveConnectionState.ACTIVATED: {
            const qualityString = signalToIcon(this._mobileDevice.signal_quality);
            return `network-cellular-signal-${qualityString}-symbolic`;
        }
        default:
            return this._activeConnection
                ? 'network-cellular-signal-none-symbolic'
                : 'network-cellular-disabled-symbolic';
        }
    }

    get name() {
        return this._mobileDevice?.operator_name || this._deviceName;
    }

    get wwanPanelSupported() {
        // Currently, wwan panel doesn't support CDMA_EVDO modems
        const supportedCaps =
            NM.DeviceModemCapabilities.GSM_UMTS |
            NM.DeviceModemCapabilities.LTE;
        return this._device.current_capabilities & supportedCaps;
    }

    _autoConnect() {
        if (this.wwanPanelSupported)
            launchSettingsPanel('wwan', 'show-device', this._device.udi);
        else
            launchSettingsPanel('network', 'connect-3g', this._device.get_path());
    }

    _sessionUpdated() {
        this._autoConnectItem.sensitive = Main.sessionMode.hasWindows;
    }
});

const NMBluetoothDeviceItem = GObject.registerClass(
class NMBluetoothDeviceItem extends NMDeviceItem {
    constructor(client, device) {
        super(client, device);

        this._device.bind_property('name',
            this, 'name',
            GObject.BindingFlags.SYNC_CREATE);
    }

    get icon_name() {
        switch (this.state) {
        case NM.ActiveConnectionState.ACTIVATING:
            return 'network-cellular-acquiring-symbolic';
        case NM.ActiveConnectionState.ACTIVATED:
            return 'network-cellular-connected-symbolic';
        default:
            return this._activeConnection
                ? 'network-cellular-signal-none-symbolic'
                : 'network-cellular-disabled-symbolic';
        }
    }

    get name() {
        return this._device.name;
    }
});

const WirelessNetwork = GObject.registerClass({
    Properties: {
        'name': GObject.ParamSpec.string(
            'name', '', '',
            GObject.ParamFlags.READABLE,
            ''),
        'icon-name': GObject.ParamSpec.string(
            'icon-name', '', '',
            GObject.ParamFlags.READABLE,
            ''),
        'secure': GObject.ParamSpec.boolean(
            'secure', '', '',
            GObject.ParamFlags.READABLE,
            false),
        'is-active': GObject.ParamSpec.boolean(
            'is-active', '', '',
            GObject.ParamFlags.READABLE,
            false),
    },
    Signals: {
        'destroy': {},
    },
}, class WirelessNetwork extends GObject.Object {
    static _securityTypes =
        Object.values(NM.UtilsSecurityType).sort((a, b) => b - a);

    _init(device) {
        super._init();

        this._device = device;

        this._device.connectObject(
            'notify::active-access-point', () => this.notify('is-active'),
            this);

        this._accessPoints = new Set();
        this._connections = [];
        this._name = '';
        this._ssid = null;
        this._bestAp = null;
        this._mode = 0;
        this._securityType = NM.UtilsSecurityType.NONE;
    }

    get _strength() {
        return this._bestAp?.strength ?? 0;
    }

    get name() {
        return this._name;
    }

    get icon_name() {
        if (this._mode === NM80211Mode.ADHOC)
            return 'network-workgroup-symbolic';

        if (!this._bestAp)
            return '';

        return `network-wireless-signal-${signalToIcon(this._bestAp.strength)}-symbolic`;
    }

    get secure() {
        return this._securityType !== NM.UtilsSecurityType.NONE;
    }

    get is_active() {
        return this._accessPoints.has(this._device.activeAccessPoint);
    }

    hasAccessPoint(ap) {
        return this._accessPoints.has(ap);
    }

    hasAccessPoints() {
        return this._accessPoints.size > 0;
    }

    checkAccessPoint(ap) {
        if (!ap.get_ssid())
            return false;

        const secType = this._getApSecurityType(ap);
        if (secType === NM.UtilsSecurityType.INVALID)
            return false;

        if (this._accessPoints.size === 0)
            return true;

        return this._ssid.equal(ap.ssid) &&
            this._mode === ap.mode &&
            this._securityType === secType;
    }

    /**
     * @param {NM.AccessPoint} ap - an access point
     * @returns {bool} - whether the access point was added
     */
    addAccessPoint(ap) {
        if (!this.checkAccessPoint(ap))
            return false;

        if (this._accessPoints.size === 0) {
            this._ssid = ap.get_ssid();
            this._mode = ap.mode;
            this._securityType = this._getApSecurityType(ap);
            this._name = NM.utils_ssid_to_utf8(this._ssid.get_data()) || '<unknown>';

            this.notify('name');
            this.notify('secure');
        }

        const wasActive = this.is_active;
        this._accessPoints.add(ap);

        ap.connectObject(
            'notify::strength', () => {
                this.notify('icon-name');
                this._updateBestAp();
            }, this);
        this._updateBestAp();

        if (wasActive !== this.is_active)
            this.notify('is-active');

        return true;
    }

    /**
     * @param {NM.AccessPoint} ap - an access point
     * @returns {bool} - whether the access point was removed
     */
    removeAccessPoint(ap) {
        const wasActive = this.is_active;
        if (!this._accessPoints.delete(ap))
            return false;

        this._updateBestAp();

        if (wasActive !== this.is_active)
            this.notify('is-active');

        return true;
    }

    /**
     * @param {WirelessNetwork} other - network to compare with
     * @returns {number} - the sort order
     */
    compare(other) {
        // place known connections first
        const cmpConnections = other.hasConnections() - this.hasConnections();
        if (cmpConnections !== 0)
            return cmpConnections;

        const cmpAps = other.hasAccessPoints() - this.hasAccessPoints();
        if (cmpAps !== 0)
            return cmpAps;

        // place stronger connections first
        const cmpStrength = other._strength - this._strength;
        if (cmpStrength !== 0)
            return cmpStrength;

        // place secure connections first
        const cmpSec = other.secure - this.secure;
        if (cmpSec !== 0)
            return cmpSec;

        // sort alphabetically
        return GLib.utf8_collate(this._name, other._name);
    }

    hasConnections() {
        return this._connections.length > 0;
    }

    checkConnections(connections) {
        const aps = [...this._accessPoints];
        this._connections = connections.filter(
            c => aps.some(ap => ap.connection_valid(c)));
    }

    canAutoconnect() {
        const canAutoconnect =
            this._securityTypes !== NM.UtilsSecurityType.WPA_ENTERPRISE &&
            this._securityTypes !== NM.UtilsSecurityType.WPA2_ENTERPRISE;
        return canAutoconnect;
    }

    activate() {
        const [ap] = this._accessPoints;
        let [conn] = this._connections;
        if (conn) {
            this._device.client.activate_connection_async(conn, this._device, null, null, null);
        } else if (!this.canAutoconnect()) {
            launchSettingsPanel('wifi', 'connect-8021x-wifi',
                this._getDeviceDBusPath(), ap.get_path());
        } else {
            conn = new NM.SimpleConnection();
            this._device.client.add_and_activate_connection_async(
                conn, this._device, ap.get_path(), null, null);
        }
    }

    destroy() {
        this.emit('destroy');
    }

    _getDeviceDBusPath() {
        // nm_object_get_path() is shadowed by nm_device_get_path()
        return NM.Object.prototype.get_path.call(this._device);
    }

    _getApSecurityType(ap) {
        const {wirelessCapabilities: caps} = this._device;
        const {flags, wpaFlags, rsnFlags} = ap;
        const haveAp = true;
        const adHoc = ap.mode === NM80211Mode.ADHOC;
        const bestType = WirelessNetwork._securityTypes
            .find(t => NM.utils_security_valid(t, caps, haveAp, adHoc, flags, wpaFlags, rsnFlags));
        return bestType ?? NM.UtilsSecurityType.INVALID;
    }

    _updateBestAp() {
        const [bestAp] =
            [...this._accessPoints].sort((a, b) => b.strength - a.strength);

        if (this._bestAp === bestAp)
            return;

        this._bestAp = bestAp;
        this.notify('icon-name');
    }
});
registerDestroyableType(WirelessNetwork);

const NMWirelessNetworkItem = GObject.registerClass(
class NMWirelessNetworkItem extends PopupMenu.PopupBaseMenuItem {
    _init(network) {
        super._init({style_class: 'nm-network-item'});

        this._network = network;

        const icons = new St.BoxLayout();
        this.add_child(icons);

        this._signalIcon = new St.Icon({style_class: 'popup-menu-icon'});
        icons.add_child(this._signalIcon);

        this._secureIcon = new St.Icon({
            style_class: 'wireless-secure-icon',
            y_align: Clutter.ActorAlign.END,
        });
        icons.add_actor(this._secureIcon);

        this._label = new St.Label();
        this.label_actor = this._label;
        this.add_child(this._label);

        this._selectedIcon = new St.Icon({
            style_class: 'popup-menu-icon',
            icon_name: 'object-select-symbolic',
        });
        this.add(this._selectedIcon);

        this._network.bind_property('icon-name',
            this._signalIcon, 'icon-name',
            GObject.BindingFlags.SYNC_CREATE);
        this._network.bind_property('name',
            this._label, 'text',
            GObject.BindingFlags.SYNC_CREATE);
        this._network.bind_property('is-active',
            this._selectedIcon, 'visible',
            GObject.BindingFlags.SYNC_CREATE);
        this._network.bind_property_full('secure',
            this._secureIcon, 'icon-name',
            GObject.BindingFlags.SYNC_CREATE,
            (bind, source) => [true, source ? 'network-wireless-encrypted-symbolic' : ''],
            null);
    }

    get network() {
        return this._network;
    }
});

const NMWirelessDeviceItem = GObject.registerClass({
    Properties: {
        'single-device-mode': GObject.ParamSpec.boolean('single-device-mode', '', '',
            GObject.ParamFlags.READWRITE,
            false),
    },
}, class NMWirelessDeviceItem extends NMSectionItem {
    constructor(client, device) {
        super();

        this._client = client;
        this._device = device;

        this._deviceName = '';

        this._networkItems = new Map();
        this._itemSorter = new ItemSorter({
            sortFunc: (one, two) => one.network.compare(two.network),
        });

        this._client.connectObject(
            'notify::wireless-enabled', () => this.notify('icon-name'),
            'notify::connectivity', () => this.notify('icon-name'),
            'notify::primary-connection', () => this.notify('icon-name'),
            this);

        this._device.connectObject(
            'notify::active-access-point', this._activeApChanged.bind(this),
            'notify::active-connection', () => this._activeConnectionChanged(),
            'notify::available-connections', () => this._availableConnectionsChanged(),
            'access-point-added', (d, ap) => {
                this._addAccessPoint(ap);
                this._updateItemsVisibility();
            },
            'access-point-removed', (d, ap) => {
                this._removeAccessPoint(ap);
                this._updateItemsVisibility();
            }, this);

        this.bind_property('single-device-mode',
            this, 'use-submenu',
            GObject.BindingFlags.INVERT_BOOLEAN);

        Main.sessionMode.connectObject('updated',
            () => this._updateItemsVisibility(),
            this);

        for (const ap of this._device.get_access_points())
            this._addAccessPoint(ap);

        this._activeApChanged();
        this._activeConnectionChanged();
        this._availableConnectionsChanged();
        this._updateItemsVisibility();
    }

    get icon_name() {
        if (!this._device.client.wireless_enabled)
            return 'network-wireless-disabled-symbolic';

        switch (this.state) {
        case NM.ActiveConnectionState.ACTIVATING:
            return 'network-wireless-acquiring-symbolic';

        case NM.ActiveConnectionState.ACTIVATED: {
            if (this._isHotSpotMaster())
                return 'network-wireless-hotspot-symbolic';

            if (!this._canReachInternet())
                return 'network-wireless-no-route-symbolic';

            if (!this._activeAccessPoint) {
                if (this._device.mode !== NM80211Mode.ADHOC)
                    console.info('An active wireless connection, in infrastructure mode, involves no access point?');

                return 'network-wireless-connected-symbolic';
            }

            const {strength} = this._activeAccessPoint;
            return `network-wireless-signal-${signalToIcon(strength)}-symbolic`;
        }
        default:
            return 'network-wireless-signal-none-symbolic';
        }
    }

    get name() {
        if (this._isHotSpotMaster())
            /* Translators: %s is a network identifier */
            return _('%s Hotspot').format(this._deviceName);

        const {ssid} = this._activeAccessPoint ?? {};
        if (ssid)
            return ssidToLabel(ssid);

        return this._deviceName;
    }

    _activeApChanged() {
        this._activeAccessPoint?.disconnectObject(this);
        this._activeAccessPoint = this._device.active_access_point;
        this._activeAccessPoint?.connectObject(
            'notify::strength', () => this.notify('icon-name'),
            'notify::ssid', () => this.notify('name'),
            this);

        this.notify('icon-name');
        this.notify('name');
    }

    _activeConnectionChanged() {
        this._setActiveConnection(this._device.active_connection);
    }

    _availableConnectionsChanged() {
        const connections = this._device.get_available_connections();
        for (const net of this._networkItems.keys())
            net.checkConnections(connections);
    }

    _addAccessPoint(ap) {
        if (ap.get_ssid() == null) {
            // This access point is not visible yet
            // Wait for it to get a ssid
            ap.connectObject('notify::ssid', () => {
                if (!ap.ssid)
                    return;
                ap.disconnectObject(this);
                this._addAccessPoint(ap);
            }, this);
            return;
        }

        let network = [...this._networkItems.keys()]
            .find(n => n.checkAccessPoint(ap));

        if (!network) {
            network = new WirelessNetwork(this._device);

            const item = new NMWirelessNetworkItem(network);
            item.connect('activate', () => network.activate());

            network.connectObject(
                'notify::icon-name', () => this._resortItem(item),
                'notify::is-active', () => this._resortItem(item),
                this);

            const pos = this._itemSorter.upsert(item);
            this.section.addMenuItem(item, pos);
            this._networkItems.set(network, item);
        }

        network.addAccessPoint(ap);
    }

    _removeAccessPoint(ap) {
        const network = [...this._networkItems.keys()]
            .find(n => n.removeAccessPoint(ap));

        if (!network || network.hasAccessPoints())
            return;

        const item = this._networkItems.get(network);
        this._itemSorter.delete(item);
        this._networkItems.delete(network);

        item?.destroy();
        network.destroy();
    }

    _resortItem(item) {
        const pos = this._itemSorter.upsert(item);
        this.section.moveMenuItem(item, pos);

        this._updateItemsVisibility();
    }

    _updateItemsVisibility() {
        const {hasWindows} = Main.sessionMode;

        let nVisible = 0;
        for (const item of this._itemSorter) {
            const {network: net} = item;
            item.visible =
                (hasWindows || net.hasConnections() || net.canAutoconnect()) &&
                nVisible++ < MAX_VISIBLE_NETWORKS;
        }
    }

    setDeviceName(name) {
        this._deviceName = name;
        this.notify('name');
    }

    _canReachInternet() {
        if (this._client.primary_connection !== this._device.active_connection)
            return true;

        return this._client.connectivity === NM.ConnectivityState.FULL;
    }

    _isHotSpotMaster() {
        if (!this._device.active_connection)
            return false;

        let connection = this._device.active_connection.connection;
        if (!connection)
            return false;

        let ip4config = connection.get_setting_ip4_config();
        if (!ip4config)
            return false;

        return ip4config.get_method() === NM.SETTING_IP4_CONFIG_METHOD_SHARED;
    }
});

const NMVpnConnectionItem = GObject.registerClass({
    Signals: {
        'activation-failed': {},
    },
}, class NMVpnConnectionItem extends NMConnectionItem {
    constructor(section, connection) {
        super(section, connection);

        this._label.x_expand = true;
        this.radioMode = true;

        this._switch = new PopupMenu.Switch(this.is_active);
        this.add_child(this._switch);

        this.bind_property('radio-mode',
            this._switch, 'visible',
            GObject.BindingFlags.SYNC_CREATE);
        this.bind_property('is-active',
            this._switch, 'state',
            GObject.BindingFlags.SYNC_CREATE);
    }

    _updateOrnament() {
        this.setOrnament(PopupMenu.Ornament.NONE);
    }

    _sync() {
        super._sync();

        if (this.radio_mode && this.is_active)
            this.add_accessible_state(Atk.StateType.CHECKED);
        else
            this.remove_accessible_state(Atk.StateType.CHECKED);
    }

    _activeConnectionStateChanged() {
        const state = this._activeConnection?.get_state();
        const reason = this._activeConnection?.get_state_reason();

        if (state === NM.ActiveConnectionState.DEACTIVATED &&
            reason !== NM.ActiveConnectionStateReason.NO_SECRETS &&
            reason !== NM.ActiveConnectionStateReason.USER_DISCONNECTED)
            this.emit('activation-failed');

        super._activeConnectionStateChanged();
    }

    get icon_name() {
        switch (this.state) {
        case NM.ActiveConnectionState.ACTIVATING:
            return 'network-vpn-acquiring-symbolic';
        case NM.ActiveConnectionState.ACTIVATED:
            return 'network-vpn-symbolic';
        default:
            return 'network-vpn-disabled-symbolic';
        }
    }

    set icon_name(_ignored) {
    }
});

class NMSection extends PopupMenu.PopupMenuSection {
    constructor() {
        super();

        this._items = new Map();
        this._itemSorter = new ItemSorter();

        this._itemsSection = new PopupMenu.PopupMenuSection();
        this.addMenuItem(this._itemsSection);

        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    setClient(client) {
        if (this._client === client)
            return;

        this._client?.disconnectObject(this);
        this._client = client;

        this._items.forEach(item => item.destroy());
        this._items.clear();

        if (this._client)
            this._loadInitialItems();
        this._sync();
    }

    set visible(visible) {
        this.actor.visible = visible;
    }

    _loadInitialItems() {
        throw new GObject.NotImplementedError();
    }

    _resortItem(item) {
        const pos = this._itemSorter.upsert(item);
        this._itemsSection.moveMenuItem(item, pos);
    }

    _addItem(key, item) {
        console.assert(!this._items.has(key),
            `${this} already has an item for ${key}`);

        item.connectObject(
            'notify::name', () => this._resortItem(item),
            'destroy', () => this._removeItem(key),
            this);

        this._items.set(key, item);
        const pos = this._itemSorter.upsert(item);
        this._itemsSection.addMenuItem(item, pos);
        this._sync();
    }

    _removeItem(key) {
        const item = this._items.get(key);
        if (!item)
            return;

        this._itemSorter.delete(item);
        this._items.delete(key);

        item.destroy();
        this._sync();
    }

    _sync() {
        this.visible = this._items.size > 0;
    }
}

class NMVpnSection extends NMSection {
    constructor() {
        super();

        this.addSettingsAction(_('VPN Settings'),
            'gnome-network-panel.desktop');
    }

    setClient(client) {
        super.setClient(client);

        this._client?.connectObject(
            'connection-added', (c, conn) => this._addConnection(conn),
            'connection-removed', (c, conn) => this._removeConnection(conn),
            'notify::active-connections', () => this._syncActiveConnections(),
            this);
    }

    _loadInitialItems() {
        const connections = this._client.get_connections();
        for (const conn of connections)
            this._addConnection(conn);

        this._syncActiveConnections();
    }

    _syncActiveConnections() {
        const activeConnections =
            this._client.get_active_connections().filter(
                c => this._shouldHandleConnection(c.connection));

        for (const item of this._items.values())
            item.setActiveConnection(null);

        for (const a of activeConnections)
            this._items.get(a.connection)?.setActiveConnection(a);
    }

    _shouldHandleConnection(connection) {
        const setting = connection.get_setting_connection();
        if (!setting)
            return false;

        // Ignore slave connection
        if (setting.get_master())
            return false;

        const handledTypes = [
            NM.SETTING_VPN_SETTING_NAME,
            NM.SETTING_WIREGUARD_SETTING_NAME,
        ];
        return handledTypes.includes(setting.type);
    }

    _onConnectionChanged(connection) {
        const item = this._items.get(connection);
        item.updateForConnection(connection);
    }

    _addConnection(connection) {
        if (this._items.has(connection))
            return;

        if (!this._shouldHandleConnection(connection))
            return;

        connection.connectObject(
            'changed', this._onConnectionChanged.bind(this),
            this);

        const item = new NMVpnConnectionItem(this, connection);
        item.connectObject(
            'activation-failed', () => this.emit('activation-failed'),
            this);
        this._addItem(connection, item);
    }

    _removeConnection(connection) {
        this._removeItem(connection);
    }

    activateConnection(connection) {
        this._client.activate_connection_async(connection, null, null, null, null);
    }

    deactivateConnection(activeConnection) {
        this._client.deactivate_connection(activeConnection, null);
    }

    getIndicatorIcon() {
        for (const item of this._items.values()) {
            if (item.is_active)
                return item.icon_name;
        }
        return '';
    }
}

class NMDeviceSection extends NMSection {
    constructor(deviceType) {
        super();

        this._deviceType = deviceType;
        this._nmDevices = new Set();

        this._summaryItem = new PopupMenu.PopupSubMenuMenuItem('', true);
        this._summaryItem.icon.icon_name = this._getSummaryIcon();
        this.addMenuItem(this._summaryItem);

        this._summaryItem.menu.addSettingsAction(_('Network Settings'),
                                                 'gnome-network-panel.desktop');
        this._summaryItem.hide();
    }

    setClient(client) {
        this._nmDevices.clear();

        super.setClient(client);

        this._client?.connectObject(
            'device-added', (c, dev) => {
                this._addDevice(dev);
                this._syncDeviceNames();
            },
            'device-removed', (c, dev) => {
                this._removeDevice(dev);
                this._syncDeviceNames();
            }, this);
    }

    _loadInitialItems() {
        const devices = this._client.get_devices();
        for (const  dev of devices)
            this._addDevice(dev);
        this._syncDeviceNames();
    }

    _shouldShowDevice(device) {
        switch (device.state) {
        case NM.DeviceState.DISCONNECTED:
        case NM.DeviceState.ACTIVATED:
        case NM.DeviceState.DEACTIVATING:
        case NM.DeviceState.PREPARE:
        case NM.DeviceState.CONFIG:
        case NM.DeviceState.IP_CONFIG:
        case NM.DeviceState.IP_CHECK:
        case NM.DeviceState.SECONDARIES:
        case NM.DeviceState.NEED_AUTH:
        case NM.DeviceState.FAILED:
            return true;
        case NM.DeviceState.UNMANAGED:
        case NM.DeviceState.UNAVAILABLE:
        default:
            return false;
        }
    }

    _syncDeviceNames() {
        const devices = [...this._nmDevices];
        const names = NM.Device.disambiguate_names(devices);
        devices.forEach(
            (dev, i) => this._items.get(dev)?.setDeviceName(names[i]));
    }

    _syncDeviceItem(device) {
        if (this._shouldShowDevice(device))
            this._ensureDeviceItem(device);
        else
            this._removeDeviceItem(device);
    }

    _deviceStateChanged(device, newState, oldState, reason) {
        if (newState === oldState) {
            console.info(`${device} emitted state-changed without actually changing state`);
            return;
        }

        /* Emit a notification if activation fails, but don't do it
           if the reason is no secrets, as that indicates the user
           cancelled the agent dialog */
        if (newState === NM.DeviceState.FAILED &&
            reason !== NM.DeviceStateReason.NO_SECRETS)
            this.emit('activation-failed');
    }

    _createDeviceMenuItem(_device) {
        throw new GObject.NotImplementedError();
    }

    _ensureDeviceItem(device) {
        if (this._items.has(device))
            return;

        const item = this._createDeviceMenuItem(device);
        this._addItem(device, item);
    }

    _removeDeviceItem(device) {
        this._removeItem(device);
    }

    _addDevice(device) {
        if (this._nmDevices.has(device))
            return;

        if (device.get_device_type() !== this._deviceType)
            return;

        device.connectObject(
            'state-changed', this._deviceStateChanged.bind(this),
            'notify::interface', () => this._syncDeviceNames(),
            'notify::state', () => this._syncDeviceItem(device),
            this);

        this._nmDevices.add(device);
        this._syncDeviceItem(device);
    }

    _removeDevice(device) {
        if (!this._nmDevices.delete(device))
            return;

        device.disconnectObject(this);
        this._removeDeviceItem(device);
    }

    _sync() {
        super._sync();

        const nItems = this._items.size;
        this._items.forEach(item => (item.singleDeviceMode = nItems === 1));

        let nDevices = this._itemsSection.box.get_children().reduce(
            (prev, child) => prev + (child.visible ? 1 : 0), 0);
        this._summaryItem.label.text = this._getSummaryLabel(nDevices);
        let shouldSummarize = nDevices > MAX_DEVICE_ITEMS;
        this._summaryItem.visible = shouldSummarize;
        this._itemsSection.actor.visible = !shouldSummarize;
    }

    _getSummaryIcon() {
        throw new GObject.NotImplementedError();
    }

    _getSummaryLabel() {
        throw new GObject.NotImplementedError();
    }
}

class NMWirelessSection extends NMDeviceSection {
    constructor() {
        super(NM.DeviceType.WIFI);

        this.addSettingsAction(_('All Networks'),
            'gnome-wifi-panel.desktop');
    }

    _createDeviceMenuItem(device) {
        return new NMWirelessDeviceItem(this._client, device);
    }

    _getSummaryIcon() {
        return 'network-wireless-symbolic';
    }

    _getSummaryLabel(nDevices) {
        return ngettext(
            '%s Wi-Fi Connection',
            '%s Wi-Fi Connections',
            nDevices).format(nDevices);
    }
}

class NMWiredSection extends NMDeviceSection {
    constructor() {
        super(NM.DeviceType.ETHERNET);

        this.addSettingsAction(_('Wired Settings'),
            'gnome-network-panel.desktop');
    }

    _createDeviceMenuItem(device) {
        return new NMWiredDeviceItem(this._client, device);
    }

    _getSummaryIcon() {
        return 'network-wired-symbolic';
    }

    _getSummaryLabel(nDevices) {
        return ngettext(
            '%s Wired Connection',
            '%s Wired Connections',
            nDevices).format(nDevices);
    }
}

class NMBluetoothSection extends NMDeviceSection {
    constructor() {
        super(NM.DeviceType.BT);

        this.addSettingsAction(_('Bluetooth Settings'),
            'gnome-network-panel.desktop');
    }

    _createDeviceMenuItem(device) {
        return new NMBluetoothDeviceItem(this._client, device);
    }

    _getSummaryIcon() {
        return 'network-wireless-symbolic';
    }

    _getSummaryLabel(nDevices) {
        return ngettext(
            '%s Bluetooth Connection',
            '%s Bluetooth Connections',
            nDevices).format(nDevices);
    }
}

class NMModemSection extends NMDeviceSection {
    constructor() {
        super(NM.DeviceType.MODEM);

        const settingsLabel = _('Mobile Broadband Settings');
        this._wwanSettings = this.addSettingsAction(settingsLabel,
            'gnome-wwan-panel.desktop');
        this._legacySettings = this.addSettingsAction(settingsLabel,
            'gnome-network-panel.desktop');
    }

    _createDeviceMenuItem(device) {
        return new NMModemDeviceItem(this._client, device);
    }

    _getSummaryIcon() {
        return 'network-wireless-symbolic';
    }

    _getSummaryLabel(nDevices) {
        return ngettext(
            '%s Modem Connection',
            '%s Modem Connections',
            nDevices).format(nDevices);
    }

    _sync() {
        super._sync();

        const useWwanPanel =
            [...this._items.values()].some(i => i.wwanPanelSupported);
        this._wwanSettings.visible = useWwanPanel;
        this._legacySettings.visible = !useWwanPanel;
    }
}

var NMApplet = GObject.registerClass(
class Indicator extends PanelMenu.SystemIndicator {
    _init() {
        super._init();

        this._primaryIndicator = this._addIndicator();
        this._vpnIndicator = this._addIndicator();

        this._connectivityQueue = new Set();

        this._mainConnection = null;

        this._notification = null;

        this._allSections = [];

        this._wiredSection = new NMWiredSection();
        this._wirelessSection = new NMWirelessSection();
        this._modemSection = new NMModemSection();
        this._btSection = new NMBluetoothSection();
        this._vpnSection = new NMVpnSection();

        this._deviceSections = new Map([
            [NM.DeviceType.ETHERNET, this._wiredSection],
            [NM.DeviceType.WIFI, this._wirelessSection],
            [NM.DeviceType.MODEM, this._modemSection],
            [NM.DeviceType.BT, this._btSection],
        ]);
        this._allSections.push(...this._deviceSections.values());
        this._allSections.push(this._vpnSection);

        this._allSections.forEach(section => {
            section.connectObject(
                'activation-failed', () => this._onActivationFailed(),
                'icon-changed', () => this._updateIcon(),
                this);
            this.menu.addMenuItem(section);
        });

        this._getClient().catch(logError);
    }

    async _getClient() {
        this._client = await NM.Client.new_async(null);

        this._allSections.forEach(
            section => section.setClient(this._client));

        this._client.bind_property('nm-running',
            this, 'visible',
            GObject.BindingFlags.SYNC_CREATE);
        this._client.bind_property('networking-enabled',
            this.menu.actor, 'visible',
            GObject.BindingFlags.SYNC_CREATE);

        this._client.connectObject(
            'notify::state', () => this._updateIcon(),
            'notify::primary-connection', () => this._syncMainConnection(),
            'notify::activating-connection', () => this._syncMainConnection(),
            'notify::connectivity', () => this._syncConnectivity(),
            this);
        this._syncMainConnection();

        try {
            this._configPermission = await Polkit.Permission.new(
                'org.freedesktop.NetworkManager.network-control', null, null);
        } catch (e) {
            log(`No permission to control network connections: ${e}`);
            this._configPermission = null;
        }

        Main.sessionMode.connect('updated', this._sessionUpdated.bind(this));
        this._sessionUpdated();
    }

    _sessionUpdated() {
        const sensitive =
            !Main.sessionMode.isLocked &&
            this._configPermission && this._configPermission.allowed;
        this.menu.setSensitive(sensitive);
    }

    _onActivationFailed() {
        this._notification?.destroy();

        const source = new MessageTray.Source(
            _('Network Manager'), 'network-error-symbolic');
        source.policy =
            new MessageTray.NotificationApplicationPolicy('gnome-network-panel');

        this._notification = new MessageTray.Notification(source,
            _('Connection failed'),
            _('Activation of network connection failed'));
        this._notification.setUrgency(MessageTray.Urgency.HIGH);
        this._notification.setTransient(true);
        this._notification.connect('destroy',
            () => (this._notification = null));

        Main.messageTray.add(source);
        source.showNotification(this._notification);
    }

    _getMainConnection() {
        let connection;

        connection = this._client.get_primary_connection();
        if (connection) {
            ensureActiveConnectionProps(connection);
            return connection;
        }

        connection = this._client.get_activating_connection();
        if (connection) {
            ensureActiveConnectionProps(connection);
            return connection;
        }

        return null;
    }

    _syncMainConnection() {
        this._mainConnection?._primaryDevice?.disconnectObject(this);
        this._mainConnection?.disconnectObject(this);

        this._mainConnection = this._getMainConnection();

        if (this._mainConnection) {
            this._mainConnection._primaryDevice?.connectObject('notify::icon-name',
                this._updateIcon.bind(this), this);
            this._mainConnection.connectObject('notify::state',
                this._mainConnectionStateChanged.bind(this), this);
            this._mainConnectionStateChanged();
        }

        this._updateIcon();
        this._syncConnectivity();
    }

    _mainConnectionStateChanged() {
        if (this._mainConnection.state === NM.ActiveConnectionState.ACTIVATED)
            this._notification?.destroy();
    }

    _flushConnectivityQueue() {
        for (let item of this._connectivityQueue)
            this._portalHelperProxy?.CloseAsync(item);
        this._connectivityQueue.clear();
    }

    _closeConnectivityCheck(path) {
        if (this._connectivityQueue.delete(path))
            this._portalHelperProxy?.CloseAsync(path);
    }

    async _portalHelperDone(proxy, emitter, parameters) {
        let [path, result] = parameters;

        if (result == PortalHelperResult.CANCELLED) {
            // Keep the connection in the queue, so the user is not
            // spammed with more logins until we next flush the queue,
            // which will happen once they choose a better connection
            // or we get to full connectivity through other means
        } else if (result == PortalHelperResult.COMPLETED) {
            this._closeConnectivityCheck(path);
        } else if (result == PortalHelperResult.RECHECK) {
            try {
                const state = await this._client.check_connectivity_async(null);
                if (state >= NM.ConnectivityState.FULL)
                    this._closeConnectivityCheck(path);
            } catch (e) { }
        } else {
            log(`Invalid result from portal helper: ${result}`);
        }
    }

    async _syncConnectivity() {
        if (this._mainConnection == null ||
            this._mainConnection.state != NM.ActiveConnectionState.ACTIVATED) {
            this._flushConnectivityQueue();
            return;
        }

        let isPortal = this._client.connectivity == NM.ConnectivityState.PORTAL;
        // For testing, allow interpreting any value != FULL as PORTAL, because
        // LIMITED (no upstream route after the default gateway) is easy to obtain
        // with a tethered phone
        // NONE is also possible, with a connection configured to force no default route
        // (but in general we should only prompt a portal if we know there is a portal)
        if (GLib.getenv('GNOME_SHELL_CONNECTIVITY_TEST') != null)
            isPortal ||= this._client.connectivity < NM.ConnectivityState.FULL;
        if (!isPortal || Main.sessionMode.isGreeter)
            return;

        let path = this._mainConnection.get_path();
        if (this._connectivityQueue.has(path))
            return;

        let timestamp = global.get_current_time();
        if (!this._portalHelperProxy) {
            this._portalHelperProxy = new Gio.DBusProxy({
                g_connection: Gio.DBus.session,
                g_name: 'org.gnome.Shell.PortalHelper',
                g_object_path: '/org/gnome/Shell/PortalHelper',
                g_interface_name: PortalHelperInfo.name,
                g_interface_info: PortalHelperInfo,
            });
            this._portalHelperProxy.connectSignal('Done',
                () => this._portalHelperDone().catch(logError));

            try {
                await this._portalHelperProxy.init_async(
                    GLib.PRIORITY_DEFAULT, null);
            } catch (e) {
                console.error(`Error launching the portal helper: ${e.message}`);
            }
        }

        this._portalHelperProxy?.AuthenticateAsync(path, '', timestamp).catch(logError);

        this._connectivityQueue.add(path);
    }

    _updateIcon() {
        if (!this._client.networking_enabled) {
            this._primaryIndicator.visible = false;
        } else {
            let dev = null;
            if (this._mainConnection)
                dev = this._mainConnection._primaryDevice;

            let state = this._client.get_state();
            let connected = state == NM.State.CONNECTED_GLOBAL;
            this._primaryIndicator.visible = (dev != null) || connected;
            if (dev) {
                this._primaryIndicator.icon_name = dev.icon_name;
            } else if (connected) {
                if (this._client.connectivity == NM.ConnectivityState.FULL)
                    this._primaryIndicator.icon_name = 'network-wired-symbolic';
                else
                    this._primaryIndicator.icon_name = 'network-wired-no-route-symbolic';
            }
        }

        this._vpnIndicator.icon_name = this._vpnSection.getIndicatorIcon();
        this._vpnIndicator.visible = this._vpnIndicator.icon_name !== null;
    }
});
