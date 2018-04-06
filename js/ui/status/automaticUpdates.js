// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
//
// Copyright (C) 2018 Endless Mobile, Inc.
//
// This is a GNOME Shell component to wrap the interactions over
// D-Bus with the Mogwai system daemon.
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

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Lang = imports.lang;
const NM = imports.gi.NM;
const Shell = imports.gi.Shell;
const St = imports.gi.St;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const NM_SETTING_ALLOW_DOWNLOADS_WHEN_METERED = 'connection.allow-downloads-when-metered';
const NM_SETTING_TARIFF_ENABLED = "connection.tariff-enabled";

const SchedulerInterface = '\
<node> \
  <interface name="com.endlessm.DownloadManager1.Scheduler"> \
    <property name="ActiveEntryCount" type="u" access="read" /> \
    <property name="EntryCount" type="u" access="read" /> \
  </interface> \
</node>';

const SchedulerProxy = Gio.DBusProxy.makeProxyWrapper(SchedulerInterface);

var AutomaticUpdatesState = {
    UNKNOWN: 0,
    DISCONNECTED: 1,
    DISABLED: 2,
    IDLE: 3,
    SCHEDULED: 4,
    DOWNLOADING: 5
};

function automaticUpdatesStateToString(state) {
    switch (state) {
    case AutomaticUpdatesState.UNKNOWN:
    case AutomaticUpdatesState.DISCONNECTED:
        return null;

    case AutomaticUpdatesState.DISABLED:
        return 'resource:///org/gnome/shell/theme/endless-auto-updates-off-symbolic.svg';

    case AutomaticUpdatesState.IDLE:
    case AutomaticUpdatesState.DOWNLOADING:
        return 'resource:///org/gnome/shell/theme/endless-auto-updates-on-symbolic.svg';

    case AutomaticUpdatesState.SCHEDULED:
        return 'resource:///org/gnome/shell/theme/endless-auto-updates-scheduled-symbolic.svg';
    }

    return null;
}

