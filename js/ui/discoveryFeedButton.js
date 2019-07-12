// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const { Clutter, Gio, GLib, GObject, St } = imports.gi;

const Animation = imports.ui.animation.Animation;
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

const DISCOVERY_FEED_TILE_WIDTH = 62;
const DISCOVERY_FEED_TILE_HEIGHT = 27;
const DISCOVERY_FEED_BAR_WIDTH = 1004;
const DISCOVERY_FEED_BAR_HEIGHT = 18;
const DISCOVERY_FEED_ANIMATION_SPEED = 100;

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
    if (_checkIfDiscoveryFeedEnabled())
        return new DiscoveryFeedButton();

    return null;
}

/** DiscoveryFeedButton:
 *
 * This class handles the button to launch the discovery feed application
 */
var DiscoveryFeedButton = GObject.registerClass(
class DiscoveryFeedButton extends St.BoxLayout {
    _init() {
        super._init({ vertical: true,
                      visible: _primaryMonitorWidthPassesThreshold() });

        this._barNormalIcon = new St.Icon({ style_class: 'discovery-feed-bar-icon' });
        this._bar = new St.Button({ name: 'discovery-feed-bar',
                                    child: this._barNormalIcon,
                                    style_class: 'discovery-feed-bar' });
        this.add(this._bar);

        this._tileNormalIcon = new St.Icon({ style_class: 'discovery-feed-tile-icon' });
        this._tile = new St.Button({ name: 'discovery-feed-tile',
                                     child: this._tileNormalIcon,
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

        Main.layoutManager.connect('monitors-changed', () => {
            this.visible = _primaryMonitorWidthPassesThreshold();
        });

        let gfile = Gio.File.new_for_uri('resource:///org/gnome/shell/theme/discovery-feed-tile-pulse.png');
        this._tilePulseAnimation = new Animation(gfile,
                                                 DISCOVERY_FEED_TILE_WIDTH,
                                                 DISCOVERY_FEED_TILE_HEIGHT,
                                                 DISCOVERY_FEED_ANIMATION_SPEED);
        this._tilePulseIcon = this._tilePulseAnimation.actor;

        gfile = Gio.File.new_for_uri('resource:///org/gnome/shell/theme/discovery-feed-bar-pulse.png');
        this._barPulseAnimation = new Animation(gfile,
                                                DISCOVERY_FEED_BAR_WIDTH,
                                                DISCOVERY_FEED_BAR_HEIGHT,
                                                DISCOVERY_FEED_ANIMATION_SPEED);
        this._barPulseIcon = this._barPulseAnimation.actor;
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

    setHighlighted(highlighted) {
        if (highlighted) {
            this._tile.child = this._tilePulseIcon;
            this._bar.child = this._barPulseIcon;
            this._tilePulseAnimation.play();
            this._barPulseAnimation.play();
        } else {
            this._barPulseAnimation.stop();
            this._tilePulseAnimation.stop();
            this._bar.child = this._barNormalIcon;
            this._tile.child = this._tileNormalIcon;
        }
    }

    changeVisbilityState(value) {
        // Helper function to ensure that visibility is set correctly,
        // consumers of this button should use this function as opposed
        // to mutating 'visible' directly, since it prevents the
        // button from appearing in cases where it should not.
        this.visible = value && _primaryMonitorWidthPassesThreshold();
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
