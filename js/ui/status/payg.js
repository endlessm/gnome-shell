// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
//
// Copyright (C) 2018-2020 Endless OS Foundation LLC
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

/* exported Indicator */

const { Atk, Clutter, Gio, GLib, GObject, Pango, St } = imports.gi;

const Main = imports.ui.main;
const Payg = imports.ui.payg;

const {SystemIndicator, QuickSettingsItem, QuickToggle} = imports.ui.quickSettings;

const REFRESH_TIME_SECS = 60;

function _getNormalGIcon() {
    let iconUri = 'resource:///org/gnome/shell/theme/payg-normal-symbolic.svg';
    return new Gio.FileIcon({ file: Gio.File.new_for_uri(iconUri) });
}

function _getNearExpirationGIcon() {
    let iconUri = 'resource:///org/gnome/shell/theme/payg-near-expiration-symbolic.svg';
    return new Gio.FileIcon({ file: Gio.File.new_for_uri(iconUri) });
}

/**
 * An alternative QuickToggle with a "subtitle" property. This can be removed
 * in GNOME Shell 44+, where QuickToggle has the same functionality.
 */
const QuickToggleWithSubtitle = GObject.registerClass({
    Properties: {
        'title': GObject.ParamSpec.string('title', '', '',
            GObject.ParamFlags.READWRITE,
            null),
        'subtitle': GObject.ParamSpec.string('subtitle', '', '',
            GObject.ParamFlags.READWRITE,
            null),
        'icon-name': GObject.ParamSpec.override('icon-name', St.Button),
        'gicon': GObject.ParamSpec.object('gicon', '', '',
            GObject.ParamFlags.READWRITE,
            Gio.Icon),
    },
}, class QuickToggleWithSubtitle extends QuickSettingsItem {
    _init(params) {
        // We'll add the quick-toggle and button class here, as in QuickToggle,
        // because this widget has a similar structure. In GNOME Shell 45+, it
        // should be possible to subclass QuickToggle directly and use its
        // existing subtitle property.

        super._init({
            style_class: 'quick-toggle quick-toggle-with-subtitle button',
            accessible_role: Atk.Role.TOGGLE_BUTTON,
            can_focus: true,
            ...params
        });

        this._box = new St.BoxLayout();
        this.set_child(this._box);

        const iconProps = {};
        if (this.gicon)
            iconProps['gicon'] = this.gicon;
        if (this.iconName)
            iconProps['icon-name'] = this.iconName;

        this._icon = new St.Icon({
            style_class: 'quick-toggle-icon',
            x_expand: false,
            ...iconProps,
        });
        this._box.add_child(this._icon);

        // bindings are in the "wrong" direction, so we
        // pick up StIcon's linking of the two properties
        this._icon.bind_property('icon-name',
            this, 'icon-name',
            GObject.BindingFlags.SYNC_CREATE |
            GObject.BindingFlags.BIDIRECTIONAL);
        this._icon.bind_property('gicon',
            this, 'gicon',
            GObject.BindingFlags.SYNC_CREATE |
            GObject.BindingFlags.BIDIRECTIONAL);

        this._title = new St.Label({
            style_class: 'quick-toggle-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
        });

        this._subtitle = new St.Label({
            style_class: 'quick-toggle-subtitle',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
        });

        const titleBox = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            vertical: true,
        });
        titleBox.add_child(this._title);
        titleBox.add_child(this._subtitle);
        this._box.add_child(titleBox);

        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        this.bind_property('title',
            this._title, 'text',
            GObject.BindingFlags.SYNC_CREATE);

        this.bind_property('subtitle',
            this._subtitle, 'text',
            GObject.BindingFlags.SYNC_CREATE);
        this.bind_property_full('subtitle',
            this._subtitle, 'visible',
            GObject.BindingFlags.SYNC_CREATE,
            (bind, source) => [true, source !== null],
            null);
    }
});

