// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const AccountsService = imports.gi.AccountsService;
const Clutter = imports.gi.Clutter;
const Gdm = imports.gi.Gdm;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const St = imports.gi.St;

const BoxPointer = imports.ui.boxpointer;
const GnomeSession = imports.misc.gnomeSession;
const LoginManager = imports.misc.loginManager;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const LOCKDOWN_SCHEMA = 'org.gnome.desktop.lockdown';
const LOGIN_SCREEN_SCHEMA = 'org.gnome.login-screen';
const DISABLE_USER_SWITCH_KEY = 'disable-user-switching';
const DISABLE_LOCK_SCREEN_KEY = 'disable-lock-screen';
const DISABLE_LOG_OUT_KEY = 'disable-log-out';
const DISABLE_RESTART_KEY = 'disable-restart-buttons';
const ALWAYS_SHOW_LOG_OUT_KEY = 'always-show-log-out';

const AltSwitcher = new Lang.Class({
    Name: 'AltSwitcher',

    _init: function(standard, alternate) {
        this._standard = standard;
        this._standard.connect('notify::visible', Lang.bind(this, this._sync));
        if (this._standard instanceof St.Button)
            this._standard.connect('clicked',
                                   () => { this._clickAction.release(); });

        this._alternate = alternate;
        this._alternate.connect('notify::visible', Lang.bind(this, this._sync));
        if (this._alternate instanceof St.Button)
            this._alternate.connect('clicked',
                                    () => { this._clickAction.release(); });

        this._capturedEventId = global.stage.connect('captured-event', Lang.bind(this, this._onCapturedEvent));

        this._flipped = false;

        this._clickAction = new Clutter.ClickAction();
        this._clickAction.connect('long-press', Lang.bind(this, this._onLongPress));

        this.actor = new St.Bin();
        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));
        this.actor.connect('notify::mapped', () => { this._flipped = false; });
    },

    _sync: function() {
        let childToShow = null;

        if (this._standard.visible && this._alternate.visible) {
            let [x, y, mods] = global.get_pointer();
            let altPressed = (mods & Clutter.ModifierType.MOD1_MASK) != 0;
            if (this._flipped)
                childToShow = altPressed ? this._standard : this._alternate;
            else
                childToShow = altPressed ? this._alternate : this._standard;
        } else if (this._standard.visible) {
            childToShow = this._standard;
        } else if (this._alternate.visible) {
            childToShow = this._alternate;
        }

        let childShown = this.actor.get_child();
        if (childShown != childToShow) {
            if (childShown) {
                if (childShown.fake_release)
                    childShown.fake_release();
                childShown.remove_action(this._clickAction);
            }
            childToShow.add_action(this._clickAction);

            let hasFocus = this.actor.contains(global.stage.get_key_focus());
            this.actor.set_child(childToShow);
            if (hasFocus)
                childToShow.grab_key_focus();

            // The actors might respond to hover, so
            // sync the pointer to make sure they update.
            global.sync_pointer();
        }

        this.actor.visible = (childToShow != null);
    },

    _onDestroy: function() {
        if (this._capturedEventId > 0) {
            global.stage.disconnect(this._capturedEventId);
            this._capturedEventId = 0;
        }
    },

    _onCapturedEvent: function(actor, event) {
        let type = event.type();
        if (type == Clutter.EventType.KEY_PRESS || type == Clutter.EventType.KEY_RELEASE) {
            let key = event.get_key_symbol();
            if (key == Clutter.KEY_Alt_L || key == Clutter.KEY_Alt_R)
                this._sync();
        }

        return Clutter.EVENT_PROPAGATE;
    },

    _onLongPress: function(action, actor, state) {
        if (state == Clutter.LongPressState.QUERY ||
            state == Clutter.LongPressState.CANCEL)
            return true;

        this._flipped = !this._flipped;
        this._sync();
        return true;
    },

    getWidth: function() {
        let standardVisible = this._standard.visible;
        let alternateVisible = this._alternate.visible;

        this._standard.visible = true;
        this._alternate.visible = false;
        let width = this._standard.get_size()[0];

        this._standard.visible = false;
        this._alternate.visible = true;
        width = Math.max(width, this._alternate.get_size()[0]);

        this._standard.visible = standardVisible;
        this._alternate.visible = alternateVisible;

        return width;
    }
});

