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
const SideComponent = imports.ui.sideComponent;

var CLUBHOUSE_ID = 'com.endlessm.Clubhouse';
const CLUBHOUSE_DBUS_OBJ_PATH = '/com/endlessm/Clubhouse';

const ClubhouseIface =
'<node> \
  <interface name="com.endlessm.Clubhouse"> \
    <method name="show"> \
      <arg type="u" direction="in" name="timestamp"/> \
    </method> \
    <method name="hide"> \
      <arg type="u" direction="in" name="timestamp"/> \
    </method> \
    <property name="Visible" type="b" access="read"/> \
  </interface> \
</node>';


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

        let margin = 30;
        this.actor.x = monitor.x + monitor.width - (this.actor.width + margin);
        this.actor.y = margin;
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

var ClubhouseButtonManager = new Lang.Class({
    Name: 'ClubhouseButtonManager',

    _init: function() {
        this._openButton =
            new St.Button({ child: new St.Icon({ style_class: 'clubhouse-open-button-icon' }) });
        this._openButton.connect('clicked', () => { this.emit('open-clubhouse'); })

        Main.layoutManager.addChrome(this._openButton);

        this._closeButton =
            new St.Button({ child: new St.Icon({ style_class: 'clubhouse-close-button-icon' }) });
        this._closeButton.connect('clicked', () => { this.emit('close-clubhouse'); })

        Main.layoutManager.addChrome(this._closeButton);

        this._clubhouseWindowActor = null;
        this._clubhouseNotifyHandler = 0;

        this._updateVisibility();

        // If the Clubhouse is open and the Shell is restarted, then global.get_window_actors()
        // will still not have any contents when components are initialized, and there's no "map"
        // signal emitted from the Window Manager either. So instead of relying on the map signal
        // (which would allow us to track windows individually instead of always having to check the
        // current list of windows) we connect to the screen's "restacked" signal.
        this._restackedHandler = global.screen.connect('restacked',
                                                       this._trackWindowActor.bind(this));
        this._overviewShowingHandler = Main.overview.connect('showing',
                                                             this._updateVisibility.bind(this));
        this._overviewHiddenHandler = Main.overview.connect('hidden',
                                                            this._updateVisibility.bind(this));
    },

    _updateCloseButtonPosition: function() {
        this._closeButton.y = this._openButton.y;
        if (this._clubhouseWindowActor)
            this._closeButton.x = this._clubhouseWindowActor.x - this._closeButton.width / 2;
    },

    _reposition: function() {
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        this._openButton.x = monitor.x + monitor.width - this._openButton.width / 2;
        this._openButton.y = Math.floor(monitor.height / 2.0 - this._openButton.width / 2.0);

        this._updateCloseButtonPosition();
    },

    _updateVisibility: function() {
        this._closeButton.visible = !Main.overview.visible && this._clubhouseWindowActor;
        this._openButton.visible = !this._closeButton.visible;
        this._reposition();
    },

    _getClubhouseActorFromWM: function() {
        return global.get_window_actors().find((actor) => {
            return (actor.meta_window.get_gtk_application_id() == CLUBHOUSE_ID);
        });
    },

    _trackWindowActor: function() {
        let actor = this._getClubhouseActorFromWM();
        if (!actor)
            return;

        if (this._clubhouseWindowActor == actor)
            return;

        // Reset the current window actor
        this._untrackWindowActor();

        this._clubhouseWindowActor = actor;
        this._updateVisibility();

        // Track Clubhouse's window actor to make the closeButton always show on top of
        // the Clubhouse's window edge
        this._clubhouseNotifyHandler = actor.connect('notify::x',
                                                     this._updateCloseButtonPosition.bind(this));

        this._clubhouseDestroyHandler = actor.connect('destroy', () => {
            this._untrackWindowActor();

            this._updateVisibility();
        });
    },

    _untrackWindowActor: function() {
        if (!this._clubhouseWindowActor)
            return;

        // Reset the current window actor
        this._clubhouseWindowActor.disconnect(this._clubhouseNotifyHandler);
        this._clubhouseNotifyHandler = 0;

        this._clubhouseWindowActor.disconnect(this._clubhouseDestroyHandler);
        this._clubhouseDestroyHandler = 0;

        this._clubhouseWindowActor = null;
    },

    destroy: function() {
        Main.overview.disconnect(this._overviewShowingHandler);
        this._overviewShowingHandler = 0;

        Main.overview.disconnect(this._overviewHiddenHandler);
        this._overviewHiddenHandler = 0;

        global.screen.disconnect(this._restackedHandler);
        this._restackedHandler = 0;

        this._untrackWindowActor();
        this._closeButton.destroy();
        this._openButton.destroy();
    },
});
Signals.addSignalMethods(ClubhouseButtonManager.prototype);

var ClubhouseComponent = new Lang.Class({
    Name: 'ClubhouseComponent',
    Extends: SideComponent.SideComponent,

    _init: function() {
        this._useClubhouse = this._imageUsesClubhouse() && this._hasClubhouse();
        if (!this._useClubhouse)
            return;

        this.parent(ClubhouseIface, CLUBHOUSE_ID, CLUBHOUSE_DBUS_OBJ_PATH);

        this._clubhouseButtonManager = null;
        this._banner = null;
        this._clubhouseSource = null;
        this._clubhouseProxyHandler = 0;
    },

    enable: function() {
        if (!this._useClubhouse) {
            log('Cannot enable Clubhouse in this image version');
            return;
        }

        this.parent();

        this._clubhouseProxyHandler =
            this.proxy.connect('notify::g-name-owner', () => {
                if (!this.proxy.g_name_owner) {
                    log('Nothing owning D-Bus name %s, so dismiss the Clubhouse banner'.format(CLUBHOUSE_ID));
                    this._clearBanner();
                }
            });

        this._clubhouseButtonManager = new ClubhouseButtonManager();
        this._clubhouseButtonManager.connect('open-clubhouse', () => {
            this.show(global.get_current_time());
        });
        this._clubhouseButtonManager.connect('close-clubhouse', () => {
            this.hide(global.get_current_time());
        });

        // Trigger creation of our source, and connect to it
        this._clubhouseSource =
            Main.notificationDaemon._gtkNotificationDaemon._ensureAppSource(CLUBHOUSE_ID);
        this._clubhouseSource.connect('notify', Lang.bind(this, this._onNotify));
    },

    disable: function() {
        if (!this._useClubhouse)
            return;

        this._clearBanner();

        if (this._clubhouseProxyHandler > 0)
            this.proxy.disconnect(this._clubhouseProxyHandler);

        this.parent();
        this._clubhouseButtonManager.destroy();
        this._clubhouseButtonManager = null;
        this._clubhouseSource = null;
    },

    callShow: function(timestamp) {
        this.proxy.showRemote(timestamp);
    },

    callHide: function(timestamp) {
        this.proxy.hideRemote(timestamp);
    },

    _clearBanner: function() {
        if (!this._banner)
            return;

        this._banner.actor.destroy();
        this._banner = null;
    },

    _hasClubhouse: function() {
        return !!Shell.AppSystem.get_default().lookup_app(CLUBHOUSE_ID + '.desktop');
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
            if (reason != MessageTray.NotificationDestroyedReason.REPLACED &&
                reason != MessageTray.NotificationDestroyedReason.SOURCE_CLOSED)
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
        if (this.proxy.g_name_owner)
            this._clubhouseSource.activateAction('stop-quest', null);
    },
});
var Component = ClubhouseComponent;
