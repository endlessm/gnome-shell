// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Gtk = imports.gi.Gtk;
const Lang = imports.lang;
const Signals = imports.signals;
const Shell = imports.gi.Shell;
const St = imports.gi.St;

const Main = imports.ui.main;
const ModalDialog = imports.ui.modalDialog;

const GNOME_SYSTEM_MONITOR_DESKTOP_ID = 'gnome-system-monitor.desktop';

const ForceAppExitDialogItem = new Lang.Class({
    Name: 'ForceAppExitDialogItem',
    ICON_SIZE: 32,

    _init: function(app) {
        this.app = app;

        this.actor = new St.BoxLayout({ style_class: 'force-app-exit-dialog-item',
                                        can_focus: true,
                                        reactive: true,
                                        track_hover: true });
        this.actor.connect('key-focus-in', Lang.bind(this, function() {
            this.emit('selected');
        }));
        let action = new Clutter.ClickAction();
        action.connect('clicked', Lang.bind(this, function() {
            this.actor.grab_key_focus();
        }));
        this.actor.add_action(action);

        this._icon = this.app.create_icon_texture(this.ICON_SIZE);
        this.actor.add(this._icon);

        this._label = new St.Label({ text: this.app.get_name(),
                                     y_expand: true,
                                     y_align: Clutter.ActorAlign.CENTER });
        this.actor.label_actor = this._label;
        this.actor.add(this._label);
    },
});
Signals.addSignalMethods(ForceAppExitDialogItem.prototype);

const ForceAppExitDialog = new Lang.Class({
    Name: 'ForceAppExitDialog',
    Extends: ModalDialog.ModalDialog,

    _init: function() {
        this.parent({ styleClass: 'force-app-exit-dialog' });

        let title = new St.Label({ style_class: 'force-app-exit-dialog-header',
                                   text: _("Quit applications") });

        this.contentLayout.style_class = 'force-app-exit-dialog-content';
        this.contentLayout.add(title);

        let subtitle = new St.Label({ style_class: 'force-app-exit-dialog-subtitle',
                                      text: _("If an application doesn't respond for a while, select its name and click Quit Application.") });
        subtitle.clutter_text.line_wrap = true;
        this.contentLayout.add(subtitle, { x_fill: false,
                                           x_align: St.Align.START });

        this._itemBox = new St.BoxLayout({ vertical: true });
        this._scrollView = new St.ScrollView({ style_class: 'force-app-exit-dialog-scroll-view',
                                               hscrollbar_policy: Gtk.PolicyType.NEVER,
                                               vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
                                               overlay_scrollbars: true,
                                               x_expand: true,
                                               y_expand: true });
        this._scrollView.add_actor(this._itemBox);

        this.contentLayout.add(this._scrollView, { expand: true });

        this._cancelButton = this.addButton({ action: Lang.bind(this, this.close),
                                              label: _("Cancel"),
                                              key: Clutter.Escape });

        let appSystem = Shell.AppSystem.get_default();
        if (appSystem.lookup_app(GNOME_SYSTEM_MONITOR_DESKTOP_ID))
            this.addButton({ action: Lang.bind(this, this._launchSystemMonitor),
                             label: _("System Monitor") },
                           { x_align: St.Align.END });

        this._quitButton = this.addButton({ action: Lang.bind(this, this._quitApp),
                                            label: _("Quit Application"),
                                            key: Clutter.Return },
                                          { expand: true,
                                            x_fill: false,
                                            x_align: St.Align.END });

        appSystem.get_running().forEach(Lang.bind(this, function(app) {
            let item = new ForceAppExitDialogItem(app);
            item.connect('selected', Lang.bind(this, this._selectApp));
            this._itemBox.add_child(item.actor);
        }));

        this._selectedAppItem = null;
        this._updateSensitivity();
    },

    _updateSensitivity: function() {
        let quitSensitive = this._selectedAppItem != null;
        this._quitButton.reactive = quitSensitive;
        this._quitButton.can_focus = quitSensitive;
    },

    _launchSystemMonitor: function() {
        let appSystem = Shell.AppSystem.get_default();
        let systemMonitor = appSystem.lookup_app(GNOME_SYSTEM_MONITOR_DESKTOP_ID);
        systemMonitor.activate();

        this.close();
        Main.overview.hide();
    },

    _quitApp: function() {
        let app = this._selectedAppItem.app;
        app.request_quit();
        this.close();
    },

    _selectApp: function(appItem) {
        if (this._selectedAppItem)
            this._selectedAppItem.actor.remove_style_pseudo_class('selected');

        this._selectedAppItem = appItem;
        this._updateSensitivity();

        if (this._selectedAppItem)
            this._selectedAppItem.actor.add_style_pseudo_class('selected');
    },
});
