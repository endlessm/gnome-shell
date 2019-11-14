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

/* exported Component */

const { Clutter, Flatpak, Gio, GLib, GObject, Json, Pango, Shell, St } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Hack = ExtensionUtils.getCurrentExtension();
const Settings = Hack.imports.utils.getSettings();

const Animation = imports.ui.animation.Animation;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const NotificationDaemon = imports.ui.notificationDaemon;
const SideComponent = imports.ui.sideComponent;
const Soundable = Hack.imports.ui.soundable;
const SoundServer = Hack.imports.misc.soundServer;

const { loadInterfaceXML } = Hack.imports.utils;

const GtkNotificationDaemon = NotificationDaemon.GtkNotificationDaemon;

const CLUBHOUSE_BANNER_ANIMATION_TIME = 200;

const CLUBHOUSE_DBUS_OBJ_PATH = '/com/hack_computer/Clubhouse';
const ClubhouseIface = loadInterfaceXML('com.hack_computer.Clubhouse');

// Some button labels are replaced by customized icons if they match a
// unicode emoji character, as per Design request.
const CLUBHOUSE_ICONS_FOR_EMOJI = {
    '❯': 'clubhouse-notification-button-next-symbolic.svg',
    '❮': 'clubhouse-notification-button-previous-symbolic.svg',
    '👍': 'clubhouse-thumbsup-symbolic.svg',
    '👎': 'clubhouse-thumbsdown-symbolic.svg',
};

function getClubhouseApp(clubhouseId = 'com.hack_computer.Clubhouse') {
    return Shell.AppSystem.get_default().lookup_app(`${clubhouseId}.desktop`);
}

var ClubhouseAnimation = class ClubhouseAnimation extends Animation {
    constructor(file, width, height, defaultDelay, frames) {
        let speed = defaultDelay || 200;
        super(file, width, height, speed);

        if (frames)
            this.setFramesInfo(this._parseFrames(frames));
    }

    _getCurrentDelay() {
        let delay = super._getCurrentDelay();
        if (typeof delay === 'string') {
            let [delayA, delayB] = delay.split('-');
            return GLib.random_int_range(parseInt(delayA), parseInt(delayB));
        }
        return delay;
    }

    _parseFrame(frame) {
        if (typeof frame === 'string') {
            let [frameIndex, frameDelay] = frame.split(' ');
            frameIndex = parseInt(frameIndex);

            if (frameDelay.indexOf('-') == -1)
                frameDelay = parseInt(frameDelay);

            return [frameIndex, frameDelay];
        }
        return [frame, this._speed];
    }

    _parseFrames(frames) {
        let framesInfo = [];
        for (let frameInfo of frames) {
            let [frameIndex, frameDelay] = this._parseFrame(frameInfo);
            framesInfo.push({ 'frameIndex': frameIndex, 'frameDelay': frameDelay });
        }
        return framesInfo;
    }
};

