// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const { Clutter, Gio, GLib, GObject, St } = imports.gi;

const Lang = imports.lang;
const Main = imports.ui.main;

function createInactiveButton() {
    let discoveryFeed = new DiscoveryFeedButton();
    discoveryFeed.reactive = false;
    return discoveryFeed;
}

const DISCOVERY_FEED_PRIMARY_MONITOR_WIDTH_THRESHOLD = 1024;

function _primaryMonitorWidthPassesThreshold() {
    return Main.layoutManager.primaryMonitor.width >= DISCOVERY_FEED_PRIMARY_MONITOR_WIDTH_THRESHOLD;
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

        this._hasDiscoveryFeed = this._isDiscoveryFeedEnabled();

        this._bar.connect('clicked', () => {
            this._launchTopComponent();
        });
        this._tile.connect('clicked', () => {
            this._launchTopComponent();
        });

        global.settings.connect('changed::hack-mode-enabled', () => { this._updateVisibility(); })

        this._bar.connect('notify::hover', Lang.bind(this, this._onHoverChanged));
        this._tile.connect('notify::hover', Lang.bind(this, this._onHoverChanged));

        Main.layoutManager.connect('monitors-changed', () => {
            this._updateVisibility();
        });
    }

    _launchTopComponent() {
        if (this._isHackModeEnabled())
            Main.clubhouse.show(global.get_current_time());
        else
            Main.discoveryFeed.show(global.get_current_time());
    }

    _updateVisibility() {
        this.visible = (this._hasDiscoveryFeed || this._isHackModeEnabled()) &&
            _primaryMonitorWidthPassesThreshold();
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

    _isHackModeEnabled() {
        return global.settings.get_boolean('hack-mode-enabled');
    }

    changeVisbilityState(value) {
        // Helper function to ensure that visibility is set correctly,
        // consumers of this button should use this function as opposed
        // to mutating 'visible' directly, since it prevents the
        // button from appearing in cases where it should not.
        this.visible = value && _primaryMonitorWidthPassesThreshold();
    }

    _isDiscoveryFeedEnabled() {
        let supportedLanguages = global.settings.get_value('discovery-feed-languages').deep_unpack();
        let systemLanguages = GLib.get_language_names();

        let isEnabled = supportedLanguages.some(function(lang) {
            return systemLanguages.indexOf(lang) !== -1;
        });

        return isEnabled;
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
