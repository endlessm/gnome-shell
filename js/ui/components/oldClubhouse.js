// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
//
// Copyright (C) 2019 Endless Mobile, Inc.
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
// Author: Daniel Garcia <daniel@endlessm.com>
//

const {Gio, GObject, Meta, Shell, St} = imports.gi;
const Animation = imports.ui.animation.Animation;
const Clubhouse = imports.ui.components.clubhouse;
const Main = imports.ui.main;
const Soundable = imports.ui.soundable;
const SoundServer = imports.misc.soundServer;

const { loadInterfaceXML } = imports.misc.fileUtils;

const SHELL_KEYBINDINGS_SCHEMA = 'org.gnome.shell.keybindings';

const CLUBHOUSE_BUTTON_SIZE = 110;
const CLUBHOUSE_BUTTON_PULSE_SPEED = 100; // ms

const CLUBHOUSE_ID = 'com.endlessm.Clubhouse';
const CLUBHOUSE_DBUS_OBJ_PATH = '/com/endlessm/Clubhouse';
const ClubhouseIface = loadInterfaceXML('com.endlessm.Clubhouse');

var ClubhouseWindowTracker = GObject.registerClass({
    Signals: {
        'window-changed': {},
    },
}, class ClubhouseWindowTracker extends GObject.Object {
    _init() {
        super._init();

        this._windowActor = null;

        // If the Clubhouse is open and the Shell is restarted, then global.get_window_actors()
        // will still not have any contents when components are initialized, and there's no "map"
        // signal emitted from the Window Manager either. So instead of relying on the map signal
        // (which would allow us to track windows individually instead of always having to check the
        // current list of windows) we connect to the screen's "restacked" signal.
        global.display.connect('restacked', this._trackWindowActor.bind(this));

        Main.overview.connect('showing', () => {
            this.emit('window-changed');
        });
        Main.overview.connect('hidden', () => {
            this.emit('window-changed');
        });
        Main.sessionMode.connect('updated', () => this.emit('window-changed'));
    }

    _getClubhouseActorFromWM() {
        return global.get_window_actors().find((actor) => {
            return (actor.meta_window.get_gtk_application_id() === CLUBHOUSE_ID &&
                    actor.meta_window.get_role() === 'eos-side-component');
        });
    }

    _trackWindowActor() {
        const actor = this._getClubhouseActorFromWM();
        if (!actor)
            return;

        if (this._windowActor === actor)
            return;

        // Reset the current window actor
        this._untrackWindowActor();

        this._windowActor = actor;

        this.emit('window-changed');

        // Track Clubhouse's window actor to make the closeButton always show on top of
        // the Clubhouse's window edge
        this._notifyHandler = actor.connect('notify::x', () => this.emit('window-changed'));

        this._destroyHandler = actor.connect('destroy', () => {
            this._untrackWindowActor();
            this.emit('window-changed');
        });
    }

    _untrackWindowActor() {
        if (!this._windowActor)
            return;

        // Reset the current window actor
        this._windowActor.disconnect(this._notifyHandler);
        this._notifyHandler = 0;

        this._windowActor.disconnect(this._destroyHandler);
        this._destroyHandler = 0;

        this._windowActor = null;
    }

    getWindowX() {
        if (!Main.sessionMode.hasOverview || Main.overview.visible || this._windowActor === null)
            return -1;
        return this._windowActor.x;
    }
});

var getClubhouseWindowTracker = (function() {
    let clubhouseWindowTracker;
    return function() {
        if (!clubhouseWindowTracker)
            clubhouseWindowTracker = new ClubhouseWindowTracker();
        return clubhouseWindowTracker;
    };
}());

var ClubhouseOpenButton = GObject.registerClass(
class ClubhouseOpenButton extends Soundable.Button {
    _init(params) {
        params = params || {};
        let gfile =
            Gio.File.new_for_uri('resource:///org/gnome/shell/theme/clubhouse-icon-pulse.png');
        this._pulseAnimation = new Animation(gfile,
                                             CLUBHOUSE_BUTTON_SIZE,
                                             CLUBHOUSE_BUTTON_SIZE,
                                             CLUBHOUSE_BUTTON_PULSE_SPEED);
        this._pulseIcon = this._pulseAnimation.actor;

        this._normalIcon = new St.Icon({ style_class: 'clubhouse-open-button-icon' });

        params.child = this._normalIcon;
        params.click_sound_event_id = 'clubhouse/entry/open';
        params.hover_sound_event_id = 'clubhouse/entry/hover';
        params.stop_hover_sound_on_click = true;
        super._init(params);

        this._highlightSoundItem = new SoundServer.SoundItem('clubhouse/entry/pulse');
        this._highlightLoopingSoundItem =
            new SoundServer.SoundItem('clubhouse/entry/pulse-loop');
    }

    setHighlighted(highlighted) {
        if (highlighted) {
            this.child = this._pulseIcon;
            this._pulseAnimation.play();
            this._highlightSoundItem.play();
            this._highlightLoopingSoundItem.play();
        } else {
            this.child = this._normalIcon;
            this._pulseAnimation.stop();
            this._highlightSoundItem.stop();
            this._highlightLoopingSoundItem.stop();
        }
    }
});

