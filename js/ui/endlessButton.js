// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const St = imports.gi.St;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;

const EndlessButton = new Lang.Class({
    Name: 'EndlessButton',
    Extends: PanelMenu.SingleIconButton,

    _init: function() {
        this.parent(_('Endless Button'));
        this.actor.add_style_class_name('endless-button');
        this.actor.connect('notify::hover', Lang.bind(this, this._onHoverChanged));

        let iconFile;
        iconFile = Gio.File.new_for_uri('resource:///org/gnome/shell/theme/endless-button-symbolic.svg');
        this._gicon = new Gio.FileIcon({ file: iconFile });

        this.setIcon(this._gicon);

        this._setupTooltipText();
    },

    _setupTooltipText: function() {

        // Create a new tooltip label
        this._label = new St.Label({ text: _("Show Desktop"),
                                     style_class: 'app-icon-hover-label' });

        this._labelOffsetY = 0;
        this._label.connect('style-changed', Lang.bind(this, function(actor, forHeight, alloc) {
            this._labelOffsetY = this._label.get_theme_node().get_length('-label-offset-y');
        }));
    },

    // overrides default implementation from PanelMenu.Button
    _onEvent: function(actor, event) {
        if (this.menu &&
            (event.type() == Clutter.EventType.TOUCH_BEGIN ||
             event.type() == Clutter.EventType.BUTTON_PRESS)) {

            Main.overview.toggle();
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
            let iconMidpoint = this.actor.get_transformed_position()[0] + this.actor.width / 2;
            this._label.translation_x = Math.floor(iconMidpoint - this._label.width / 2);
            this._label.translation_y = Math.floor(this.actor.get_transformed_position()[1] - this._labelOffsetY);

            // Clip left edge to be the left edge of the screen
            this._label.translation_x = Math.max(this._label.translation_x, 0);
        } else {
            // Remove the tooltip from uiGroup
            if (this._label.get_parent() != null)
                Main.uiGroup.remove_actor(this._label);
        }
    }
});
