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

const { Gio, GLib, GObject } = imports.gi;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const Payg = imports.ui.payg;
const PopupMenu = imports.ui.popupMenu;
const PaygManager = imports.misc.paygManager;

const REFRESH_TIME_SECS = 60;

var Indicator = GObject.registerClass(
class PaygIndicator extends PanelMenu.SystemIndicator {
    _init() {
        super._init();

        this._paygManager = Main.paygManager;
        this._indicator = this._addIndicator();
        this._item = new PopupMenu.PopupSubMenuMenuItem('', true);
        this._paygNotifier = new Payg.PaygNotifier();
        this._item.menu.addAction(_('Enter unlock code…'), () => {
            this._paygNotifier.notify(-1);
        });
        this.menu.addMenuItem(this._item);

        this._paygItem = new PopupMenu.PopupSubMenuMenuItem('', true);
        this._paygItem.setSensitive(false);
        this.menu.addMenuItem(this._paygItem);

        this._paygManagerInitializedId = 0;
        if (!this._paygManager.initialized) {
            this._paygManagerInitializedId = this._paygManager.connect('initialized', () => {
                this._sync();
                this._paygManager.disconnect(this._paygManagerInitializedId);
                this._paygManagerInitializedId = 0;

                this._paygAddCreditDialog = new Payg.PaygAddCreditDialog();
                this._item.menu.addAction(_('Add credit…'), () => {
                    this._paygAddCreditDialog.open();
                });
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

        this.connect('destroy', this._onDestroy.bind(this));

        this._sync();
    }

    _onDestroy() {
        if (this._paygAddCreditDialog != null) {
            this._paygAddCreditDialog.destroy();
            this._paygAddCreditDialog = null;
        }

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

    _getMenuGicon() {
        const URGENT_EXPIRATION_S = 15 * 60;
        const timeLeftSeconds = this._paygManager.timeRemainingSecs();

        let iconUri = 'resource:///org/gnome/shell/theme/payg-normal-symbolic.svg';
        // if time left <= 0, we haven't yet determined it, so fall back to
        // "normal" icon
        if (timeLeftSeconds >= 0 && timeLeftSeconds <= URGENT_EXPIRATION_S)
            iconUri = 'resource:///org/gnome/shell/theme/payg-near-expiration-symbolic.svg';

        return new Gio.FileIcon({ file: Gio.File.new_for_uri(iconUri) });
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

    _timeoutRefresh() {
        this._sync();
        return GLib.SOURCE_CONTINUE;
    }

    _sync() {
        const sensitive = !Main.sessionMode.isLocked && !Main.sessionMode.isGreeter && this._paygManager.enabled;
        this.menu.setSensitive(sensitive);

        this._item.actor.visible = this._indicator.visible = this._paygManager.enabled;
        this._item.label.text = this._getTimeRemainingString();
        this._item.icon.gicon = this._getMenuGicon();
        this._indicator.gicon = this._item.icon.gicon;

        // Differently from the remaining time counter, we just want to show the account ID
        // when the backend properly supports it.
        this._paygItem.actor.visible = this._paygManager.enabled && this._verifyValidAccountID();
        this._paygItem.label.text = _('Account ID: %s').format(this._paygManager.accountID);
        this._paygItem.icon.gicon = this._item.icon.gicon;
    }

    _verifyValidAccountID() {
        return Main.paygManager.accountID !== '0';
    }
});
