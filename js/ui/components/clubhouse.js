// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
//
// Copyright (C) 2018 Endless Mobile, Inc.
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
//
// Author: Joaquim Rocha <jrocha@endlessm.com>
//

const Clutter = imports.gi.Clutter;
const Flatpak = imports.gi.Flatpak
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const St = imports.gi.St;

const Lang = imports.lang;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const NotificationDaemon = imports.ui.notificationDaemon;

const CLUBHOUSE_ID = 'com.endlessm.Clubhouse';
const CLUBHOUSE_DBUS_OBJ_PATH = '/com/endlessm/Clubhouse';

var ClubhouseNotificationBanner = new Lang.Class({
    Name: 'ClubhouseNotificationBanner',
    Extends: MessageTray.NotificationBanner,

    _init: function(notification) {
        this.parent(notification);

        // We don't have an "unexpanded" state for now
        this.expand(false);
        this._actionBin.visible = true;

        this.actor.can_focus = true;
        this.actor.track_hover = true;

        // Override the style name because this is a not a regular notification
        this.actor.remove_style_class_name('notification-banner');
        this.actor.add_style_class_name('clubhouse-quest-view');
        this._iconBin.add_style_class_name('clubhouse-quest-view-icon-bin');

        // Always wrap the body's text
        this._expandedLabel.actor.add_style_class_name('clubhouse-quest-view-label');
    },

    reposition: function() {
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        let margin = 50;
        this.actor.x = monitor.width - (this.actor.width + margin);
        this.actor.y = Math.floor((monitor.height - this.actor.height) / 2.0) - margin;
    },
});

var ClubhouseNotification = new Lang.Class({
    Name: 'ClubhouseNotification',
    Extends: NotificationDaemon.GtkNotificationDaemonNotification,

    _init: function(source, notification) {
        this.parent(source, notification);

        // Avoid destroying the notification when clicking it
        this.setResident(true);
    },

    createBanner: function() {
        return new ClubhouseNotificationBanner(this);
    },
});

var ClubhouseNotificationSource = new Lang.Class({
    Name: 'ClubhouseNotificationSource',
    Extends: NotificationDaemon.GtkNotificationDaemonAppSource,

    _createNotification: function(params) {
        return new ClubhouseNotification(this, params);
    },
});

var ClubhouseComponent = new Lang.Class({
    Name: 'ClubhouseComponent',

    _init: function() {
        this._useClubhouse = this._imageUsesClubhouse();
        if (!this._useClubhouse)
            return;

        this._banner = null;
        this._clubhouseSource = null;
        this._clubhouseProxy = null;
        this._clubhouseProxyHandler = 0;
    },

    enable: function() {
        if (!this._useClubhouse) {
            log('Cannot enable Clubhouse in this image version');
            return;
        }

        this._clubhouseProxy = new Gio.DBusProxy.new_sync(Gio.DBus.session,
                                                          Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION,
                                                          null,
                                                          CLUBHOUSE_ID,
                                                          CLUBHOUSE_DBUS_OBJ_PATH,
                                                          CLUBHOUSE_ID,
                                                          null);
        this._clubhouseProxyHandler =
            this._clubhouseProxy.connect('notify::g-name-owner', () => {
                if (!this._clubhouseProxy.g_name_owner) {
                    log('Nothing owning D-Bus name %s, so dismiss the Clubhouse banner'.format(CLUBHOUSE_ID));
                    this._clearBanner();
                }
            });

        this._clubhouseSource = new ClubhouseNotificationSource(CLUBHOUSE_ID);
        this._clubhouseSource.connect('notify', Lang.bind(this, this._onNotify));

        // Inject this source in GtkNotificationDaemon's lookup table
        Main.notificationDaemon._gtkNotificationDaemon._sources[CLUBHOUSE_ID] =
            this._clubhouseSource;
    },

    disable: function() {
        if (!this._useClubhouse)
            return;

        this._clearBanner();

        if (this._clubhouseProxyHandler > 0)
            this._clubhouseProxy.disconnect(this._clubhouseProxyHandler);

        this._clubhouseSource = null;
        this._clubhouseProxy = null;
    },

    _clearBanner: function() {
        if (!this._banner)
            return;

        this._banner.actor.destroy();
        this._banner = null;
    },

    _imageUsesClubhouse: function() {
        if (GLib.getenv('CLUBHOUSE_DEBUG_ENABLED'))
            return true;

        // We are only using the Clubhouse component in Endless Hack images for now, so
        // check if the prefix of the image version matches the mentioned flavor.
        let eosImageVersion = Shell.util_get_eos_image_version();
        return eosImageVersion && eosImageVersion.startsWith('hack-');
    },

    _onNotify: function(source, notification) {
        notification.connect('destroy', (notification, reason) => {
            if (reason != MessageTray.NotificationDestroyedReason.REPLACED)
                this._dismissQuest();

            this._clearBanner();
        });

        if (!this._banner) {
            this._banner = notification.createBanner();
            Main.layoutManager.addChrome(this._banner.actor);
            this._banner.reposition();
        }
    },

    _dismissQuest: function() {
        // Stop the quest since the banner has been dismissed
        if (this._clubhouseProxy.g_name_owner)
            this._clubhouseSource.activateAction('stop-quest', null);
    },
});
var Component = ClubhouseComponent;
