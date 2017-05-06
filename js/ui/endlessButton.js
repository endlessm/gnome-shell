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

        let iconFile;
        iconFile = Gio.File.new_for_uri('resource:///org/gnome/shell/theme/endless-button-symbolic.svg');
        this._gicon = new Gio.FileIcon({ file: iconFile });

        this.setIcon(this._gicon);
    },

    // overrides default implementation from PanelMenu.Button
    _onEvent: function(actor, event) {
        if (this.menu &&
            (event.type() == Clutter.EventType.TOUCH_BEGIN ||
             event.type() == Clutter.EventType.BUTTON_PRESS)) {

            // TODO: This should toggle between the desktop and the currently opened
            // application, or show a dialog (pending design) if no applications are open.
            Main.notifyError('Function currently not available');
        }

        return Clutter.EVENT_PROPAGATE;
    }
});
