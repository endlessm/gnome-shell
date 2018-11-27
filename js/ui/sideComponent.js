// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const { Gio, GLib, GObject, Meta } = imports.gi;

const Main = imports.ui.main;
const ViewSelector = imports.ui.viewSelector;

const SIDE_COMPONENT_ROLE = 'eos-side-component';

/**
 * isSideComponentWindow:
 * @metaWindow: an instance of #Meta.Window
 * @return: whether the #Meta.Window belongs to a #SideComponent 
 */
function isSideComponentWindow (metaWindow) {
    return metaWindow && (metaWindow.get_role() == SIDE_COMPONENT_ROLE);
};

/**
 * shouldHideOtherWindows:
 * @metaWindow: an instance of #Meta.Window
 * @return: whether other windows should be hidden while this one is open
 */
function shouldHideOtherWindows (metaWindow) {
    return isSideComponentWindow(metaWindow) &&
        Main.discoveryFeed.launchedFromDesktop;
};

/**
 * launchedFromDesktop:
 * @metaWindow: an instance of #Meta.Window
 * @return: whether the side component was launched from the desktop
 */
function launchedFromDesktop (metaWindow) {
    return isSideComponentWindow(metaWindow) &&
        ((metaWindow.get_wm_class == 'Eos-app-store' && Main.appStore.launchedFromDesktop) ||
         (isDiscoveryFeedWindow(metaWindow) && Main.discoveryFeed.launchedFromDesktop));
};

/**
 * isDiscoveryFeedWindow:
 * @metaWindow: an instance of #Meta.Window
 * @return: whether the #Meta.Window is from the DiscoveryFeed application
 */
function isDiscoveryFeedWindow (metaWindow) {
    return metaWindow && (metaWindow.get_wm_class() == 'Com.endlessm.DiscoveryFeed');
};

var SideComponent = GObject.registerClass(
class SideComponent extends GObject.Object {
    _init(proxyIface, proxyName, proxyPath) {
        super._init();
        this._propertiesChangedId = 0;
        this._desktopShownId = 0;

        this._proxyIface = proxyIface;
        this._proxyInfo = Gio.DBusInterfaceInfo.new_for_xml(this._proxyIface);
        this._proxyName = proxyName;
        this._proxyPath = proxyPath;

        this._visible = false;
        this._launchedFromDesktop = false;

        this.proxyConstructFlags = Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION;
    }

    enable() {
        if (!this.proxy) {
            this.proxy = new Gio.DBusProxy({ g_connection: Gio.DBus.session,
                                             g_interface_name: this._proxyInfo.name,
                                             g_interface_info: this._proxyInfo,
                                             g_name: this._proxyName,
                                             g_object_path: this._proxyPath,
                                             g_flags: this.proxyConstructFlags });
            this.proxy.init_async(GLib.PRIORITY_DEFAULT, null, this._onProxyConstructed.bind(this));
        }

        this._propertiesChangedId =
            this.proxy.connect('g-properties-changed', this._onPropertiesChanged.bind(this));

        // Same when clicking the background from the window picker.
        this._overviewPageChangedId = Main.overview.connect('page-changed', () => {
            if (this._visible && Main.overview.visible &&
                Main.overview.getActivePage() == ViewSelector.ViewPage.APPS)
                this.hide(global.get_current_time());
        });
    }

    disable() {
        if (this._propertiesChangedId > 0) {
            this.proxy.disconnect(this._propertiesChangedId);
            this._propertiesChangedId = 0;
        }

        if (this._desktopShownId > 0) {
            Main.layoutManager.disconnect(this._desktopShownId);
            this._desktopShownId = 0;
        }

        if (this._overviewPageChangedId > 0) {
            Main.overview.disconnect(this._overviewPageChangedId);
            this._overviewPageChangedId = 0;
        }
    }

    _onProxyConstructed(object, res) {
        try {
            object.init_finish(res);
        } catch (e) {
            logError(e, 'Error while constructing the DBus proxy for ' + this._proxyName);
        }
    }

    _onPropertiesChanged(proxy, changedProps, invalidatedProps) {
        let propsDict = changedProps.deep_unpack();
        if (propsDict.hasOwnProperty('Visible'))
            this._onVisibilityChanged();
    }

    _onVisibilityChanged() {
        if (this._visible == this.proxy.Visible)
            return;

        // resync visibility
        this._visible = this.proxy.Visible;
    }

    toggle(timestamp, params) {
        if (this._visible)
            this.hide(timestamp, params);
        else
            this.show(timestamp, params);
    }

    show(timestamp, params) {
        this._launchedFromDesktop = Main.overview.visible &&
                                    Main.overview.getActivePage() == ViewSelector.ViewPage.APPS;

        if (this._visible && Main.overview.visible)
            // the component is already open, but obscured by the overview
            Main.overview.hide();
        else
            this.callShow(timestamp, params);
    }

    hide(timestamp, params) {
        this.callHide(timestamp, params);
    }

    get launchedFromDesktop() {
        return this._launchedFromDesktop;
    }
});
