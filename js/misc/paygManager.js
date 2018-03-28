// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
//
// Copyright (C) 2018 Endless Mobile, Inc.
//
// This is a GNOME Shell component to wrap the interactions over
// D-Bus with the eos-payg system daemon.
//
// Licensed under the GNU General Public License Version 2
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program; if not, write to the Free Software
// Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const Main = imports.ui.main;
const Lang = imports.lang;
const Signals = imports.signals;

const EOS_PAYG_NAME = 'com.endlessm.Payg1';
const EOS_PAYG_PATH = '/com/endlessm/Payg1';

const EOS_PAYG_IFACE = '<node> \
<interface name="com.endlessm.Payg1"> \
<method name="AddCode"> \
  <arg type="s" direction="in" name="code"/> \
</method> \
<method name="ClearCode" /> \
<signal name="Expired" /> \
<property name="ExpiryTime" type="t" access="read"/> \
<property name="Enabled" type="b" access="read"/> \
</interface> \
</node>';

var PaygManager = new Lang.Class({
    Name: 'PaygManager',

    _init: function() {
        this._proxy = null;
        this._proxyInfo = Gio.DBusInterfaceInfo.new_for_xml(EOS_PAYG_IFACE);

        this._enabled = false;
        this._expiryTime = 0;

        this._codeExpiredId = 0;
        this._propertiesChangedId = 0;

        this._proxy = new Gio.DBusProxy({ g_connection: Gio.DBus.system,
                                          g_interface_name: this._proxyInfo.name,
                                          g_interface_info: this._proxyInfo,
                                          g_name: EOS_PAYG_NAME,
                                          g_object_path: EOS_PAYG_PATH,
                                          g_flags: Gio.DBusProxyFlags.NONE })

        this._proxy.init_async(GLib.PRIORITY_DEFAULT, null, this._onProxyConstructed.bind(this));
    },

    _onProxyConstructed: function(object, res) {
        try {
            object.init_finish (res);
        } catch (e) {
            logError(e, "Error while constructing D-Bus proxy for " + EOS_PAYG_NAME);
            return;
        }

        this._setEnabled(this._proxy.Enabled);
        this._setExpiryTime(this._proxy.ExpiryTime);

        this._propertiesChangedId = this._proxy.connect('g-properties-changed', this._onPropertiesChanged.bind(this));
        this._codeExpiredId = this._proxy.connectSignal('Expired', this._onCodeExpired.bind(this));
    },

    _onPropertiesChanged: function(proxy, changedProps, invalidatedProps) {
        let propsDict = changedProps.deep_unpack();
        if (propsDict.hasOwnProperty('Enabled'))
            this._setEnabled(this._proxy.Enabled);

        if (propsDict.hasOwnProperty('ExpiryTime'))
            this._setExpiryTime(this._proxy.ExpiryTime);
    },

    _setEnabled: function(value) {
        if (this._enabled === value)
            return;

        this._enabled = value;
        this.emit('enabled-changed', this._enabled);
    },

    _setExpiryTime: function(value) {
        if (this._expiryTime === value)
            return;

        this._expiryTime = value;
        this.emit('expiry-time-changed', this._expiryTime);
    },

    _onCodeExpired: function(proxy) {
        this.emit('code-expired');
    },

    addCode: function(code) {
        this._proxy.AddCodeRemote(code);
    },

    clearCode: function() {
        this._proxy.ClearCodeRemote();
    },

    get enabled() {
        return this._enabled;
    },

    get expiryTime() {
        return this._expiryTime;
    },
});
Signals.addSignalMethods(PaygManager.prototype);
