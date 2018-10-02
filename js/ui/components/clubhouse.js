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

    updateFromParams: function(params) {
        // Update icon
        let newGicon = null;
        let gicon = params.icon;
        if (gicon)
            newGicon = Gio.icon_deserialize(gicon);

        let clear = true;
        this.update('', params.body.unpack(), {gicon: newGicon, clear: clear});

        // We need to set up the actions here because the update method above unfortunately
        // doesn't take any new "buttons" parameter into account.
        let buttons = params.buttons;
        if (buttons) {
            buttons.deep_unpack().forEach(Lang.bind(this, function(button) {
                this.addAction(button.label.unpack(),
                               Lang.bind(this, this._onButtonClicked, button));
            }));
        }
        this.emit('updated', clear);
    },
});

var ClubhouseNotificationSource = new Lang.Class({
    Name: 'ClubhouseNotificationSource',
    Extends: NotificationDaemon.GtkNotificationDaemonAppSource,

    _init: function(appId) {
        this.parent(appId);
        this._notification = null;
    },

    addNotification: function(notificationId, notificationParams, showBanner) {
        if (this._notification == null)
            this._notification = new ClubhouseNotification(this, notificationParams);
        else
            this._notification.updateFromParams(notificationParams);

        this.notify(this._notification);
    },
});

var ClubhouseComponent = new Lang.Class({
    Name: 'ClubhouseComponent',

    _init: function() {
        this._useClubhouse = this._imageUsesClubhouse();
        if (!this._useClubhouse)
            return;

        this._banner = null;
        this.actor = null;
        this._clubhouseSource = null;
        this._clubhouseProxy = null;
        this._clubhouseProxyHandler = 0;
        this._oldAddNotificationFuncPrototype = null;
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
            this._clubhouseProxy.connect('notify::g-name-owner', Lang.bind(this, function() {
                if (!this._clubhouseProxy.g_name_owner) {
                    log('Nothing owning D-Bus name %s, so dismiss the Clubhouse banner'.format(CLUBHOUSE_ID));
                    this._dismissQuestCb();
                }
            }));

        this.actor = new St.Widget({ visible: true,
                                     clip_to_allocation: true,
                                     can_focus: true,
                                     track_hover: true,
                                     reactive: true,
                                     layout_manager: new Clutter.BinLayout() });

        Main.layoutManager.addChrome(this.actor);

        this._clubhouseSource = new ClubhouseNotificationSource(CLUBHOUSE_ID);
        this._clubhouseSource.connect('notify', Lang.bind(this, this._onNotify));

        this._overrideAddNotification();
    },

    disable: function() {
        if (!this._useClubhouse)
            return;

        if (this.actor)
            this.actor.destroy();

        if (this._clubhouseProxyHandler > 0)
            this._clubhouseProxy.disconnect(this._clubhouseProxyHandler);

        if (this._oldAddNotificationFuncPrototype) {
            NotificationDaemon.GtkNotificationDaemon.prototype.AddNotificationAsync =
                this._oldAddNotificationFuncPrototype;
        }

        this.actor = null;
        this._clubhouseSource = null;
        this._banner = null;
        this._clubhouseProxy = null;
    },

    _imageUsesClubhouse: function() {
        // We are only using the Clubhouse component in Endless Hack images for now, so
        // check if the prefix of the image version matches the mentioned flavor.
        let eosImageVersion = Shell.util_get_eos_image_version();
        return eosImageVersion && eosImageVersion.startsWith('hack-');
    },

    _overrideAddNotification: function() {
        this._oldAddNotificationFuncPrototype =
            NotificationDaemon.GtkNotificationDaemon.prototype.AddNotificationAsync;
        NotificationDaemon.GtkNotificationDaemon.prototype.ClubhouseData = [CLUBHOUSE_ID,
                                                                            this._clubhouseSource,
                                                                            this._oldAddNotificationFuncPrototype];
        NotificationDaemon.GtkNotificationDaemon.prototype.AddNotificationAsync = function(params, invocation) {
            let [appId, notificationId, notification] = params;

            let clubhouseId = this.ClubhouseData[0];

            // If the app sending the notification is the Clubhouse, then use our own source
            if (appId == clubhouseId) {
                let source = this.ClubhouseData[1];
                source.addNotification(notificationId, notification, true);
                invocation.return_value(null);
                return;
            }

            this.ClubhouseData[2].apply(Main.notificationDaemon._gtkNotificationDaemon, arguments);
        }
    },

    _onNotify: function(source, notification) {
        this.actor.visible = true;

        // Only create the banner if it doesn't yet exist, otherwise just rely on the notification
        // object getting updated.
        if (!this._banner) {
            this._banner = notification.createBanner();
            this._bannerCloseHandler =
                this._banner.connect('close', Lang.bind(this, this._dismissQuestCb));
            this.actor.add_child(this._banner.actor);
            this._reposition();
        }
    },

    _dismissQuestCb: function() {
        this.actor.visible = false;
        if (this._banner) {
            // Stop the quest since the banner has been dismissed
            if (this._clubhouseProxy.g_name_owner)
                this._clubhouseSource.activateAction('stop-quest', null);

            this.actor.remove_child(this._banner.actor);
            this._banner = null;
        }
    },

    _reposition: function() {
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        let margin = 50;
        this.actor.x = monitor.width - (this.actor.width + margin);
        this.actor.y = monitor.height / 2.0 - this.actor.height / 2.0 - margin;
    },
});
var Component = ClubhouseComponent;