const PaygAccountInfo = GObject.registerClass({
    Properties: {
        'account-id': GObject.ParamSpec.string('account-id', '', '',
            GObject.ParamFlags.READWRITE,
            null),
        'can-unlock': GObject.ParamSpec.boolean('can-unlock', '', '',
            GObject.ParamFlags.READWRITE,
            Gio.Icon),
        'enabled': GObject.ParamSpec.boolean('enabled', '', '',
            GObject.ParamFlags.READWRITE,
            Gio.Icon),
        'status-gicon': GObject.ParamSpec.object('status-gicon', '', '',
            GObject.ParamFlags.READWRITE,
            Gio.Icon),
        'time-remaining': GObject.ParamSpec.string('time-remaining', '', '',
            GObject.ParamFlags.READWRITE,
            null),
    }
}, class PaygAccountInfo extends GObject.Object {
    _init() {
        super._init();

        this._paygManager = Main.paygManager;

        this._paygManagerInitializedId = 0;
        if (!this._paygManager.initialized) {
            this._paygManagerInitializedId = this._paygManager.connect('initialized', () => {
                this._sync();
                this._paygManager.disconnect(this._paygManagerInitializedId);
                this._paygManagerInitializedId = 0;
            });
        }

        // update immediately when the user extends their time (so they don't
        // have to wait for the up to REFRESH_TIME_SECS seconds which would
        // likely be long enough that they might worry something went wrong)
        this._expiryTimeChangedId = this._paygManager.connect('expiry-time-changed', () => {
            this._sync();
        });

        // refresh the displayed icon and "time remaining" label periodically
        this._timeoutRefreshId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            REFRESH_TIME_SECS,
            () => this._timeoutRefresh());
        GLib.Source.set_name_by_id(this._timeoutRefreshId, '[gnome-shell] this._timeoutRefresh');

        this._sessionModeUpdatedId = Main.sessionMode.connect('updated',
            this._sync.bind(this));

        this._sync();
    }

    destroy() {
        if (this._paygManagerInitializedId > 0) {
            this._paygManager.disconnect(this._paygManagerInitializedId);
            this._paygManagerInitializedId = 0;
        }

        if (this._expiryTimeChangedId > 0) {
            this._paygManager.disconnect(this._expiryTimeChangedId);
            this._expiryTimeChangedId = 0;
        }

        if (this._timeoutRefreshId > 0) {
            GLib.source_remove(this._timeoutRefreshId);
            this._timeoutRefreshId = 0;
        }

        if (this._sessionModeUpdatedId > 0) {
            Main.sessionMode.disconnect(this._sessionModeUpdatedId);
            this._sessionModeUpdatedId = 0;
        }
    }

    _timeoutRefresh() {
        this._sync();
        return GLib.SOURCE_CONTINUE;
    }

    _sync() {
        this.enabled = this._paygManager.enabled;
        this.can_unlock = !Main.sessionMode.isLocked && !Main.sessionMode.isGreeter && this.enabled;
        this.time_remaining = this._getTimeRemainingString();
        this.account_id = this._paygManager.accountID;
        this.status_gicon = this._getStatusGicon();
    }

    _getStatusGicon() {
        const URGENT_EXPIRATION_S = 15 * 60;
        const timeLeftSeconds = this._paygManager.timeRemainingSecs();

        // if time left <= 0, we haven't yet determined it, so fall back to
        // "normal" icon
        if (timeLeftSeconds >= 0 && timeLeftSeconds <= URGENT_EXPIRATION_S)
            return _getNearExpirationGIcon();

        return _getNormalGIcon();
    }

    _getTimeRemainingString() {
        // the time will be invalid if the manager hasn't been
        // intitialized yet so return with a default message in that case
        if (!this._paygManager.initialized)
            return _('Getting time…');

        // if PAYG is disabled, nothing should be showing this label
        if (!this._paygManager.enabled)
            return '';

        const seconds = this._paygManager.timeRemainingSecs();
        if (seconds == 0)
            return _('Subscription expired');
        if (seconds < 60)
            return _('Less than 1 minute');

        return Payg.timeToString(seconds);
    }
});

const PaygAccountToggle = GObject.registerClass({
    Properties: {
        'time-remaining': GObject.ParamSpec.string('time-remaining', '', '',
            GObject.ParamFlags.READWRITE,
            null),
    },
}, class PaygAccountToggle extends QuickToggleWithSubtitle {
    _init() {
        super._init({
            visible: false,
            hasMenu: true,
            reactive: true,
        });

        this.add_style_class_name('payg-account-settings-item');

        this._menuIcon = new St.Icon({
            icon_name: 'go-next-symbolic',
            style_class: 'quick-toggle-arrow',
        });
        this._box.add_child(this._menuIcon);

        this.connect('clicked', () => {
            this.menu.open()
        });
        this.connect('popup-menu', () => {
            this.menu.open();
        });

        this.menu.setHeader(_getNormalGIcon(), _('Pay As You Go'));

        this._paygNotifier = new Payg.PaygNotifier();
        this._unlockMenuItem = this.menu.addAction('Enter unlock code…', () => {
            Main.panel.closeQuickSettings();
            this._paygNotifier.notify(-1);
        });
    }
});

var Indicator = GObject.registerClass(
class PaygIndicator extends SystemIndicator {
    _init() {
        super._init({
            visible: false,
        });
    }

    _init() {
        super._init();

        let paygInfo = new PaygAccountInfo();

        let paygAccountToggle = new PaygAccountToggle();
        this.quickSettingsItems.push(paygAccountToggle);
        paygInfo.bind_property('enabled',
            paygAccountToggle, 'visible',
            GObject.BindingFlags.SYNC_CREATE);
        paygInfo.bind_property('status-gicon',
            paygAccountToggle, 'gicon',
            GObject.BindingFlags.SYNC_CREATE);
        paygInfo.bind_property('can-unlock',
            paygAccountToggle, 'reactive',
            GObject.BindingFlags.SYNC_CREATE);
        paygInfo.bind_property('time-remaining',
            paygAccountToggle, 'title',
            GObject.BindingFlags.SYNC_CREATE);
        paygInfo.bind_property_full('account-id',
            paygAccountToggle, 'subtitle',
            GObject.BindingFlags.SYNC_CREATE,
            (bind, source) => [true, _('Account ID: %s').format(source)],
            null);

        let indicator = this._addIndicator();
        paygInfo.bind_property('enabled',
            indicator, 'visible',
            GObject.BindingFlags.SYNC_CREATE);
        paygInfo.bind_property('status-gicon',
            indicator, 'gicon',
            GObject.BindingFlags.SYNC_CREATE);
    }
});
