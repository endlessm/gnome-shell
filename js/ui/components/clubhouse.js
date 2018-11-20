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
const Mainloop = imports.mainloop;
const MessageTray = imports.ui.messageTray;
const NotificationDaemon = imports.ui.notificationDaemon;
const SideComponent = imports.ui.sideComponent;
const Tweener = imports.ui.tweener;

const GtkNotificationDaemon = NotificationDaemon.GtkNotificationDaemon;

const CLUBHOUSE_BANNER_TIMEOUT_MSEC = 3000;
const CLUBHOUSE_BANNER_ANIMATION_TIME = 0.2;

const CLUBHOUSE_ID = 'com.endlessm.Clubhouse';
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
    <property name="SuggestingOpen" type="b" access="read"/> \
  </interface> \
</node>';

var getClubhouseWindowTracker = (function () {
    let clubhouseWindowTracker;
    return function () {
        if (!clubhouseWindowTracker)
            clubhouseWindowTracker = new ClubhouseWindowTracker();
        return clubhouseWindowTracker;
    };
}());

var ClubhouseWindowTracker = new Lang.Class({
    Name: 'ClubhouseWindowTracker',
    Extends: GObject.Object,

    Signals: {
        'window-changed': {},
    },

    _init: function() {
        this.parent();

        this._windowActor = null;

        // If the Clubhouse is open and the Shell is restarted, then global.get_window_actors()
        // will still not have any contents when components are initialized, and there's no "map"
        // signal emitted from the Window Manager either. So instead of relying on the map signal
        // (which would allow us to track windows individually instead of always having to check the
        // current list of windows) we connect to the screen's "restacked" signal.
        global.screen.connect('restacked', this._trackWindowActor.bind(this));

        Main.overview.connect('showing', () => { this.emit('window-changed'); });
        Main.overview.connect('hidden', () => { this.emit('window-changed'); });
        Main.sessionMode.connect('updated', () => { this.emit('window-changed'); });
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

        if (this._windowActor == actor)
            return;

        // Reset the current window actor
        this._untrackWindowActor();

        this._windowActor = actor;

        this.emit('window-changed');

        // Track Clubhouse's window actor to make the closeButton always show on top of
        // the Clubhouse's window edge
        this._notifyHandler = actor.connect('notify::x', () => {
            this.emit('window-changed');
        });

        this._destroyHandler = actor.connect('destroy', () => {
            this._untrackWindowActor();
            this.emit('window-changed');
        });
    },

    _untrackWindowActor: function() {
        if (!this._windowActor)
            return;

        // Reset the current window actor
        this._windowActor.disconnect(this._notifyHandler);
        this._notifyHandler = 0;

        this._windowActor.disconnect(this._destroyHandler);
        this._destroyHandler = 0;

        this._windowActor = null;
    },

    getWindowX: function() {
        if (!Main.sessionMode.hasOverview || Main.overview.visible || this._windowActor == null)
            return -1;
        return this._windowActor.x;
    },
});

