// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const AccountsService = imports.gi.AccountsService;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Shell = imports.gi.Shell;
const St = imports.gi.St;
const GObject = imports.gi.GObject;

const BoxPointer = imports.ui.boxpointer;
const SystemActions = imports.misc.systemActions;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

var AltSwitcher = new Lang.Class({
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

        // We can hit a point where neither the standard nor the
        // alternate child is visible, so exit cleanly in that case.
        if (!childToShow)
            return;

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

var Indicator = new Lang.Class({
    Name: 'SystemIndicator',
    Extends: PanelMenu.SystemIndicator,

    _init: function() {
        this.parent();

        let userManager = AccountsService.UserManager.get_default();
        this._user = userManager.get_user(GLib.get_user_name());

        this._systemActions = new SystemActions.getDefault();

        this._createSubMenu();

        this._loginScreenItem.actor.connect('notify::visible',
                                            () => { this._updateMultiUser(); });
        this._logoutItem.actor.connect('notify::visible',
                                       () => { this._updateMultiUser(); });
        // Whether shutdown is available or not depends on both lockdown
        // settings (disable-log-out) and Polkit policy - the latter doesn't
        // notify, so we update the menu item each time the menu opens or
        // the lockdown setting changes, which should be close enough.
        this.menu.connect('open-state-changed', Lang.bind(this,
            function(menu, open) {
                if (!open)
                    return;

                this._systemActions.forceUpdate();
            }));

        this._updateMultiUser();
    },

    _updateActionsVisibility: function() {
        let visible = (this._lockScreenAction.visible ||
                       this._altSwitcher.actor.visible);

        this._actionsItem.actor.visible = visible;
    },

    _updateMultiUser: function() {
        let hasSwitchUser = this._loginScreenItem.actor.visible;
        let hasLogout = this._logoutItem.actor.visible;

        this._switchUserSubMenu.actor.visible = hasSwitchUser || hasLogout;
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

    _createActionButton: function(accessibleName, customClass) {
        let box = new St.BoxLayout({ vertical: true,
                                     style_class: 'system-menu-action-container' });
        let button = new St.Button({ reactive: true,
                                     can_focus: true,
                                     track_hover: true,
                                     x_expand: false,
                                     x_align: Clutter.ActorAlign.CENTER,
                                     accessible_name: accessibleName,
                                     style_class: 'system-menu-action' });
        box.add(button, { expand: true, x_fill: false });

        let label = new St.Label({ text: accessibleName,
                                   x_align: Clutter.ActorAlign.CENTER,
                                   style_class: 'system-menu-action-desc' });
        box.add(label);

        box._button = button;
        box._label = label;

        if (customClass)
            button.style_class = ['system-menu-action', customClass].join(' ');

        return box;
    },

    _createActionButtonForIconName: function(iconName, accessibleName, callback, customClass) {
        let box = this._createActionButton(accessibleName, customClass);
        let button = box._button
        button.child = new St.Icon({ icon_name: iconName, x_expand: false });

        if (callback)
            button.connect('clicked', Lang.bind(this, callback));

        return box;
    },

    _createActionButtonForIconPath: function(iconPath, accessibleName, callback, customClass) {
        let iconFile = Gio.File.new_for_uri('resource:///org/gnome/shell' + iconPath);
        let gicon = new Gio.FileIcon({ file: iconFile });

        let box = this._createActionButton(accessibleName, customClass);
        let button = box._button;
        button.child = new St.Icon({ gicon: gicon, x_expand: false });

        if (callback)
            button.connect('clicked', Lang.bind(this, callback));

        return box;
    },

    _createSubMenu: function() {
        let bindFlags = GObject.BindingFlags.DEFAULT | GObject.BindingFlags.SYNC_CREATE;
        let item;

        this._switchUserSubMenu = new PopupMenu.PopupSubMenuMenuItem('', true);
        this._switchUserSubMenu.icon.style_class = 'system-switch-user-submenu-icon';

        // Since the label of the switch user submenu depends on the width of
        // the popup menu, and we can't easily connect on allocation-changed
        // or notify::width without creating layout cycles, simply update the
        // label whenever the menu is opened.
        this.menu.connect('open-state-changed', Lang.bind(this, function(menu, isOpen) {
            if (isOpen) {
                this._updateSwitchUserSubMenu();
                this._updateActionsSubMenu();
            }
        }));

        item = new PopupMenu.PopupMenuItem(_("Switch User"));
        item.connect('activate', Lang.bind(this, this._onLoginScreenActivate));
        this._switchUserSubMenu.menu.addMenuItem(item);
        this._loginScreenItem = item;
        this._systemActions.bind_property('can-switch-user',
                                          this._loginScreenItem.actor,
                                          'visible',
                                          bindFlags);

        item = new PopupMenu.PopupMenuItem(_("Log Out"));
        item.connect('activate', Lang.bind(this, this._onQuitSessionActivate));
        this._switchUserSubMenu.menu.addMenuItem(item);
        this._logoutItem = item;
        this._systemActions.bind_property('can-logout',
                                          this._logoutItem.actor,
                                          'visible',
                                          bindFlags);

        this._switchUserSubMenu.menu.addSettingsAction(_("Account Settings"),
                                                       'gnome-user-accounts-panel.desktop');

        this._user.connect('notify::is-loaded', Lang.bind(this, this._updateSwitchUserSubMenu));
        this._user.connect('changed', Lang.bind(this, this._updateSwitchUserSubMenu));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        item = new PopupMenu.PopupBaseMenuItem({ reactive: false,
                                                 can_focus: false });

        this._logoutAction = this._createActionButtonForIconPath('/theme/system-logout.png',
                                                                 _("Log Out"),
                                                                 this._onQuitSessionActivate,
                                                                 null);
        item.actor.add(this._logoutAction, { expand: true, x_fill: false });

        this._lockScreenAction = this._createActionButtonForIconName('changes-prevent-symbolic',
                                                                     _("Lock"),
                                                                     this._onLockScreenClicked,
                                                                     null);
        item.actor.add(this._lockScreenAction, { expand: true, x_fill: false });
        this._systemActions.bind_property('can-lock-screen',
                                          this._lockScreenAction,
                                          'visible',
                                          bindFlags);

        this._suspendAction = this._createActionButtonForIconName('media-playback-pause-symbolic',
                                                                  _("Suspend"),
                                                                  this._onSuspendClicked,
                                                                  null);
        this._systemActions.bind_property('can-suspend',
                                          this._suspendAction,
                                          'visible',
                                          bindFlags);

        this._powerOffAction = this._createActionButtonForIconName('system-shutdown-symbolic',
                                                                   _("Power Off"),
                                                                   this._onPowerOffClicked,
                                                                   'poweroff-button');
        this._systemActions.bind_property('can-power-off',
                                          this._powerOffAction,
                                          'visible',
                                          bindFlags);

        this._altSwitcher = new AltSwitcher(this._powerOffAction, this._suspendAction);
        item.actor.add(this._altSwitcher.actor, { expand: true, x_fill: false });

        this._actionsItem = item;
        this.menu.addMenuItem(item);

        this._lockScreenAction.connect('notify::visible',
                                       () => { this._updateActionsVisibility(); });
        this._altSwitcher.actor.connect('notify::visible',
                                        () => { this._updateActionsVisibility(); });
    },

    _onLockScreenClicked: function() {
        this.menu.itemActivated(BoxPointer.PopupAnimation.NONE);
        this._systemActions.activateLockScreen();
    },

    _onLoginScreenActivate: function() {
        this.menu.itemActivated(BoxPointer.PopupAnimation.NONE);
        this._systemActions.activateSwitchUser();
    },

    _onQuitSessionActivate: function() {
        this.menu.itemActivated(BoxPointer.PopupAnimation.NONE);
        this._systemActions.activateLogout();
    },

    _onPowerOffClicked: function() {
        this.menu.itemActivated(BoxPointer.PopupAnimation.NONE);
        this._systemActions.activatePowerOff();
    },

    _onSuspendClicked: function() {
        this.menu.itemActivated(BoxPointer.PopupAnimation.NONE);
        this._systemActions.activateSuspend();
    }
});
