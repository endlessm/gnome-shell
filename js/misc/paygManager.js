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

const { Gio, GLib, GObject } = imports.gi;

const { loadInterfaceXML } = imports.misc.fileUtils;

const Main = imports.ui.main;
const Signals = imports.signals;

const EOS_PAYG_NAME = 'com.endlessm.Payg1';
const EOS_PAYG_PATH = '/com/endlessm/Payg1';

const EOS_PAYG_IFACE = loadInterfaceXML('com.endlessm.Payg1');

var PaygErrorDomain = GLib.quark_from_string('payg-error');

var PaygError = {
    INVALID_CODE: 0,
    CODE_ALREADY_USED: 1,
    TOO_MANY_ATTEMPTS: 2,
    DISABLED: 3,
};

const DBusErrorsMapping = {
    INVALID_CODE: 'com.endlessm.Payg1.Error.InvalidCode',
    CODE_ALREADY_USED: 'com.endlessm.Payg1.Error.CodeAlreadyUsed',
    TOO_MANY_ATTEMPTS: 'com.endlessm.Payg1.Error.TooManyAttempts',
    DISABLED: 'com.endlessm.Payg1.Error.Disabled',
};

var PaygManager = GObject.registerClass({
    Signals: {
        'code-expired': {},
        'code-format-changed': {},
        'enabled-changed': { param_types: [GObject.TYPE_BOOLEAN] },
        'expiry-time-changed': { param_types: [GObject.TYPE_INT64] },
    },
}, class PaygManager extends GObject.Object {

    _init() {
        super._init();

        this._proxy = null;
        this._proxyInfo = Gio.DBusInterfaceInfo.new_for_xml(EOS_PAYG_IFACE);

        this._enabled = false;
        this._expiryTime = 0;
        this._rateLimitEndTime = 0;
        this._codeFormat = '';
        this._codeFormatRegex = null;

        this._codeExpiredId = 0;
        this._propertiesChangedId = 0;

        this._proxy = new Gio.DBusProxy({
            g_connection: Gio.DBus.system,
            g_interface_name: this._proxyInfo.name,
            g_interface_info: this._proxyInfo,
            g_name: EOS_PAYG_NAME,
            g_object_path: EOS_PAYG_PATH,
            g_flags: Gio.DBusProxyFlags.NONE,
        });

        this._proxy.init_async(GLib.PRIORITY_DEFAULT, null, this._onProxyConstructed.bind(this));

        for (let errorCode in DBusErrorsMapping)
            Gio.DBusError.register_error(PaygErrorDomain, PaygError[errorCode], DBusErrorsMapping[errorCode]);
    }

    _onProxyConstructed(object, res) {
        try {
            object.init_finish (res);
        } catch (e) {
            logError(e, 'Error while constructing D-Bus proxy for %s'.format(EOS_PAYG_NAME));
            return;
        }

        this._setEnabled(this._proxy.Enabled);
        this._setExpiryTime(this._proxy.ExpiryTime);
        this._setRateLimitEndTime(this._proxy.RateLimitEndTime);
        this._setCodeFormat(this._proxy.CodeFormat || "^[0-9]{8}$");

        this._propertiesChangedId = this._proxy.connect('g-properties-changed', this._onPropertiesChanged.bind(this));
        this._codeExpiredId = this._proxy.connectSignal('Expired', this._onCodeExpired.bind(this));
    }

    _onPropertiesChanged(proxy, changedProps, invalidatedProps) {
        let propsDict = changedProps.deep_unpack();
        if (propsDict.hasOwnProperty('Enabled'))
            this._setEnabled(this._proxy.Enabled);

        if (propsDict.hasOwnProperty('ExpiryTime'))
            this._setExpiryTime(this._proxy.ExpiryTime);

        if (propsDict.hasOwnProperty('RateLimitEndTime'))
            this._setRateLimitEndTime(this._proxy.RateLimitEndTime);

        if (propsDict.hasOwnProperty('CodeFormat'))
            this._setCodeFormat(this._proxy.CodeFormat, true);
    }

    _setEnabled(value) {
        if (this._enabled === value)
            return;

        this._enabled = value;
        this.emit('enabled-changed', this._enabled);
    }

    _setExpiryTime(value) {
        if (this._expiryTime === value)
            return;

        this._expiryTime = value;
        this.emit('expiry-time-changed', this._expiryTime);
    }

    _setRateLimitEndTime(value) {
        if (this._rateLimitEndTime === value)
            return;

        this._rateLimitEndTime = value;
        this.emit('rate-limit-end-time-changed', this._rateLimitEndTime);
    }

    _setCodeFormat(value, notify=false) {
        if (this._codeFormat === value)
            return;

        this._codeFormat = value;
        try {
            this._codeFormatRegex = new GLib.Regex(this._codeFormat,
                                                   GLib.RegexCompileFlags.DOLLAR_ENDONLY,
                                                   GLib.RegexMatchFlags.PARTIAL);
        } catch (e) {
            logError(e, 'Error compiling CodeFormat regex: %s'.format(this._codeFormat));
            this._codeFormatRegex = null;
        }

        if (notify)
            this.emit('code-format-changed');
    }
    _onCodeExpired(proxy) {
        this.emit('code-expired');
    }

    addCode(code, callback) {
        this._proxy.AddCodeRemote(code, (result, error) => {
            if (callback)
                callback(error);
        });
    }

    clearCode() {
        this._proxy.ClearCodeRemote();
    }

    validateCode(code, partial=false) {
        if (!this._codeFormatRegex) {
            log("Unable to validate PAYG code: no regex")
            return false;
        }

        let [is_match, match_info] = this._codeFormatRegex.match(code, 0);
        return is_match || (partial && match_info.is_partial_match());
    }

    get enabled() {
        return this._enabled;
    }

    get expiryTime() {
        return this._expiryTime;
    }

    get rateLimitEndTime() {
        return this._rateLimitEndTime;
    }

    get isLocked() {
        if (!this.enabled)
            return false;

        return this._expiryTime <= (GLib.get_real_time() / GLib.USEC_PER_SEC);
    }
});
