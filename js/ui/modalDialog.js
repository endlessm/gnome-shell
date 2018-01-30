// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Meta = imports.gi.Meta;
const Pango = imports.gi.Pango;
const St = imports.gi.St;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const Atk = imports.gi.Atk;

const Params = imports.misc.params;

const Lightbox = imports.ui.lightbox;
const Main = imports.ui.main;
const Monitor = imports.ui.monitor;
const Tweener = imports.ui.tweener;

var OPEN_AND_CLOSE_TIME = 0.1;
var FADE_OUT_DIALOG_TIME = 1.0;

var State = {
    OPENED: 0,
    CLOSED: 1,
    OPENING: 2,
    CLOSING: 3,
    FADED_OUT: 4
};

var ModalDialog = new Lang.Class({
    Name: 'ModalDialog',

    _init: function(params) {
        params = Params.parse(params, { shellReactive: false,
                                        styleClass: null,
                                        actionMode: Shell.ActionMode.SYSTEM_MODAL,
                                        shouldFadeIn: true,
                                        shouldFadeOut: true,
                                        destroyOnClose: true });

        this.state = State.CLOSED;
        this._hasModal = false;
        this._actionMode = params.actionMode;
        this._shellReactive = params.shellReactive;
        this._shouldFadeIn = params.shouldFadeIn;
        this._shouldFadeOut = params.shouldFadeOut;
        this._destroyOnClose = params.destroyOnClose;

        this._group = new St.Widget({ visible: false,
                                      x: 0,
                                      y: 0,
                                      accessible_role: Atk.Role.DIALOG });
        Main.layoutManager.modalDialogGroup.add_actor(this._group);

        let constraint = new Clutter.BindConstraint({ source: global.stage,
                                                      coordinate: Clutter.BindCoordinate.ALL });
        this._group.add_constraint(constraint);

        this._group.connect('destroy', Lang.bind(this, this._onGroupDestroy));

        this._pressedKey = null;
        this._buttonKeys = {};
        this._group.connect('key-press-event', Lang.bind(this, this._onKeyPressEvent));
        this._group.connect('key-release-event', Lang.bind(this, this._onKeyReleaseEvent));

        this.backgroundStack = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        this._backgroundBin = new St.Bin({ child: this.backgroundStack,
                                           x_fill: true, y_fill: true });
        this._monitorConstraint = new Monitor.MonitorConstraint();
        this._backgroundBin.add_constraint(this._monitorConstraint);
        this._group.add_actor(this._backgroundBin);

        this.dialogLayout = new St.BoxLayout({ style_class: 'modal-dialog',
                                               x_align:      Clutter.ActorAlign.CENTER,
                                               y_align:      Clutter.ActorAlign.CENTER,
                                               vertical:     true });
        // modal dialogs are fixed width and grow vertically; set the request
        // mode accordingly so wrapped labels are handled correctly during
        // size requests.
        this.dialogLayout.request_mode = Clutter.RequestMode.HEIGHT_FOR_WIDTH;

        if (params.styleClass != null)
            this.dialogLayout.add_style_class_name(params.styleClass);

        if (!this._shellReactive) {
            this._lightbox = new Lightbox.Lightbox(this._group,
                                                   { inhibitEvents: true,
                                                     radialEffect: true });
            this._lightbox.highlight(this._backgroundBin);

            this._eventBlocker = new Clutter.Actor({ reactive: true });
            this.backgroundStack.add_actor(this._eventBlocker);
        }
        this.backgroundStack.add_actor(this.dialogLayout);


        this.contentLayout = new St.BoxLayout({ vertical: true,
                                                style_class: "modal-dialog-content-box" });
        this.dialogLayout.add(this.contentLayout,
                              { expand:  true,
                                x_fill:  true,
                                y_fill:  true,
                                x_align: St.Align.MIDDLE,
                                y_align: St.Align.START });

        this.buttonLayout = new St.Widget ({ layout_manager: new Clutter.BoxLayout ({ homogeneous:true }) });
        this.dialogLayout.add(this.buttonLayout,
                              { x_align: St.Align.MIDDLE,
                                y_align: St.Align.END });

        global.focus_manager.add_group(this.dialogLayout);
        this._initialKeyFocus = this.dialogLayout;
        this._initialKeyFocusDestroyId = 0;
        this._savedKeyFocus = null;
    },

    destroy: function() {
        this._group.destroy();
    },

    clearButtons: function() {
        this.buttonLayout.destroy_all_children();
        this._buttonKeys = {};
    },

    setButtons: function(buttons) {
        this.clearButtons();

        for (let i = 0; i < buttons.length; i++) {
            let buttonInfo = buttons[i];

            let x_alignment;
            if (buttons.length == 1)
                x_alignment = St.Align.END;
            else if (i == 0)
                x_alignment = St.Align.START;
            else if (i == buttons.length - 1)
                x_alignment = St.Align.END;
            else
                x_alignment = St.Align.MIDDLE;

            this.addButton(buttonInfo);
        }
    },

    addButton: function(buttonInfo) {
        let label = buttonInfo['label']
        let action = buttonInfo['action'];
        let key = buttonInfo['key'];
        let isDefault = buttonInfo['default'];

        let keys;

        if (key)
            keys = [key];
        else if (isDefault)
            keys = [Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_ISO_Enter];
        else
            keys = [];

        let button = new St.Button({ style_class: 'modal-dialog-linked-button',
                                     button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
                                     reactive:    true,
                                     can_focus:   true,
                                     x_expand:    true,
                                     y_expand:    true,
                                     label:       label });
        button.connect('clicked', action);

        buttonInfo['button'] = button;

        if (isDefault)
            button.add_style_pseudo_class('default');

        if (!this._initialKeyFocusDestroyId)
            this._initialKeyFocus = button;

        for (let i in keys)
            this._buttonKeys[keys[i]] = buttonInfo;

        this.buttonLayout.add_actor(button);

        return button;
    },

    _onKeyPressEvent: function(object, event) {
        this._pressedKey = event.get_key_symbol();
        return Clutter.EVENT_PROPAGATE;
    },

    _onKeyReleaseEvent: function(object, event) {
        let pressedKey = this._pressedKey;
        this._pressedKey = null;

        let symbol = event.get_key_symbol();
        if (symbol != pressedKey)
            return Clutter.EVENT_PROPAGATE;

        let buttonInfo = this._buttonKeys[symbol];
        if (!buttonInfo)
            return Clutter.EVENT_PROPAGATE;

        let button = buttonInfo['button'];
        let action = buttonInfo['action'];

        if (action && button.reactive) {
            action();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    },

    _onGroupDestroy: function() {
        this.emit('destroy');
    },

    _fadeOpen: function(onPrimary) {
        if (onPrimary)
            this._monitorConstraint.primary = true;
        else
            this._monitorConstraint.index = global.screen.get_current_monitor();

        this.state = State.OPENING;

        this.dialogLayout.opacity = 255;
        if (this._lightbox)
            this._lightbox.show();
        this._group.opacity = 0;
        this._group.show();
        Tweener.addTween(this._group,
                         { opacity: 255,
                           time: this._shouldFadeIn ? OPEN_AND_CLOSE_TIME : 0,
                           transition: 'easeOutQuad',
                           onComplete: Lang.bind(this,
                               function() {
                                   this.state = State.OPENED;
                                   this.emit('opened');
                               })
                         });
    },

    setInitialKeyFocus: function(actor) {
        if (this._initialKeyFocusDestroyId)
            this._initialKeyFocus.disconnect(this._initialKeyFocusDestroyId);

        this._initialKeyFocus = actor;

        this._initialKeyFocusDestroyId = actor.connect('destroy', Lang.bind(this, function() {
            this._initialKeyFocus = this.dialogLayout;
            this._initialKeyFocusDestroyId = 0;
        }));
    },

    open: function(timestamp, onPrimary) {
        if (this.state == State.OPENED || this.state == State.OPENING)
            return true;

        if (!this.pushModal(timestamp))
            return false;

        this._fadeOpen(onPrimary);
        return true;
    },

    _closeComplete: function() {
        this.state = State.CLOSED;
        this._group.hide();
        this.emit('closed');

        if (this._destroyOnClose)
            this.destroy();
    },

    close: function(timestamp) {
        if (this.state == State.CLOSED || this.state == State.CLOSING)
            return;

        this.state = State.CLOSING;
        this.popModal(timestamp);
        this._savedKeyFocus = null;

        if (this._shouldFadeOut)
            Tweener.addTween(this._group,
                             { opacity: 0,
                               time: OPEN_AND_CLOSE_TIME,
                               transition: 'easeOutQuad',
                               onComplete: Lang.bind(this,
                                                     this._closeComplete)
                             })
        else
            this._closeComplete();
    },

    // Drop modal status without closing the dialog; this makes the
    // dialog insensitive as well, so it needs to be followed shortly
    // by either a close() or a pushModal()
    popModal: function(timestamp) {
        if (!this._hasModal)
            return;

        let focus = global.stage.key_focus;
        if (focus && this._group.contains(focus))
            this._savedKeyFocus = focus;
        else
            this._savedKeyFocus = null;
        Main.popModal(this._group, timestamp);
        global.gdk_screen.get_display().sync();
        this._hasModal = false;

        if (!this._shellReactive)
            this._eventBlocker.raise_top();
    },

    pushModal: function (timestamp) {
        if (this._hasModal)
            return true;

        let params = { actionMode: this._actionMode };
        if (timestamp)
            params['timestamp'] = timestamp;
        if (!Main.pushModal(this._group, params))
            return false;

        this._hasModal = true;
        if (this._savedKeyFocus) {
            this._savedKeyFocus.grab_key_focus();
            this._savedKeyFocus = null;
        } else {
            this._initialKeyFocus.grab_key_focus();
        }

        if (!this._shellReactive)
            this._eventBlocker.lower_bottom();
        return true;
    },

    // This method is like close, but fades the dialog out much slower,
    // and leaves the lightbox in place. Once in the faded out state,
    // the dialog can be brought back by an open call, or the lightbox
    // can be dismissed by a close call.
    //
    // The main point of this method is to give some indication to the user
    // that the dialog reponse has been acknowledged but will take a few
    // moments before being processed.
    // e.g., if a user clicked "Log Out" then the dialog should go away
    // imediately, but the lightbox should remain until the logout is
    // complete.
    _fadeOutDialog: function(timestamp) {
        if (this.state == State.CLOSED || this.state == State.CLOSING)
            return;

        if (this.state == State.FADED_OUT)
            return;

        this.popModal(timestamp);
        Tweener.addTween(this.dialogLayout,
                         { opacity: 0,
                           time:    FADE_OUT_DIALOG_TIME,
                           transition: 'easeOutQuad',
                           onComplete: Lang.bind(this,
                               function() {
                                   this.state = State.FADED_OUT;
                               })
                         });
    }
});
Signals.addSignalMethods(ModalDialog.prototype);