var ClubhouseAnimator = class ClubhouseAnimator {
    constructor(proxy, clubhouseId) {
        this._proxy = proxy;
        this._animations = {};
        this._clubhouseId = clubhouseId;
        this._clubhousePaths = this._getClubhousePaths();
    }

    _getClubhousePaths() {
        let paths = [];
        let installations = [];

        try {
            installations = Flatpak.get_system_installations(null);
        } catch (err) {
            logError(err, 'Error while getting Flatpak system installations');
        }

        let userInstallation = null;
        try {
            userInstallation = Flatpak.Installation.new_user(null);
        } catch (err) {
            logError(err, 'Error while getting Flatpak user installation');
        }

        if (userInstallation)
            installations.unshift(userInstallation);

        for (let installation of installations) {
            let app = null;
            try {
                app = installation.get_current_installed_app(this._clubhouseId, null);
            } catch (err) {
                if (!err.matches(Flatpak.Error, Flatpak.Error.NOT_INSTALLED))
                    logError(err, 'Error while getting installed %s'.format(this._clubhouseId));

                continue;
            }

            if (app) {
                let deployDir = app.get_deploy_dir();
                paths.push(this._getActivateDir(deployDir));
            }
        }

        return paths;
    }

    _getActivateDir(deployDir) {
        // Replace the hash part of the deploy directory by "active", so the directory
        // is always the most recent one (i.e. allows us to update the Clubhouse and
        // still have the right dir).
        let dir = deployDir.substr(-1) == '/' ? deployDir.slice(0, -1) : deployDir;
        let splitDir = dir.split('/');

        splitDir[splitDir.length - 1] = 'active';

        return splitDir.join('/');
    }

    _getClubhousePath(path, retry = true) {
        // Discard the /app/ prefix
        let pathSuffix = path.replace(/^\/app\//g, '');

        for (let path of this._clubhousePaths) {
            let completePath = GLib.build_filenamev([path, 'files', pathSuffix]);
            if (GLib.file_test(completePath, GLib.FileTest.EXISTS))
                return completePath;
        }

        // retrying reloading clubhouse paths
        if (retry) {
            this._clubhousePaths = this._getClubhousePaths();
            return this._getClubhousePath(path, false);
        }

        return null;
    }

    _loadAnimationByPath(path, callback) {
        let metadata = this._animations[path];
        if (metadata) {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                callback(metadata);
                return GLib.SOURCE_REMOVE;
            });

            return;
        }

        this._proxy.getAnimationMetadataRemote(path, (results, err) => {
            if (err) {
                logError(err, 'Error getting animation metadata json');
                callback(null);
                return;
            }

            let [metadataVariant] = results;
            let jsonData = Json.gvariant_serialize(metadataVariant);
            let jsonStr = Json.to_string(jsonData, false);
            let metadata = JSON.parse(jsonStr);
            this._animations[path] = metadata;

            callback(metadata);
        });
    }

    clearCache() {
        this._animations = {};
    }

    getAnimation(path, callback) {
        this._loadAnimationByPath(path, (metadata) => {
            if (!metadata) {
                callback(null);
                return;
            }

            let realPath = this._getClubhousePath(path);
            let animation = new ClubhouseAnimation(Gio.File.new_for_path(realPath),
                metadata.width,
                metadata.height,
                metadata['default-delay'],
                metadata.frames);
            callback(animation);
        });
    }
};

var ClubhouseNotificationBanner =
class ClubhouseNotificationBanner extends MessageTray.NotificationBanner {
    constructor(notification) {
        super(notification);

        this.setUseBodyMarkup(true);
        this.setUseBodySimpleMarkup(false);

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
        this._closeButton.add_style_class_name('clubhouse-notification-close-button');

        // Always wrap the body's text
        this._expandedLabel.actor.add_style_class_name('clubhouse-notification-label');

        this._rearrangeElements();

        this._closeButton.connect('clicked', () => {
            SoundServer.getDefault().play('clubhouse/dialog/close');
        });
    }

    setBody(text) {
        // if the pagination is not initialized we do the initialization here
        // this method will be called again by _setNextPage() with the first page
        if (!this._paginationReady) {
            super.setBody('');
            this._splitTextInPages(text);
            this._paginationReady = true;
        } else {
            super.setBody(text);
        }
    }

    setIcon(actor) {
        actor.add_style_class_name('clubhouse-notification-image');
        super.setIcon(actor);
    }

