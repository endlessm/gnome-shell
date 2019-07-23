// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const { Clutter, Gio, GLib, GObject, St } = imports.gi;

const Lang = imports.lang;
const Main = imports.ui.main;
const Clubhouse = imports.ui.components.clubhouse;

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
    const clubhouseInstalled = !!Clubhouse.getClubhouseApp();

    return isEnabled && !clubhouseInstalled;
}

function _checkIfClubhouseEnabled() {
    return !!Clubhouse.getClubhouseApp();
}

function maybeCreateButton() {
    if (_checkIfDiscoveryFeedEnabled())
        return new DiscoveryFeedButton();
    else if (_checkIfClubhouseEnabled()) {
        const component = Main.componentManager._ensureComponent('clubhouse');
        if (component)
            return new DiscoveryFeedClubhouseButton(component);
    }

    return null;
}


var DiscoveryFeedButtonBase = GObject.registerClass(
class DiscoveryFeedButtonBase extends St.BoxLayout {
    _init(params={}) {
        if (!params.visible)
            params.visible = this.constructor._primaryMonitorWidthPassesThreshold();
        super._init(params);

        Main.layoutManager.connect('monitors-changed', () => {
            this.visible = this.constructor._primaryMonitorWidthPassesThreshold();
        });
    }

    static _primaryMonitorWidthPassesThreshold() {
        return Main.layoutManager.primaryMonitor.width >= DISCOVERY_FEED_PRIMARY_MONITOR_WIDTH_THRESHOLD;
    }

    changeVisbilityState(value) {
        // Helper function to ensure that visibility is set correctly,
        // consumers of this button should use this function as opposed
        // to mutating 'visible' directly, since it prevents the
        // button from appearing in cases where it should not.
        this.visible = value && this.constructor._primaryMonitorWidthPassesThreshold();
    }

    determineAllocationWithinBox(box, availWidth) {
        // If we would not show the feed button because the monitor
        // is too small, just return box directly
        if (!this.constructor._primaryMonitorWidthPassesThreshold())
          return box;

        let discoveryFeedButtonHeight = this.get_preferred_height(availWidth)[1];
        let discoveryFeedButtonBox = box.copy();
        let x1 = (availWidth - this.get_width()) * 0.5;
        discoveryFeedButtonBox.y1 = 0;
        discoveryFeedButtonBox.y2 = discoveryFeedButtonBox.y1 + discoveryFeedButtonHeight;
        discoveryFeedButtonBox.x1 = x1;
        discoveryFeedButtonBox.x2 = x1 + this.get_width();
        return discoveryFeedButtonBox;
    }
});

/** DiscoveryFeedButton:
 *
 * This class handles the button to launch the discovery feed application
 */
var DiscoveryFeedButton = GObject.registerClass(
class DiscoveryFeedButton extends DiscoveryFeedButtonBase {
    _init() {
        super._init({ vertical: true});

        this._bar = new St.Button({ name: 'discovery-feed-bar',
                                    child: new St.Icon({ style_class: 'discovery-feed-bar-icon' }),
                                    style_class: 'discovery-feed-bar' });
        this.add(this._bar);

        this._tile = new St.Button({ name: 'discovery-feed-tile',
                                     child: new St.Icon({ style_class: 'discovery-feed-tile-icon' }),
                                     style_class: 'discovery-feed-tile' });
        this.add(this._tile, { x_fill: false,
                               x_align: St.Align.MIDDLE,
                               expand: true });

        this._bar.connect('clicked', () => {
            Main.discoveryFeed.show(global.get_current_time());
        });
        this._tile.connect('clicked', () => {
            Main.discoveryFeed.show(global.get_current_time());
        });

        this._bar.connect('notify::hover', Lang.bind(this, this._onHoverChanged));
        this._tile.connect('notify::hover', Lang.bind(this, this._onHoverChanged));
    }

    _onHoverChanged(actor) {
        if (actor.get_hover()) {
            this._bar.child.add_style_pseudo_class('highlighted');
            this._tile.child.add_style_pseudo_class('highlighted');
        } else {
            this._bar.child.remove_style_pseudo_class('highlighted');
            this._tile.child.remove_style_pseudo_class('highlighted');
        }
     }
});


var DiscoveryFeedClubhouseButton = GObject.registerClass(
class DiscoveryFeedClubhouseButton extends DiscoveryFeedButtonBase {
    _init(clubhouseComponent) {
        super._init();
        const button = clubhouseComponent._clubhouseButtonManager._openButton;
        this.add(button);
    }

    determineAllocationWithinBox(box, availWidth) {
        if (!this.constructor._primaryMonitorWidthPassesThreshold())
          return box;

        let discoveryFeedButtonHeight = this.get_preferred_height(availWidth)[1];
        let discoveryFeedButtonBox = box.copy();
        let x1 = (availWidth - this.get_width()) * 0.5;
        discoveryFeedButtonBox.y1 = discoveryFeedButtonBox.y1 - discoveryFeedButtonHeight / 2;
        discoveryFeedButtonBox.y2 = discoveryFeedButtonBox.y1 + discoveryFeedButtonHeight;
        discoveryFeedButtonBox.x1 = x1;
        discoveryFeedButtonBox.x2 = x1 + this.get_width();
        return discoveryFeedButtonBox;
    }

});