const Indicator = new Lang.Class({
    Name: 'SystemIndicator',
    Extends: PanelMenu.SystemIndicator,

    _init: function() {
        this.parent();

        this._loginScreenSettings = new Gio.Settings({ schema_id: LOGIN_SCREEN_SCHEMA });
        this._lockdownSettings = new Gio.Settings({ schema_id: LOCKDOWN_SCHEMA });

        this._session = new GnomeSession.SessionManager();
        this._loginManager = LoginManager.getLoginManager();
        this._monitorManager = Meta.MonitorManager.get();
        this._haveShutdown = true;
        this._haveSuspend = true;

        this._userManager = AccountsService.UserManager.get_default();
        this._user = this._userManager.get_user(GLib.get_user_name());

        this._createSubMenu();

        this._userManager.connect('notify::is-loaded',
                                  Lang.bind(this, this._updateMultiUser));
        this._userManager.connect('notify::has-multiple-users',
                                  Lang.bind(this, this._updateMultiUser));
        this._userManager.connect('user-added',
                                  Lang.bind(this, this._updateMultiUser));
        this._userManager.connect('user-removed',
                                  Lang.bind(this, this._updateMultiUser));
        this._lockdownSettings.connect('changed::' + DISABLE_USER_SWITCH_KEY,
                                       Lang.bind(this, this._updateMultiUser));
        this._lockdownSettings.connect('changed::' + DISABLE_LOG_OUT_KEY,
                                       Lang.bind(this, this._updateMultiUser));
        this._lockdownSettings.connect('changed::' + DISABLE_LOCK_SCREEN_KEY,
                                       Lang.bind(this, this._updateLockScreen));
        global.settings.connect('changed::' + ALWAYS_SHOW_LOG_OUT_KEY,
                                Lang.bind(this, this._updateMultiUser));
        this._updateSwitchUser();
        this._updateMultiUser();
        this._updateLockScreen();

        // Whether shutdown is available or not depends on both lockdown
        // settings (disable-log-out) and Polkit policy - the latter doesn't
        // notify, so we update the menu item each time the menu opens or
        // the lockdown setting changes, which should be close enough.
        this.menu.connect('open-state-changed', Lang.bind(this,
            function(menu, open) {
                if (!open)
                    return;

                this._updateHaveShutdown();
                this._updateHaveSuspend();
            }));
        this._lockdownSettings.connect('changed::' + DISABLE_LOG_OUT_KEY,
                                       Lang.bind(this, this._updateHaveShutdown));

        Main.sessionMode.connect('updated', Lang.bind(this, this._sessionUpdated));
        this._sessionUpdated();
    },

    _updateActionsVisibility: function() {
        let visible = (this._settingsAction.visible ||
                       this._lockScreenAction.visible ||
                       this._altSwitcher.actor.visible);

        this._actionsItem.actor.visible = visible;
    },

    _sessionUpdated: function() {
        this._updateLockScreen();
        this._updatePowerOff();
        this._updateSuspend();
        this._updateMultiUser();
        this._settingsAction.visible = Main.sessionMode.allowSettings;
        this._updateActionsVisibility();
    },

    _updateMultiUser: function() {
        let shouldShowInMode = !Main.sessionMode.isLocked && !Main.sessionMode.isGreeter;
        let hasSwitchUser = this._updateSwitchUser();
        let hasLogout = this._updateLogout();

        this._switchUserSubMenu.actor.visible = shouldShowInMode && (hasSwitchUser || hasLogout);
    },

    _updateSwitchUser: function() {
        let allowSwitch = !this._lockdownSettings.get_boolean(DISABLE_USER_SWITCH_KEY);
        let multiUser = this._userManager.can_switch() && this._userManager.has_multiple_users;

        let visible = allowSwitch && multiUser;
        this._loginScreenItem.actor.visible = visible;
        return visible;
    },

    _updateLogout: function() {
        let allowLogout = !this._lockdownSettings.get_boolean(DISABLE_LOG_OUT_KEY);
        let alwaysShow = global.settings.get_boolean(ALWAYS_SHOW_LOG_OUT_KEY);
        let systemAccount = this._user.system_account;
        let localAccount = this._user.local_account;
        let multiUser = this._userManager.has_multiple_users;
        let multiSession = Gdm.get_session_ids().length > 1;

        let visible = allowLogout && (alwaysShow || multiUser || multiSession || systemAccount || !localAccount);
        this._logoutItem.actor.visible = visible;
        return visible;
    },

    _updateSwitchUserSubMenu: function() {
        this._switchUserSubMenu.label.text = this._user.get_real_name();
        let clutterText = this._switchUserSubMenu.label.clutter_text;

        // XXX -- for some reason, the ClutterText's width changes
        // rapidly unless we force a relayout of the actor. Probably
        // a size cache issue or something. Moving this to be a layout
        // manager would be a much better idea.
        clutterText.get_allocation_box();

        let layout = clutterText.get_layout();
        if (layout.is_ellipsized())
            this._switchUserSubMenu.label.text = this._user.get_user_name();

        let iconFile = this._user.get_icon_file();
        if (iconFile && !GLib.file_test(iconFile, GLib.FileTest.EXISTS))
            iconFile = null;

        if (iconFile) {
            let file = Gio.File.new_for_path(iconFile);
            let gicon = new Gio.FileIcon({ file: file });
            this._switchUserSubMenu.icon.gicon = gicon;

            this._switchUserSubMenu.icon.add_style_class_name('user-icon');
            this._switchUserSubMenu.icon.remove_style_class_name('default-icon');
        } else {
            this._switchUserSubMenu.icon.icon_name = 'avatar-default-symbolic';

            this._switchUserSubMenu.icon.add_style_class_name('default-icon');
            this._switchUserSubMenu.icon.remove_style_class_name('user-icon');
        }
    },

    _updateActionsSubMenu: function() {
        let actors = [this._logoutAction, this._lockScreenAction,
                      this._altSwitcher.actor];

        // First, reset any size we may have previously forced
        actors.forEach(function(actor) { actor.set_width(-1); });

        // Now, calculate the largest visible label
        let width = actors.filter(function(actor) {
            return actor.is_visible();
        }).reduce(Lang.bind(this, function(acc, actor) {
            let actorWidth;
            if (actor == this._altSwitcher.actor)
                actorWidth = this._altSwitcher.getWidth();
            else
                actorWidth = actor.get_size()[0];

            return Math.max(acc, actorWidth);
        }), 0);

        // Set it on all actors
        actors.forEach(function(actor) { actor.set_size(width, -1); });
    },

    _updateLockScreen: function() {
        let showLock = !Main.sessionMode.isLocked && !Main.sessionMode.isGreeter;
        let allowLockScreen = !this._lockdownSettings.get_boolean(DISABLE_LOCK_SCREEN_KEY);
        this._lockScreenAction.visible = showLock && allowLockScreen && LoginManager.canLock();
        this._updateActionsVisibility();
    },

    _updateHaveShutdown: function() {
        this._session.CanShutdownRemote(Lang.bind(this, function(result, error) {
            if (error)
                return;

            this._haveShutdown = result[0];
            this._updatePowerOff();
        }));
    },

    _updatePowerOff: function() {
        let disabled = Main.sessionMode.isLocked ||
                       (Main.sessionMode.isGreeter &&
                        this._loginScreenSettings.get_boolean(DISABLE_RESTART_KEY));
        this._powerOffAction.visible = this._haveShutdown && !disabled;
        this._updateActionsVisibility();
    },

    _updateHaveSuspend: function() {
        this._loginManager.canSuspend(Lang.bind(this,
            function(canSuspend, needsAuth) {
                this._haveSuspend = canSuspend;
                this._suspendNeedsAuth = needsAuth;
                this._updateSuspend();
            }));
    },

    _updateSuspend: function() {
        let disabled = (Main.sessionMode.isLocked &&
                        this._suspendNeedsAuth) ||
                       (Main.sessionMode.isGreeter &&
                        this._loginScreenSettings.get_boolean(DISABLE_RESTART_KEY));
        this._suspendAction.visible = this._haveSuspend && !disabled;
        this._updateActionsVisibility();
    },

    _createActionButton: function(iconName, accessibleName) {
        let icon = new St.Button({ reactive: true,
                                   can_focus: true,
                                   track_hover: true,
                                   accessible_name: accessibleName,
                                   style_class: 'system-menu-action' });
        icon.child = new St.Icon({ icon_name: iconName });
        return icon;
    },

    _createSubMenu: function() {
        let item;

        this._switchUserSubMenu = new PopupMenu.PopupSubMenuMenuItem('', true);
        this._switchUserSubMenu.icon.style_class = 'system-switch-user-submenu-icon';

        // Since the label of the switch user submenu depends on the width of
        // the popup menu, and we can't easily connect on allocation-changed
        // or notify::width without creating layout cycles, simply update the
        // label whenever the menu is opened.
        this.menu.connect('open-state-changed', Lang.bind(this, function(menu, isOpen) {
            if (isOpen)
                this._updateSwitchUserSubMenu();
        }));

        item = new PopupMenu.PopupMenuItem(_("Switch User"));
        item.connect('activate', Lang.bind(this, this._onLoginScreenActivate));
        this._switchUserSubMenu.menu.addMenuItem(item);
        this._loginScreenItem = item;

        item = new PopupMenu.PopupMenuItem(_("Log Out"));
        item.connect('activate', Lang.bind(this, this._onQuitSessionActivate));
        this._switchUserSubMenu.menu.addMenuItem(item);
        this._logoutItem = item;

        this._switchUserSubMenu.menu.addSettingsAction(_("Account Settings"),
                                                       'gnome-user-accounts-panel.desktop');

        this._user.connect('notify::is-loaded', Lang.bind(this, this._updateSwitchUserSubMenu));
        this._user.connect('changed', Lang.bind(this, this._updateSwitchUserSubMenu));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        item = new PopupMenu.PopupBaseMenuItem({ reactive: false,
                                                 can_focus: false });

        this._settingsAction = this._createActionButton('preferences-system-symbolic', _("Settings"));
        this._settingsAction.connect('clicked', Lang.bind(this, this._onSettingsClicked));
        item.actor.add(this._settingsAction, { expand: true, x_fill: false });

        this._lockScreenAction = this._createActionButton('changes-prevent-symbolic', _("Lock"));
        this._lockScreenAction.connect('clicked', Lang.bind(this, this._onLockScreenClicked));
        item.actor.add(this._lockScreenAction, { expand: true, x_fill: false });

        this._suspendAction = this._createActionButton('media-playback-pause-symbolic', _("Suspend"));
        this._suspendAction.connect('clicked', Lang.bind(this, this._onSuspendClicked));

        this._powerOffAction = this._createActionButton('system-shutdown-symbolic', _("Power Off"));
        this._powerOffAction.connect('clicked', Lang.bind(this, this._onPowerOffClicked));

        this._altSwitcher = new AltSwitcher(this._powerOffAction, this._suspendAction);
        item.actor.add(this._altSwitcher.actor, { expand: true, x_fill: false });

        this._actionsItem = item;
        this.menu.addMenuItem(item);
    },

    _onSettingsClicked: function() {
        this.menu.itemActivated();
        let app = Shell.AppSystem.get_default().lookup_app('gnome-control-center.desktop');
        Main.overview.hide();
        app.activate();
    },

    _onLockScreenClicked: function() {
        this.menu.itemActivated(BoxPointer.PopupAnimation.NONE);
        Main.overview.hide();
        Main.screenShield.lock(true);
    },

    _onLoginScreenActivate: function() {
        this.menu.itemActivated(BoxPointer.PopupAnimation.NONE);
        Main.overview.hide();
        if (Main.screenShield)
            Main.screenShield.lock(false);

        Clutter.threads_add_repaint_func_full(Clutter.RepaintFlags.POST_PAINT, function() {
            Gdm.goto_login_session_sync(null);
            return false;
        });
    },

    _onQuitSessionActivate: function() {
        Main.overview.hide();
        this._session.LogoutRemote(0);
    },

    _onPowerOffClicked: function() {
        this.menu.itemActivated();
        Main.overview.hide();
        this._session.ShutdownRemote(0);
    },

    _onSuspendClicked: function() {
        this.menu.itemActivated();
        this._loginManager.suspend();
    },
});