    _rearrangeElements() {
        // This overrides the custom layout manager that provokes
        // size/allocation issues:
        this._bodyStack.layout_manager = new Clutter.FixedLayout();

        let contentBox = this._bodyStack.get_parent();
        contentBox.add_style_class_name('clubhouse-content-box');
        let hbox = contentBox.get_parent();
        let vbox = hbox.get_parent();

        let wrapBin = new St.Bin({
            x_fill: true,
            y_fill: true,
            x_align: St.Align.END,
            y_align: St.Align.END,
            x_expand: true,
            y_expand: true,
        });
        hbox.add_child(wrapBin);

        // A Clutter.BinLayout is used to rearrange the notification
        // elements in layers:
        let wrapWidget = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.END,
        });
        wrapBin.set_child(wrapWidget);

        let bodyStackParams = {
            y_expand: true,
            y_fill: true,
            y_align: Clutter.ActorAlign.FILL,
        };
        Object.assign(this._bodyStack, bodyStackParams);

        let iconBinParams = {
            x_fill: false,
            y_fill: false,
            x_expand: true,
            y_expand: true,
            x_align: St.Align.END,
            y_align: St.Align.END,
        };
        Object.assign(this._iconBin, iconBinParams);

        let contentBoxParams = {
            x_expand: true,
            y_expand: true,
            y_fill: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.END,
        };
        Object.assign(contentBox, contentBoxParams);

        let actionBinParams = {
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.END,
        };
        Object.assign(this._actionBin, actionBinParams);

        let expandedLabelActorParams = {
            y_expand: true,
            y_fill: true,
            y_align: Clutter.ActorAlign.FILL
        };
        Object.assign(this._expandedLabel.actor, expandedLabelActorParams);
        this._expandedLabel.actor.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._expandedLabel.actor.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        hbox.remove_child(contentBox);
        wrapWidget.add_child(contentBox);

        hbox.remove_child(this._iconBin);
        wrapWidget.add_child(this._iconBin);

        vbox.remove_child(this._actionBin);
        wrapWidget.add_child(this._actionBin);
    }

    // Override the callback that changes the button opacity on hover:
    _sync() {
        this._closeButton.opacity = 255;
    }

    _updateButtonsCss() {
        if (!this._buttonBox)
            return;

        // @todo: This is a workaround for the missing CSS selector, :nth-child
        // Upstream issue: https://gitlab.gnome.org/GNOME/gnome-shell/issues/1800
        this._buttonBox.get_children().forEach((button, index) => {
            const nth_class = 'child-' + (index + 1);
            const class_list = button.get_style_class_name();
            if (class_list.match(/child-[0-9]*/))
                button.set_style_class_name(class_list.replace(/child-[0-9]*/, nth_class));
            else
                button.set_style_class_name(class_list + ' ' + nth_class);
        });
    }

    _addActions() {
        // Only set up the actions if we're showing the last page of text
        if (!this._inLastPage())
            return;

        super._addActions();
        this._updateButtonsCss();
    }

    // Override this method because we don't want the button
    // horizontally expanded:
    addButton(button, callback) {
        if (Object.keys(CLUBHOUSE_ICONS_FOR_EMOJI).includes(button.label)) {
            let icon = CLUBHOUSE_ICONS_FOR_EMOJI[button.label];
            let iconUrl = `file://${Hack.path}/data/icons/${icon}`;
            button.label = '';

            button.add_style_class_name('icon-button');
            let iconFile = Gio.File.new_for_uri(iconUrl);
            let gicon = new Gio.FileIcon({ file: iconFile });
            button.child = new St.Icon({ gicon: gicon });
        } else {
            button.add_style_class_name('text-button');
        }

        button.set_x_expand(false);
        super.addButton(button, callback);
    }

    _splitTextInPages(fulltext) {
        this._textIdx = -1;
        // @todo: Ensure that paragraphs longer than 5 lines (in the banner) is also split up
        this._textPages = fulltext.split('\n\n');
    }

    reposition() {
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        let margin = 30;

        this.actor.x = monitor.x + monitor.width;

        let endX = this.actor.x - this.actor.width - margin;

        if (this._shouldSlideIn) {
            // If the banner is still sliding in, stop it (because we have a new position for it).
            // This should prevent the banner from not being set in the right position when the
            // Clubhouse is hidden while the banner is still sliding in.
            this.actor.remove_all_transitions();

            // clipping the actor to avoid appearing in the right monitor
            let endClip = new Clutter.Geometry({
                x: 0,
                y: 0,
                width: this.actor.width + margin,
                height: this.actor.height,
            });
            this.actor.set_clip(0, 0, 0, this.actor.height);

            this.actor.ease({
                x: endX,
                duration: CLUBHOUSE_BANNER_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this._shouldSlideIn = false,
            });
            this.actor.ease_property('clip', endClip, {
                duration: CLUBHOUSE_BANNER_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this.actor.remove_clip(),
            });
        } else {
            this.actor.x = endX;
        }

        this.actor.y = margin;
    }

    _onClicked() {
        // Do nothing because we don't want to activate the Clubhouse ATM
    }

    _setNextPage() {
        if (this._inLastPage())
            return;

        this.setBody(this._textPages[++this._textIdx]);
        if (this._inLastPage())
            this._addActions();
    }

    _inLastPage() {
        return this._textIdx == this._textPages.length - 1;
    }

    _setupNextPageButton() {
        let button = new Soundable.Button({
            style_class: 'notification-button',
            label: '❯',
            can_focus: true,
            click_sound_event_id: 'clubhouse/dialog/next',
        });

        this.addButton(button, () => {
            this._setNextPage();

            if (this._inLastPage()) {
                button.destroy();
                this._updateButtonsCss();
            }
        });

        this._updateButtonsCss();
    }

    _slideOut() {
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) {
            this.actor.destroy();
            this.actor = null;
            return;
        }

        let margin = 30;
        let endX = monitor.x + monitor.width;

        // clipping the actor to avoid appearing in the right monitor
        let endClip = new Clutter.Geometry({
            x: 0,
            y: 0,
            width: 0,
            height: this.actor.height,
        });
        this.actor.set_clip(0, 0, this.actor.width + margin, this.actor.height);

        this.actor.ease({
            x: endX,
            clip: endClip,
            duration: CLUBHOUSE_BANNER_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this.actor.destroy();
                this.actor = null;
            },
        });
        this.actor.ease_property('clip', endClip, {
            duration: CLUBHOUSE_BANNER_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    dismiss(shouldSlideOut) {
        if (!this.actor)
            return;

        if (shouldSlideOut) {
            this._slideOut();
            return;
        }

        this.actor.destroy();
        this.actor = null;
    }
};

var ClubhouseQuestBanner =
class ClubhouseQuestBanner extends ClubhouseNotificationBanner {
    constructor(notification, isFirstBanner, animator) {
        let icon = notification.gicon;
        let imagePath = null;

        if (icon instanceof Gio.FileIcon) {
            let file = icon.get_file();
            imagePath = file.get_path();
            notification.gicon = null;
        }

        super(notification);
        this._shouldSlideIn = isFirstBanner;

        this._closeButton.visible = notification.urgency !== MessageTray.Urgency.CRITICAL;

        if (imagePath) {
            animator.getAnimation(imagePath, (animation) => {
                if (!animation)
                    return;

                animation.play();
                this.setIcon(animation.actor);
            });
        }
    }
};

var ClubhouseItemBanner =
class ClubhouseItemBanner extends ClubhouseNotificationBanner {
    constructor(notification) {
        super(notification);
        this.actor.add_style_class_name('clubhouse-item-notification');
        this._topBanner = null;
    }

    setTopBanner(topBanner) {
        this._topBanner = topBanner;
        this.reposition();
    }

    reposition() {
        super.reposition();

        if (this._topBanner && this._topBanner.actor)
            this.actor.y += this._topBanner.actor.height;
    }
};

var ClubhouseNotification =
class ClubhouseNotification extends NotificationDaemon.GtkNotificationDaemonNotification {
    constructor(source, notification) {
        super(source, notification);

        this.notificationId = notification.notificationId.unpack();

        // Avoid destroying the notification when clicking it
        this.setResident(true);
    }

    createBanner(isFirstBanner, animator) {
        return new ClubhouseQuestBanner(this, isFirstBanner, animator);
    }
};

var ClubhouseItemNotification =
class ClubhouseItemNotification extends ClubhouseNotification {
    constructor(source, notification) {
        super(source, notification);
        this.setResident(false);
    }

    createBanner() {
        return new ClubhouseItemBanner(this);
    }
};

var ClubhouseNotificationSource =
class ClubhouseNotificationSource extends NotificationDaemon.GtkNotificationDaemonAppSource {
    _createNotification(params) {
        let notificationId = params.notificationId.unpack();

        if (notificationId == 'quest-item')
            return new ClubhouseItemNotification(this, params);

        return new ClubhouseNotification(this, params);
    }

    activateAction(actionId, target) {
        // Never show the overview when calling an action on this source.
        this.activateActionFull(actionId, target, false);
    }
};

var Component = GObject.registerClass({
}, class ClubhouseComponent extends SideComponent.SideComponent {
    _init(clubhouseIface, clubhouseId, clubhousePath) {
        this._clubhouseId = clubhouseId || 'com.hack_computer.Clubhouse';
        this._clubhouseIface = clubhouseIface || ClubhouseIface;
        this._clubhousePath = clubhousePath || CLUBHOUSE_DBUS_OBJ_PATH;

        super._init(this._clubhouseIface, this._clubhouseId, this._clubhousePath);

        Settings.connect('changed::hack-mode-enabled', () => {
            let activated = Settings.get_boolean('hack-mode-enabled');
            // Only enable if clubhouse app is installed
            activated = activated && !!this.getClubhouseApp();

            if (activated)
                this.enable();
            else
                this.disable();
        });

        this._enabled = false;
        this._hasForegroundQuest = false;

        this._questBanner = null;
        this._itemBanner = null;
        this._clubhouseSource = null;
        this._clubhouseProxyHandler = 0;

        this._clubhouseAnimator = null;

        this.proxyConstructFlags = Gio.DBusProxyFlags.NONE;

        this._overrideAddNotification();
    }

    get _useClubhouse() {
        return this._imageUsesClubhouse() && !!this.getClubhouseApp();
    }

    getClubhouseApp() {
        return getClubhouseApp(this._clubhouseId);
    }

    _ensureProxy() {
        if (this.proxy)
            return this.proxy;

        const clubhouseInstalled = !!this.getClubhouseApp();
        if (!clubhouseInstalled) {
            log('Cannot construct Clubhouse proxy because Clubhouse app was not found.');
        } else {
            try {
                this.proxy = new Gio.DBusProxy({
                    g_connection: Gio.DBus.session,
                    g_interface_name: this._proxyInfo.name,
                    g_interface_info: this._proxyInfo,
                    g_name: this._proxyName,
                    g_object_path: this._proxyPath,
                    g_flags: this.proxyConstructFlags,
                });
                this.proxy.init(null);
                return this.proxy;
            } catch (e) {
                logError(e, `Error while constructing the DBus proxy for ${this._proxyName}`);
            }
        }
        return null;
    }

    enable() {
        if (!this._useClubhouse) {
            log('Cannot enable Clubhouse in this image version');
            return;
        }

        super.enable();

        if (this._clubhouseProxyHandler == 0) {
            this._clubhouseProxyHandler = this.proxy.connect('notify::g-name-owner', () => {
                if (!this.proxy.g_name_owner) {
                    log('Nothing owning D-Bus name %s, so dismiss the Clubhouse banner'.format(this._clubhouseId));
                    this._clearQuestBanner();

                    // Clear the animator cache, so we reload the metadata files the next time
                    // an animation is used, thus accounting for an eventual Clubhouse update
                    // in the meantime which may bring metadata changes for the animations.
                    if (this._clubhouseAnimator != null)
                        this._clubhouseAnimator.clearCache();
                }
            });

            this._clubhouseAnimator = new ClubhouseAnimator(this.proxy, this._clubhouseId);
        }

        this._enabled = true;
        this._syncVisibility();
    }

    disable() {
        super.disable();

        this._enabled = false;
        this._syncVisibility();
    }

    callShow(timestamp) {
        if (this._ensureProxy() && this.proxy.g_name_owner) {
            this.proxy.showRemote(timestamp);
            return;
        }

        // We only activate the app here if it's not yet running, otherwise the cursor will turn
        // into a spinner for a while, even after the window is shown.
        // @todo: Call activate alone when we fix the problem mentioned above.
        this.getClubhouseApp().activate();
    }

    callHide(timestamp) {
        this.proxy.hideRemote(timestamp);
    }

    _getClubhouseSource() {
        if (this._clubhouseSource != null)
            return this._clubhouseSource;

        this._clubhouseSource = new ClubhouseNotificationSource(this._clubhouseId);
        this._clubhouseSource.connect('notify', this._onNotify.bind(this));
        this._clubhouseSource.connect('destroy', () => {
            this._clubhouseSource = null;
        });

        return this._clubhouseSource;
    }

    _syncBanners() {
        if (this._itemBanner)
            this._itemBanner.setTopBanner(this._questBanner);
    }

    _clearQuestBanner() {
        if (!this._questBanner)
            return;

        this._questBanner.dismiss(!this._hasForegroundQuest);

        this._questBanner = null;

        this._syncBanners();
    }

    _clearItemBanner() {
        if (!this._itemBanner)
            return;

        this._itemBanner.dismiss(true);
        this._itemBanner = null;
    }

    _imageUsesClubhouse() {
        return Settings.get_boolean('hack-mode-enabled');
    }

    _overrideAddNotification() {
        let oldAddNotificationFunc = GtkNotificationDaemon.prototype.AddNotificationAsync;
        GtkNotificationDaemon.prototype.AddNotificationAsync = (params, invocation) => {
            let [appId, notificationId, notification] = params;

            // If the app sending the notification is the Clubhouse, then use our own source
            if (appId === this._clubhouseId) {
                notification['notificationId'] = new GLib.Variant('s', notificationId);
                this._getClubhouseSource().addNotification(notificationId, notification, true);
                invocation.return_value(null);
                return;
            }

            oldAddNotificationFunc.apply(Main.notificationDaemon._gtkNotificationDaemon,
                [params, invocation]);
        };

        let oldRemoveNotificationFunc = GtkNotificationDaemon.prototype.RemoveNotificationAsync;
        GtkNotificationDaemon.prototype.RemoveNotificationAsync = (params, invocation) => {
            let [appId, notificationId] = params;

            // If the app sending the notification is the Clubhouse, then use our own source
            if (appId === this._clubhouseId) {
                this._getClubhouseSource().removeNotification(notificationId);
                invocation.return_value(null);
                return;
            }

            oldRemoveNotificationFunc.apply(Main.notificationDaemon._gtkNotificationDaemon,
                [params, invocation]);
        };

    }

    _onNotify(source, notification) {
        // @todo: Abstract the banner logic into the notifications themselves as much as possible
        // (to just keep track of when they're destroyed).
        if (notification.notificationId == 'quest-message') {
            notification.connect('destroy', (notification, reason) => {
                if (reason != MessageTray.NotificationDestroyedReason.REPLACED &&
                    reason != MessageTray.NotificationDestroyedReason.SOURCE_CLOSED)
                    this._dismissQuestBanner(notification.source);

                this._clearQuestBanner();
            });

            if (!this._questBanner) {
                this._questBanner = notification.createBanner(!this._hasForegroundQuest,
                    this._clubhouseAnimator);
                this._hasForegroundQuest = true;

                Main.layoutManager.addChrome(this._questBanner.actor);
                this._questBanner.reposition();
            }
        } else if (notification.notificationId == 'quest-item') {
            notification.connect('destroy', (_notification, _reason) => {
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
    }

    _dismissQuestBanner(source) {
        // Inform the Clubhouse that the quest banner has been dismissed
        if (this.proxy.g_name_owner)
            source.activateAction('quest-view-close', null);

        this._hasForegroundQuest = false;
    }

    _onProxyConstructed(object, res) {
        super._onProxyConstructed(object, res);

        // Check if the old HackComponents flatpak is installed, in that case,
        // this is an old hack computer so we can launch the migration Quest.
        // The new clubhouse will do the check and will only launch the quest once,
        // so we can do the call every time.
        const hackComponents = Gio.File.new_for_uri('file:///var/lib/flatpak/app/com.endlessm.HackComponents');
        if (hackComponents.query_exists(null)) {
            this.proxy.call('migrationQuest', null, Gio.DBusCallFlags.NONE, -1, null, (source, result) => {
                try {
                    this.proxy.call_finish(result);
                } catch (err) {
                    logError(err, 'Error running the migrationQuest in clubhouse');
                }
            });
        }
    }

    _syncVisibility() {
        if (this._questBanner)
            this._questBanner.actor.visible = this._enabled;

        if (this._itemBanner)
            this._itemBanner.actor.visible = this._enabled;
    }
});

var CLUBHOUSE = null;

// TODO:
//  * messageList.js: add notification text markup
//  * animation.js
//  * notificationDaemon.js
//  * sideComponent.js

function enable() {
    CLUBHOUSE = new Component();

    if (CLUBHOUSE)
        CLUBHOUSE.enable();
}

function disable() {
    if (CLUBHOUSE) {
        CLUBHOUSE.disable();
        delete CLUBHOUSE;
    }
}