var ClubhouseButtonManager = GObject.registerClass({
    Signals: {
        'open-clubhouse': {},
        'close-clubhouse': {},
    },
}, class ClubhouseButtonManager extends GObject.Object {
    _init() {
        super._init();

        this._openButton = new ClubhouseOpenButton();
        this._openButton.connect('clicked', () => { this.emit('open-clubhouse'); });

        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._openButton.set_clip(0, 0,
                                  scaleFactor * CLUBHOUSE_BUTTON_SIZE / 2,
                                  scaleFactor * CLUBHOUSE_BUTTON_SIZE);

        Main.layoutManager.addChrome(this._openButton);

        this._closeButton = new Soundable.Button({
            child: new St.Icon({ style_class: 'clubhouse-close-button-icon' }),
            click_sound_event_id: 'clubhouse/entry/close'
        });
        this._closeButton.connect('clicked', () => { this.emit('close-clubhouse'); })

        Main.layoutManager.addChrome(this._closeButton);

        this._clubhouseWindowActor = null;
        this._clubhouseNotifyHandler = 0;

        this._visible = true;

        this._updateVisibility();

        this._updateVisibilityId = getClubhouseWindowTracker().connect('window-changed', this._updateVisibility.bind(this));
    }

    _updateCloseButtonPosition() {
        this._closeButton.y = this._openButton.y;

        let clubhouseWindowX = getClubhouseWindowTracker().getWindowX();
        if (clubhouseWindowX != -1)
            this._closeButton.x = clubhouseWindowX - this._closeButton.width / 2;

        Clubhouse.clipToMonitor(this._closeButton);
    }

    _reposition() {
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        let workarea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);

        this._openButton.x = monitor.x + monitor.width - this._openButton.width / 2;
        this._openButton.y = workarea.y + Math.floor(workarea.height / 2.0 - this._openButton.height / 2.0);

        this._updateCloseButtonPosition();
    }

    _updateVisibility() {
        this._closeButton.visible = this._visible && getClubhouseWindowTracker().getWindowX() != -1;
        this._openButton.visible = this._visible && Main.sessionMode.hasOverview && !this._closeButton.visible;
        this._reposition();
    }

    setSuggestOpen(suggestOpen) {
        if (this._openButton.visible)
            this._openButton.setHighlighted(suggestOpen);
    }

    setVisible(visible) {
        this._visible = visible;
        this._updateVisibility();
    }

    destroy() {
        if (this._updateVisibilityId)
            getClubhouseWindowTracker().disconnect(this._updateVisibilityId);
        this._closeButton.destroy();
        this._openButton.destroy();
    }
});

var Component = GObject.registerClass(
class OldClubhouseComponent extends Clubhouse.Component {
    _init() {
        // This is needed here to make it work the following check
        this._clubhouseId = CLUBHOUSE_ID;
        if (!this._useClubhouse)
            return;

        // Enable hack-mode if we've the old clubhouse and the hack-mode is
        // disabled because this should be activated to make it work, so hack
        // mode will be enabled by default for hack 1.0 users
        const activated = global.settings.get_boolean('hack-mode-enabled');
        if (!activated && this.getClubhouseApp())
            global.settings.set_boolean('hack-mode-enabled', true);

        super._init(ClubhouseIface, CLUBHOUSE_ID, CLUBHOUSE_DBUS_OBJ_PATH);
        this._clubhouseButtonManager = null;

        this._clubhouseButtonManager = new ClubhouseButtonManager();
        this._clubhouseButtonManager.connect('open-clubhouse', () => {
            this.show(global.get_current_time());
        });
        this._clubhouseButtonManager.connect('close-clubhouse', () => {
            this.hide(global.get_current_time());
        });
    }

    // Only enable the old clubhouse if the new clubhouse isn't installed
    _imageUsesClubhouse() {
        return !Clubhouse.getClubhouseApp();
    }

    // Override this because we need to make sure we only call a property on the proxy once
    // it's initialized.
    _onProxyConstructed(object, res) {
        super._onProxyConstructed(object, res);

        // Make sure the proxy didn't fail to initialize
        if (this.proxy.SuggestingOpen !== undefined && this._clubhouseButtonManager)
            this._clubhouseButtonManager.setSuggestOpen(!!this.proxy.SuggestingOpen);
    }

    _syncVisibility() {
        super._syncVisibility();
        if (this._clubhouseButtonManager)
            this._clubhouseButtonManager.setVisible(this._enabled);
    }
});
