// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const St = imports.gi.St;

const Lang = imports.lang;
const Main = imports.ui.main;

function maybeCreateInactiveButton() {
    if (_checkIfDiscoveryFeedEnabled()) {
        let discoveryFeed = new DiscoveryFeedButton();
        discoveryFeed.reactive = false;
        return discoveryFeed;
    }

    return null;
}

function _checkIfDiscoveryFeedEnabled() {
    let supportedLanguages = global.settings.get_value('discovery-feed-languages').deep_unpack();
    let systemLanguages = GLib.get_language_names();

    let isEnabled = supportedLanguages.some(function(lang) {
        return systemLanguages.indexOf(lang) !== -1;
    });

    return isEnabled;
}

function maybeCreateButton() {
    if (_checkIfDiscoveryFeedEnabled()) {
        let discoveryFeedButton = new DiscoveryFeedButton();
        discoveryFeedButton.connect('clicked', Lang.bind(this, function() {
            Main.discoveryFeed.show(global.get_current_time());
        }));

        return discoveryFeedButton;
    }

    return null;
}

/** DiscoveryFeedButton:
 *
 * This class handles the button to launch the discovery feed application
 */
const DiscoveryFeedButton = new Lang.Class({
    Name: 'DiscoveryFeedButton',
    Extends: St.Button,

    _init: function() {
        let iconFile = Gio.File.new_for_uri('resource:///org/gnome/shell/theme/discovery-feed-open-tab.png');
        let gicon = new Gio.FileIcon({ file: iconFile });
        this._icon = new St.Icon({ gicon: gicon,
                                   style_class: 'discovery-feed-icon',
                                   track_hover: true });
        this.parent({ name: 'discovery-feed',
                      child: this._icon,
                      x_align: Clutter.ActorAlign.CENTER,
                      y_align: Clutter.ActorAlign.CENTER });
    }
});

function determineAllocationWithinBox(discoveryFeedButton, box, availWidth) {
    let discoveryFeedButtonHeight = discoveryFeedButton.get_preferred_height(availWidth)[1];
    let discoveryFeedButtonBox = box.copy();
    let x1 = (availWidth - discoveryFeedButton.get_width()) * 0.5;
    discoveryFeedButtonBox.y1 = 0;
    discoveryFeedButtonBox.y2 = discoveryFeedButtonBox.y1 + discoveryFeedButtonHeight;
    discoveryFeedButtonBox.x1 = x1;
    discoveryFeedButtonBox.x2 = x1 + discoveryFeedButton.get_width();
    return discoveryFeedButtonBox;
}
