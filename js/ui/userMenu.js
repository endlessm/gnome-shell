// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const AccountsService = imports.gi.AccountsService;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const Pango = imports.gi.Pango;
const Shell = imports.gi.Shell;
const St = imports.gi.St;

const AppActivation = imports.ui.appActivation;
const BoxPointer = imports.ui.boxpointer;
const Main = imports.ui.main;
const Panel = imports.ui.panel;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const UserWidget = imports.ui.userWidget;

const USER_ICON_SIZE = 34;

const ONLINE_ACCOUNTS_TEXT = _("Social Accounts");
const ONLINE_ACCOUNTS_PANEL_LAUNCHER = 'gnome-online-accounts-panel.desktop';

const SETTINGS_TEXT = _("Settings");
const SETTINGS_LAUNCHER = "gnome-control-center.desktop";

const USER_ACCOUNTS_PANEL_LAUNCHER = 'gnome-user-accounts-panel.desktop';

const HELP_CENTER_TEXT = _("Help");
const HELP_CENTER_LAUNCHER = 'org.gnome.Yelp.desktop';

const UserAccountSection = new Lang.Class({
    Name: 'UserAccountSection',
    Extends: PopupMenu.PopupMenuSection,

    _init: function(user) {
        this.parent();

        // User account's icon
        this.userIconItem = new PopupMenu.PopupBaseMenuItem({ reactive: false,
                                                              can_focus: false });
        this._user = user;
        this._avatar = new UserWidget.Avatar(this._user, { reactive: true,
                                                           styleClass: 'user-menu-avatar' });
        let iconButton = new St.Button({ child: this._avatar.actor });
        this.userIconItem.actor.add(iconButton, { expand: true, span: -1 });

        iconButton.connect('clicked', () => {
            if (Main.sessionMode.allowSettings)
                this.userIconItem.activate();
        });

        this.userIconItem.connect('sensitive-changed', (sensitive) => {
            this._avatar.setSensitive(sensitive.getSensitive());
        });
        this.addMenuItem(this.userIconItem);

        // User account's name
        this.userLabelItem = new PopupMenu.PopupBaseMenuItem({ reactive: false,
                                                               can_focus: false });
        this._label = new St.Label({ style_class: 'user-menu-name' });
        this._label.clutter_text.set_line_wrap(true);
        this._label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        this.userLabelItem.actor.add(this._label, { expand: true, span: -1 });
        this.addMenuItem(this.userLabelItem);

        // We need to monitor the session to know when to enable the user avatar
        Main.sessionMode.connect('updated', this._sessionUpdated.bind(this));
        this._sessionUpdated();
    },

    _sessionUpdated: function() {
        this.userIconItem.setSensitive(Main.sessionMode.allowSettings);
    },

    update: function() {
        this._avatar.update();

        if (this._user.is_loaded)
            this._label.set_text(this._user.get_real_name());
        else
            this._label.set_text('');
    }
});

var UserMenu = new Lang.Class({
    Name: 'UserMenu',

    _init: function() {
        this._userManager = AccountsService.UserManager.get_default();
        this._user = this._userManager.get_user(GLib.get_user_name());

        this._user.connect('notify::is-loaded', this._updateUser.bind(this));
        this._user.connect('changed', this._updateUser.bind(this));

        this._createPanelIcon();
        this._createPopupMenu();

        this._updateUser();
    },

    _createPanelIcon: function() {
        this.panelBox = new St.BoxLayout({ x_align: Clutter.ActorAlign.CENTER,
                                           y_align: Clutter.ActorAlign.CENTER });
        this._panelAvatar = new UserWidget.Avatar(this._user,
                                                  { iconSize: USER_ICON_SIZE,
                                                    styleClass: 'user-menu-button-icon',
                                                    reactive: true });
        this.panelBox.add_actor(this._panelAvatar.actor);
    },

    _createPopupMenu: function() {
        this.menu = new PopupMenu.PopupMenuSection();

        this._accountSection = new UserAccountSection(this._user);
        this._accountSection.userIconItem.connect('activate', () => {
            this._launchApplication(USER_ACCOUNTS_PANEL_LAUNCHER);
        });

        this.menu.addMenuItem(this._accountSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let menuItemsSection = new PopupMenu.PopupMenuSection();
        menuItemsSection.box.style_class = 'user-menu-items';

        // Control Center
        let gicon = new Gio.ThemedIcon({ name: 'applications-system-symbolic' });
        this._settingsItem = menuItemsSection.addAction(SETTINGS_TEXT, Lang.bind(this, function() {
            this.menu.close(BoxPointer.PopupAnimation.NONE);
            Main.overview.hide();

            let app = Shell.AppSystem.get_default().lookup_app(SETTINGS_LAUNCHER);
            let context = new AppActivation.AppActivationContext(app);
            context.activate();
        }), gicon);

        // Social
        gicon = new Gio.ThemedIcon({ name: 'user-available-symbolic' });
        menuItemsSection.addSettingsAction(ONLINE_ACCOUNTS_TEXT, ONLINE_ACCOUNTS_PANEL_LAUNCHER, gicon);

        // Help center
        let iconFile = Gio.File.new_for_uri('resource:///org/gnome/shell/theme/endless-help-symbolic.svg')
        gicon = new Gio.FileIcon({ file: iconFile });
        menuItemsSection.addAction(HELP_CENTER_TEXT, Lang.bind(this, function() {
            this._launchApplication(HELP_CENTER_LAUNCHER);
        }), gicon);
        this.menu.addMenuItem(menuItemsSection);

        // We need to monitor the session to know when to show/hide the settings item
        Main.sessionMode.connect('updated', Lang.bind(this, this._sessionUpdated));
        this._sessionUpdated();
    },

    _launchApplication: function(launcherName) {
        this.menu.close(BoxPointer.PopupAnimation.NONE);
        Main.overview.hide();

        let app = Shell.AppSystem.get_default().lookup_app(launcherName);
        let context = new AppActivation.AppActivationContext(app);
        context.activate();
    },

    _updateUser: function() {
        this._panelAvatar.update();
        this._accountSection.update();
    },

    _sessionUpdated: function() {
        this._settingsItem.actor.visible = Main.sessionMode.allowSettings;
    }
});