var ClubhouseNotificationBanner = new Lang.Class({
    Name: 'ClubhouseNotificationBanner',
    Extends: MessageTray.NotificationBanner,

    _init: function(notification) {
        this._textPages = [];
        this._textIdx = -1;
        this._splitTextInPages(notification.bannerBodyText);

        // We will show the text differently, so have the parent set no text for now
        notification.bannerBodyText = '';

        this.parent(notification);

        // Whether it should animate when positioning it
        this._shouldSlideIn = true;

        this._setNextPage();

        if (this._textPages.length > 1)
            this._setupNextPageButton();

        // We don't have an "unexpanded" state for now
        this.expand(false);
        this._actionBin.visible = true;

        this.actor.can_focus = true;
        this.actor.track_hover = true;

        // Override the style name because this is a not a regular notification
        this.actor.remove_style_class_name('notification-banner');
        this.actor.add_style_class_name('clubhouse-notification');
        this._iconBin.add_style_class_name('clubhouse-notification-icon-bin');

        // Always wrap the body's text
        this._expandedLabel.actor.add_style_class_name('clubhouse-notification-label');

        this._clubhouseTrackerHandler =
            getClubhouseWindowTracker().connect('window-changed', this.reposition.bind(this));

        this.actor.connect('destroy', () => {
            getClubhouseWindowTracker().disconnect(this._clubhouseTrackerHandler);
        });

        // Hide on timeout if needed
        this._hideTimeout = 0;
        if (!notification.resident) {
            this._resetTimeout();
            this.actor.connect('notify::hover', this._resetTimeout.bind(this));
        }
    },

    _resetTimeout: function() {
        if (this._hideTimeout > 0) {
            Mainloop.source_remove(this._hideTimeout);
            this._hideTimeout = 0;
        }

        if (this.actor.hover)
            return;

        // @todo: Gradually fade out so the user sees the banner is going away
        this._hideTimeout = Mainloop.timeout_add(CLUBHOUSE_BANNER_TIMEOUT_MSEC, () => {
            this.close();
            return GLib.SOURCE_REMOVE;
        });
    },

    _addActions: function() {
        // Only set up the actions if we're showing the last page of text
        if (!this._inLastPage())
            return;

        this.parent();
    },

    _splitTextInPages: function(fulltext) {
        // @todo: Ensure that paragraphs longer than 5 lines (in the banner) is also split up
        this._textPages = fulltext.split('\n\n');
    },

    reposition: function() {
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        let margin = 30;

        let clubhouseWindowX = getClubhouseWindowTracker().getWindowX();

        if (clubhouseWindowX == -1)
            this.actor.x = monitor.x + monitor.width;
        else
            this.actor.x = clubhouseWindowX;

        let endX = this.actor.x - this.actor.width - margin;

        if (this._shouldSlideIn) {
            Tweener.addTween(this.actor,
                             { x: endX,
                               time: CLUBHOUSE_BANNER_ANIMATION_TIME,
                               transition: 'easeOutQuad'
                             });
        } else {
            this.actor.x = endX;
        }

        this.actor.y = margin;
    },

    _onClicked: function() {
        // Do nothing because we don't want to activate the Clubhouse ATM
    },

    _setNextPage: function() {
        if (this._inLastPage())
            return;

        this.setBody(this._textPages[++this._textIdx]);
        if (this._inLastPage())
            this._addActions();
    },

    _inLastPage: function() {
        return this._textIdx == this._textPages.length - 1;
    },

    _setupNextPageButton: function() {
        let button = new St.Button({ style_class: 'notification-button',
                                     label: '»',
                                     x_expand: true,
                                     can_focus: true });

        return this.addButton(button, () => {
            this._setNextPage();

            if (this._inLastPage())
                button.destroy();
        });
    },

    _slideOut: function() {
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        let endX = monitor.x + monitor.width;

        Tweener.addTween(this.actor,
                         { x: endX,
                           time: CLUBHOUSE_BANNER_ANIMATION_TIME,
                           transition: 'easeOutQuad',
                           onComplete: () => {
                               this.actor.destroy();
                               this.actor = null;
                           }
                         });
    },

    dismiss: function(shouldSlideOut) {
        if (shouldSlideOut) {
            this._slideOut();
            return;
        }

        this.actor.destroy();
        this.actor = null;
    },
});


var ClubhouseQuestBanner = new Lang.Class({
    Name: 'ClubhouseQuestBanner',
    Extends: ClubhouseNotificationBanner,

    _init: function(notification, isFirstBanner) {
        this.parent(notification);

        this._shouldSlideIn = isFirstBanner;

        this._closeButton.visible = Main.sessionMode.hasOverview;
    },
});

var ClubhouseItemBanner = new Lang.Class({
    Name: 'ClubhouseItemBanner',
    Extends: ClubhouseNotificationBanner,

    _init: function(notification) {
        this.parent(notification);
        this._topBanner = null;

        this._addActions();
    },

    setTopBanner: function(topBanner) {
        this._topBanner = topBanner;
        this.reposition();
    },

    reposition: function() {
        this.parent();

        if (this._topBanner && this._topBanner.actor)
            this.actor.y += this._topBanner.actor.height;
    },
});

var ClubhouseNotification = new Lang.Class({
    Name: 'ClubhouseNotification',
    Extends: NotificationDaemon.GtkNotificationDaemonNotification,

    _init: function(source, notification) {
        this.parent(source, notification);

        this.notificationId = notification.notificationId.unpack();

        // Avoid destroying the notification when clicking it
        this.setResident(true);
    },

    createBanner: function(isFirstBanner) {
        return new ClubhouseQuestBanner(this, isFirstBanner);
    },
});

