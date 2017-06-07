// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const St = imports.gi.St;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;

const HOT_CORNER_ENABLED_KEY = 'hot-corner-enabled';

const HotCorner = new Lang.Class({
    Name: 'HotCorner',
    Extends: PanelMenu.SingleIconButton,

    _init: function() {
        this.parent(_("Hot Corner"), Clutter.ActorAlign.END, Clutter.ActorAlign.END);
        this.actor.add_style_class_name('hot-corner');

        let iconFile;
        if (this.actor.get_text_direction() == Clutter.TextDirection.RTL)
            iconFile = Gio.File.new_for_uri('resource:///org/gnome/shell/theme/hot-corner-rtl-symbolic.svg');
        else
            iconFile = Gio.File.new_for_uri('resource:///org/gnome/shell/theme/hot-corner-symbolic.svg');

        this._gicon = new Gio.FileIcon({ file: iconFile });
        this.setIcon(this._gicon);

        this.container.set_fill(false, false);
        this.container.set_alignment(St.Align.END, St.Align.END);

        this._enableMenuItem = this.menu.addAction(_("Enable Hot Corner"), Lang.bind(this, function() {
            global.settings.set_boolean(HOT_CORNER_ENABLED_KEY, true);
        }));

        this._disableMenuItem = this.menu.addAction(_("Disable Hot Corner"), Lang.bind(this, function() {
            global.settings.set_boolean(HOT_CORNER_ENABLED_KEY, false);
        }));

        if (global.settings.get_boolean(HOT_CORNER_ENABLED_KEY))
            this._enableMenuItem.actor.visible = false;
        else
            this._disableMenuItem.actor.visible = false;

        this.menu.connect('menu-closed', Lang.bind(this, function() {
            let isEnabled = global.settings.get_boolean(HOT_CORNER_ENABLED_KEY);
            this._enableMenuItem.actor.visible = !isEnabled;
            this._disableMenuItem.actor.visible = isEnabled;
        }));
    },

    // overrides default implementation from PanelMenu.Button
    _onEvent: function(actor, event) {
        if (this.menu &&
            (event.type() == Clutter.EventType.TOUCH_BEGIN ||
             event.type() == Clutter.EventType.BUTTON_PRESS)) {
            let button = event.get_button();
            if (button == Gdk.BUTTON_PRIMARY && Main.overview.shouldToggleByCornerOrButton())
                Main.overview.toggleWindows();
            else if (button == Gdk.BUTTON_SECONDARY)
                this.menu.toggle();
        }

        return Clutter.EVENT_PROPAGATE;
    }
});