var Indicator = new Lang.Class({
    Name: 'AutomaticUpdatesIndicator',
    Extends: PanelMenu.SystemIndicator,

    _init: function() {
        this.parent();

        this._indicator = this._addIndicator();
        this._item = new PopupMenu.PopupSubMenuMenuItem("", true);
        this._toggleItem = this._item.menu.addAction("", this._toggleAutomaticUpdates.bind(this));
        this._item.menu.addAction(_("Updates Queue…"), () => {
            let params = new GLib.Variant('(sava{sv})', [ 'set-mode', [ new GLib.Variant('s', 'updates') ], {} ]);
            Gio.DBus.session.call('org.gnome.Software',
                                  '/org/gnome/Software',
                                  'org.gtk.Actions',
                                  'Activate',
                                  params,
                                  null,
                                  Gio.DBusCallFlags.NONE,
                                  5000,
                                  null,
                                  (conn, result) => {
                                      try {
                                          conn.call_finish(result);
                                      } catch (e) {
                                          logError(e, 'Failed to start gnome-software');
                                      }
                                  });

        });
        this._item.menu.addSettingsAction(_("Set a Schedule…"), 'gnome-updates-panel.desktop');
        this.menu.addMenuItem(this._item);

        this._activeConnection = null;
        this._settingChangedSignalId = 0;

        NM.Client.new_async(null, this._clientGot.bind(this));
    },

    _clientGot: function(obj, result) {
        this._client = NM.Client.new_finish(result);

        this._client.connect('notify::activating-connection', this._sync.bind(this));
        this._client.connect('notify::primary-connection', this._sync.bind(this));

        this._sync();

        Main.sessionMode.connect('updated', this._sessionUpdated.bind(this));
        this._sessionUpdated();

        // Start retrieving the Mogwai proxy
        this._proxy = new SchedulerProxy(Gio.DBus.system,
                                         'com.endlessm.MogwaiScheduler1',
                                         '/com/endlessm/DownloadManager1',
                                          (proxy, error) => {
                                              if (error) {
                                                  log(error.message);
                                                  return;
                                              }
                                              this._proxy.connect('g-properties-changed',
                                                                  this._sync.bind(this));
                                              this._sync();
                                          });
    },

    _sessionUpdated: function() {
        let sensitive = !Main.sessionMode.isLocked && !Main.sessionMode.isGreeter;
        this.menu.setSensitive(sensitive);
    },

    _sync: function() {
        if (!this._client || !this._proxy)
            return;

        // Update the current active connection. This will connect to the
        // NM.SettingUser signal to sync every time someone updates the
        // NM_SETTING_ALLOW_DOWNLOADS_WHEN_METERED setting.
        this._updateActiveConnection();

        // Toggle item name
        this._updateAutomaticUpdatesItem();

        // Icons
        let icon = this._getIcon()

        this._item.icon.gicon = icon;
        this._indicator.gicon = icon;

        // Only show the Automatic Updates icon at the bottom bar when it is
        // both enabled, and there are updates being downloaded or installed.
        this._updateVisibility();

        // The status label
        this._item.label.text = _("Automatic Updates");
    },

    _updateActiveConnection: function() {
        let currentActiveConnection = this._getActiveConnection();

        if (this._activeConnection == currentActiveConnection)
            return;

        // Disconnect from the previous active connection
        if (this._settingChangedSignalId > 0) {
            this._activeConnection.disconnect(this._settingChangedSignalId);
            this._settingChangedSignalId = 0;
        }

        this._activeConnection = currentActiveConnection;

        // Connect from the current active connection
        if (currentActiveConnection)
            this._settingChangedSignalId = currentActiveConnection.connect('changed', this._sync.bind(this));
    },

    _updateAutomaticUpdatesItem: function() {
        let state = this._getState();

        if (state == AutomaticUpdatesState.DISABLED)
            this._toggleItem.label.text = _("Turn Automatic Updates ON");
        else
            this._toggleItem.label.text = _("Turn Automatic Updates OFF");
    },

    _toggleAutomaticUpdates: function() {
        if (!this._activeConnection)
            return;

        let userSetting = this._ensureUserSetting(this._activeConnection);

        // The string representation here is the oposite of the value
        let value = '0';
        if (userSetting.get_data(NM_SETTING_ALLOW_DOWNLOADS_WHEN_METERED) != '1')
            value = '1';

        userSetting.set_data(NM_SETTING_ALLOW_DOWNLOADS_WHEN_METERED, value);

        this._activeConnection.commit_changes_async(true, null, (con, res, data) => {
            this._activeConnection.commit_changes_finish(res);
            this._sync();
        });
    },

    _ensureUserSetting: function(connection) {
        let userSetting = connection.get_setting(NM.SettingUser.$gtype);
        if (!userSetting) {
            userSetting = new NM.SettingUser();
            connection.add_setting(userSetting);
        }
        return userSetting;
    },

    _getIcon: function() {
        let state = this._getState();
        let iconName = automaticUpdatesStateToString(state);

        if (!iconName)
            return null;

        let iconFile = Gio.File.new_for_uri(iconName);
        let gicon = new Gio.FileIcon({ file: iconFile });

        return gicon;
    },

    _updateVisibility: function() {
        let state = this._getState();

        this._item.actor.visible = (state != AutomaticUpdatesState.DISCONNECTED);
        this._indicator.visible = (state == AutomaticUpdatesState.DOWNLOADING);
    },


    _getState: function() {
        if (!this._activeConnection)
            return AutomaticUpdatesState.DISCONNECTED;

        let userSetting = this._ensureUserSetting(this._activeConnection);

        // We only return true when:
        //  * Automatic Updates are on
        //  * A schedule was set
        //  * Something is being downloaded

        let allowDownloads = userSetting.get_data(NM_SETTING_ALLOW_DOWNLOADS_WHEN_METERED) === '1';
        if (!allowDownloads)
            return AutomaticUpdatesState.DISABLED;

        // Without the proxy, we can't really know the state
        if (!this._proxy)
            return AutomaticUpdatesState.UNKNOWN;

        let scheduleSet = userSetting.get_data(NM_SETTING_TARIFF_ENABLED) === '1';
        if (!scheduleSet)
            return AutomaticUpdatesState.IDLE;

        let downloading = this._proxy.ActiveEntryCount > 0;
        if (downloading)
            return AutomaticUpdatesState.DOWNLOADING;

        // At this point we're not downloading anything, but something
        // might be queued
        let downloadsQueued = this._proxy.EntryCount > 0;
        if (downloadsQueued)
            return AutomaticUpdatesState.SCHEDULED;
        else
            return AutomaticUpdatesState.IDLE;
    },

    _getActiveConnection: function() {
        let activeConnection = this._client.get_primary_connection();

        if (!activeConnection)
            activeConnection = this._client.get_activating_connection();

        return activeConnection ? activeConnection.get_connection() : null;
    }
});