var ClubhouseItemNotification = new Lang.Class({
    Name: 'ClubhouseItemNotification',
    Extends: ClubhouseNotification,

    _init: function(source, notification) {
        this.parent(source, notification);
        this.setResident(false);
    },

    createBanner: function() {
        return new ClubhouseItemBanner(this)
    },
});

var ClubhouseNotificationSource = new Lang.Class({
    Name: 'ClubhouseNotificationSource',
    Extends: NotificationDaemon.GtkNotificationDaemonAppSource,

    _createNotification: function(params) {
        let notificationId = params.notificationId.unpack();

        if (notificationId == 'quest-item')
            return new ClubhouseItemNotification(this, params);

        return new ClubhouseNotification(this, params);
    },
});

var ClubhouseOpenButton = new Lang.Class({
    Name: 'ClubhouseOpenButton',
    Extends: St.Button,

    _init: function(params) {
        params = params || {};
        this._icon = new St.Icon({ style_class: 'clubhouse-open-button-icon' });
        params.child = this._icon;
        this.parent(params);
    },

    setHighlighted: function(highlighted) {
        if (highlighted)
            this._icon.add_style_pseudo_class('highlighted');
        else
            this._icon.remove_style_pseudo_class('highlighted');
    },
});

var ClubhouseButtonManager = new Lang.Class({
    Name: 'ClubhouseButtonManager',

    _init: function() {
        this._openButton = new ClubhouseOpenButton();
        this._openButton.connect('clicked', () => { this.emit('open-clubhouse'); })

        Main.layoutManager.addChrome(this._openButton);

        this._closeButton =
            new St.Button({ child: new St.Icon({ style_class: 'clubhouse-close-button-icon' }) });
        this._closeButton.connect('clicked', () => { this.emit('close-clubhouse'); })

        Main.layoutManager.addChrome(this._closeButton);

        this._clubhouseWindowActor = null;
        this._clubhouseNotifyHandler = 0;

        this._visible = true;

        this._updateVisibility();

        getClubhouseWindowTracker().connect('window-changed', this._updateVisibility.bind(this));
    },

    _updateCloseButtonPosition: function() {
        this._closeButton.y = this._openButton.y;

        let clubhouseWindowX = getClubhouseWindowTracker().getWindowX();
        if (clubhouseWindowX != -1)
            this._closeButton.x = clubhouseWindowX - this._closeButton.width / 2;
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
        this._closeButton.visible = this._visible && getClubhouseWindowTracker().getWindowX() != -1;
        this._openButton.visible = this._visible && Main.sessionMode.hasOverview &&
                                   !this._closeButton.visible;
        this._reposition();
    },

    setSuggestOpen: function(suggestOpen) {
        this._openButton.setHighlighted(suggestOpen);
    },

    setVisible: function(visible) {
        this._visible = visible;
        this._updateVisibility();
    }
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

        this._enabled = false;
        this._isRunningQuest = false;

        this._questBanner = null;
        this._clubhouseSource = null;
        this._clubhouseProxyHandler = 0;

        this._clubhouseButtonManager = new ClubhouseButtonManager();
        this._clubhouseButtonManager.connect('open-clubhouse', () => {
            this.show(global.get_current_time());
        });
        this._clubhouseButtonManager.connect('close-clubhouse', () => {
            this.hide(global.get_current_time());
        });

        this._overrideAddNotification();
    },

    _onPropertiesChanged: function(proxy, changedProps, invalidatedProps) {
        this.parent(proxy, changedProps, invalidatedProps);
        let propsDict = changedProps.deep_unpack();
        if (propsDict.hasOwnProperty('SuggestingOpen'))
            this._clubhouseButtonManager.setSuggestOpen(this.proxy.SuggestingOpen);
    },

    enable: function() {
        if (!this._useClubhouse) {
            log('Cannot enable Clubhouse in this image version');
            return;
        }

        this.parent();

        if (this._clubhouseProxyHandler == 0) {
            this._clubhouseProxyHandler = this.proxy.connect('notify::g-name-owner', () => {
                if (!this.proxy.g_name_owner) {
                    log('Nothing owning D-Bus name %s, so dismiss the Clubhouse banner'.format(CLUBHOUSE_ID));
                    this._clearQuestBanner();
                }
            });
        }

        this._clubhouseButtonManager.setSuggestOpen(this.proxy.SuggestingOpen);

        this._enabled = true;
        this._syncVisibility();
    },

    disable: function() {
        if (!this._useClubhouse)
            return;

        this.parent();

        this._enabled = false;
        this._syncVisibility();
    },

    callShow: function(timestamp) {
        this.proxy.showRemote(timestamp);
    },

    callHide: function(timestamp) {
        this.proxy.hideRemote(timestamp);
    },

    _getClubhouseSource: function() {
        if (this._clubhouseSource != null)
            return this._clubhouseSource;

        this._clubhouseSource = new ClubhouseNotificationSource(CLUBHOUSE_ID);
        this._clubhouseSource.connect('notify', Lang.bind(this, this._onNotify));
        this._clubhouseSource.connect('destroy', () => {
            this._clubhouseSource.activateAction('stop-quest', null);
            this._clubhouseSource = null;
        })

        return this._clubhouseSource;
    },

    _syncBanners: function() {
        if (this._itemBanner)
            this._itemBanner.setTopBanner(this._questBanner);
    },

    _clearQuestBanner: function() {
        if (!this._questBanner)
            return;

        this._questBanner.dismiss(!this._isRunningQuest);

        this._questBanner = null;

        this._syncBanners();
    },

    _clearItemBanner: function() {
        if (!this._itemBanner)
            return;

        this._itemBanner.dismiss(true);
        this._itemBanner = null;
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

    _overrideAddNotification: function() {
        let oldAddNotificationFunc = GtkNotificationDaemon.prototype.AddNotificationAsync;
        GtkNotificationDaemon.prototype.AddNotificationAsync = (params, invocation) => {
            let [appId, notificationId, notification] = params;

            // If the app sending the notification is the Clubhouse, then use our own source
            if (appId == CLUBHOUSE_ID) {
                notification['notificationId'] = new GLib.Variant('s', notificationId);
                this._getClubhouseSource().addNotification(notificationId, notification, true);
                invocation.return_value(null);
                return;
            }

            oldAddNotificationFunc.apply(Main.notificationDaemon._gtkNotificationDaemon,
                                         [params, invocation]);
        }

        let oldRemoveNotificationFunc = GtkNotificationDaemon.prototype.RemoveNotificationAsync;
        GtkNotificationDaemon.prototype.RemoveNotificationAsync = (params, invocation) => {
            let [appId, notificationId] = params;

            // If the app sending the notification is the Clubhouse, then use our own source
            if (appId == CLUBHOUSE_ID) {
                this._getClubhouseSource().removeNotification(notificationId);
                invocation.return_value(null);
                return;
            }

            oldRemoveNotificationFunc.apply(Main.notificationDaemon._gtkNotificationDaemon,
                                            [params, invocation]);
        }

    },

    _onNotify: function(source, notification) {
        // @todo: Abstract the banner logic into the notifications themselves as much as possible
        // (to just keep track of when they're destroyed).
        if (notification.notificationId == 'quest-message') {
            notification.connect('destroy', (notification, reason) => {
                if (reason != MessageTray.NotificationDestroyedReason.REPLACED &&
                    reason != MessageTray.NotificationDestroyedReason.SOURCE_CLOSED)
                    this._dismissQuest();

                this._clearQuestBanner();
            });

            if (!this._questBanner) {
                this._questBanner = notification.createBanner(!this._isRunningQuest);
                this._isRunningQuest = true;

                Main.layoutManager.addChrome(this._questBanner.actor);
                this._questBanner.reposition();
            }
        } else if (notification.notificationId == 'quest-item') {
            notification.connect('destroy', (notification, reason) => {
                this._clearItemBanner();
            });

            if (!this._itemBanner) {
                this._itemBanner = notification.createBanner();
                Main.layoutManager.addChrome(this._itemBanner.actor);
                this._itemBanner.reposition();
            }
        }

        this._syncBanners();

        // Sync the visibility here because the screen may be locked when a notification
        // happens
        this._syncVisibility();
    },

    _dismissQuest: function() {
        // Stop the quest since the banner has been dismissed
        if (this.proxy.g_name_owner && this._clubhouseSource)
            this._clubhouseSource.activateAction('stop-quest', null);

        this._isRunningQuest = false;
    },

    _syncVisibility: function() {
        this._clubhouseButtonManager.setVisible(this._enabled);

        if (this._questBanner)
            this._questBanner.actor.visible = this._enabled;

        if (this._itemBanner)
            this._itemBanner.actor.visible = this._enabled;
    },
});
var Component = ClubhouseComponent;
