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

const DISCOVERY_FEED_PRIMARY_MONITOR_WIDTH_THRESHOLD = 1024;

function _primaryMonitorWidthPassesThreshold() {
    return Main.layoutManager.primaryMonitor.width >= DISCOVERY_FEED_PRIMARY_MONITOR_WIDTH_THRESHOLD;
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
        this.parent({ name: 'discovery-feed',
                      style_class: 'discovery-feed-button',
                      x_align: Clutter.ActorAlign.CENTER,
                      y_align: Clutter.ActorAlign.CENTER,
                      visible: _primaryMonitorWidthPassesThreshold() });

        Main.layoutManager.connect('monitors-changed', Lang.bind(this, function() {
            this.visible = _primaryMonitorWidthPassesThreshold();
        }));
    }
});

function determineAllocationWithinBox(discoveryFeedButton, box, availWidth) {
    // If we would not show the feed button because the monitor
    // is too small, just return box directly
    if (!_primaryMonitorWidthPassesThreshold())
      return box;

    let discoveryFeedButtonHeight = discoveryFeedButton.get_preferred_height(availWidth)[1];
    let discoveryFeedButtonBox = box.copy();
    let x1 = (availWidth - discoveryFeedButton.get_width()) * 0.5;
    discoveryFeedButtonBox.y1 = 0;
    discoveryFeedButtonBox.y2 = discoveryFeedButtonBox.y1 + discoveryFeedButtonHeight;
    discoveryFeedButtonBox.x1 = x1;
    discoveryFeedButtonBox.x2 = x1 + discoveryFeedButton.get_width();
    return discoveryFeedButtonBox;
}
