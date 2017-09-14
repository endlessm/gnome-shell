// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const St = imports.gi.St;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const ViewSelector = imports.ui.viewSelector;

const EndlessButton = new Lang.Class({
    Name: 'EndlessButton',
    Extends: PanelMenu.SingleIconButton,

    _init: function() {
        this.parent(_("Endless Button"));
        this.actor.add_style_class_name('endless-button');
        this.actor.connect('notify::hover', Lang.bind(this, this._onHoverChanged));

        let iconFile = Gio.File.new_for_uri('resource:///org/gnome/shell/theme/endless-button-symbolic.svg');
        this.setIcon(new Gio.FileIcon({ file: iconFile }));

        this._setupTooltipText();
    },

    _setupTooltipText: function() {

        // Create a new tooltip label
        this._label = new St.Label({ style_class: 'app-icon-hover-label' });

        this._labelOffsetX = 0;
        this._labelOffsetY = 0;
        this._label.connect('style-changed', Lang.bind(this, function() {
            this._labelOffsetX = this._label.get_theme_node().get_length('-label-offset-x');
            this._labelOffsetY = this._label.get_theme_node().get_length('-label-offset-y');
        }));

        let pageChangedId = Main.overview.connect('page-changed', Lang.bind(this, this._onOverviewPageChanged));
        let showingId = Main.overview.connect('showing', Lang.bind(this, this._onOverviewShowing));
        let hidingId = Main.overview.connect('hiding', Lang.bind(this, this._onOverviewHiding));

        this.actor.connect('destroy', Lang.bind(this, function() {
            Main.overview.disconnect(pageChangedId);
            Main.overview.disconnect(showingId);
            Main.overview.disconnect(hidingId);
        }));

        this._updateHoverLabel(false);
    },

    _updateHoverLabel: function(hiding) {
        let viewSelector = Main.overview.viewSelector;
        let newText = _("Show Desktop");

        if (!hiding &&
            viewSelector &&
            viewSelector.getActivePage() === ViewSelector.ViewPage.APPS)
            newText = _("Show Apps");

        this._label.text = newText;
    },

    _onOverviewPageChanged: function() {
        this._updateHoverLabel(false);
    },

    _onOverviewShowing: function() {
        this._updateHoverLabel(false);
    },

    _onOverviewHiding: function() {
        this._updateHoverLabel(true);
    },

    // overrides default implementation from PanelMenu.Button
    _onEvent: function(actor, event) {
        if (this.menu &&
            (event.type() == Clutter.EventType.TOUCH_BEGIN ||
             event.type() == Clutter.EventType.BUTTON_PRESS)) {

            Main.overview.toggleApps();
        }

        return Clutter.EVENT_PROPAGATE;
    },

    _onHoverChanged: function() {
        if (!this._label)
            return;

        if (this.actor.hover) {
            if (this._label.get_parent())
                return;

            Main.uiGroup.add_actor(this._label);
            this._label.raise_top();

            // Update the tooltip position
            let monitor = Main.layoutManager.findMonitorForActor(this._label);
            let iconMidpoint = this.actor.get_transformed_position()[0] + this.actor.width / 2;
            this._label.translation_x = Math.floor(iconMidpoint - this._label.width / 2) + this._labelOffsetX;
            this._label.translation_y = Math.floor(this.actor.get_transformed_position()[1] - this._labelOffsetY);

            // Clip left edge to be the left edge of the screen
            this._label.translation_x = Math.max(this._label.translation_x, monitor.x + this._labelOffsetX);
        } else {
            // Remove the tooltip from uiGroup
            if (this._label.get_parent() != null)
                Main.uiGroup.remove_actor(this._label);
        }
    }
});
