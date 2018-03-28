// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
//
// Copyright (C) 2018 Endless Mobile, Inc.
//
// Licensed under the GNU General Public License Version 2
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program; if not, write to the Free Software
// Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.

const Atk = imports.gi.Atk;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Lang = imports.lang;
const Meta = imports.gi.Meta;
const Pango = imports.gi.Pango;
const Signals = imports.signals;
const Shell = imports.gi.Shell;
const St = imports.gi.St;

const PaygManager = imports.misc.paygManager;

const Animation = imports.ui.animation;
const Main = imports.ui.main;
const Monitor = imports.ui.monitor;
const ShellEntry = imports.ui.shellEntry;
const Tweener = imports.ui.tweener;

const MSEC_PER_SEC = 1000

// The timeout before going back automatically to the lock screen
const IDLE_TIMEOUT_SECS = 2 * 60;

const CODE_REQUIRED_LENGTH_CHARS = 8;

const SPINNER_ICON_SIZE_PIXELS = 16;
const SPINNER_ANIMATION_DELAY_SECS = 1.0;
const SPINNER_ANIMATION_TIME_SECS = 0.3;

var UnlockStatus = {
    NOT_VERIFYING: 0,
    VERIFYING: 1,
    FAILED: 2,
    SUCCEEDED: 3,
};

var PaygUnlockCodeEntry = new Lang.Class({
    Name: 'PaygUnlockCodeEntry',
    Extends: St.Entry,
    Signals: { 'code-changed' : { param_types: [GObject.TYPE_STRING] } },

    _init: function(params) {
        this.parent({ style_class: 'unlock-dialog-payg-entry',
                      reactive: true,
                      can_focus: true,
                      x_align: Clutter.ActorAlign.FILL });

        this._code = '';
        this.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this.clutter_text.x_align = Clutter.ActorAlign.CENTER;

        this.connect('button-press-event', this._onButtonPressEvent.bind(this));

        this.clutter_text.connect('captured-event', this._onCapturedEvent.bind(this));
        this.clutter_text.connect('text-changed', this._onTextChanged.bind(this));
    },

    _onCapturedEvent: function(textActor, event) {
        if (event.type() != Clutter.EventType.KEY_PRESS)
            return Clutter.EVENT_PROPAGATE;

        let character = event.get_key_unicode();

        // We only support printable characters.
        if (!GLib.unichar_isprint(character))
            return Clutter.EVENT_PROPAGATE;

        // Don't allow inserting more digits than required.
        if (this._code.length >= CODE_REQUIRED_LENGTH_CHARS)
            return Clutter.EVENT_STOP;

        // Allow digits only
        if (GLib.unichar_isdigit(character))
            this.clutter_text.insert_unichar(character);

        return Clutter.EVENT_STOP;
    },

    _onTextChanged: function(textActor) {
        this._code = textActor.text;
        this.emit('code-changed', this._code);
    },

    _onButtonPressEvent: function() {
        this.grab_key_focus();
        return false;
    },

    addCharacter: function(character) {
        this.clutter_text.insert_unichar(character);
    },

    setEnabled: function(value) {
        this.reactive = value;
        this.clutter_text.editable = value;
    },

    reset: function() {
        this.text = '';
    },

    get code() {
        return this._code;
    },

    get length() {
        return this._code.length;
    }
});

var PaygUnlockDialog = new Lang.Class({
    Name: 'PaygUnlockDialog',

    _init: function(parentActor) {
        this._parentActor = parentActor;

        this._entry = null;
        this._errorMessage = null;
        this._cancelButton = null;
        this._nextButton = null;
        this._spinner = null;
        this._cancelled = false;

        this._verificationStatus = UnlockStatus.NOT_VERIFYING;

        // Clear the clipboard to make sure nothing can be copied into the entry.
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, '');
        St.Clipboard.get_default().set_text(St.ClipboardType.PRIMARY, '');

        this.actor = new St.Widget({ accessible_role: Atk.Role.WINDOW,
                                     style_class: 'unlock-dialog-payg',
                                     layout_manager: new Clutter.BoxLayout(),
                                     visible: false });
        this.actor.add_constraint(new Monitor.MonitorConstraint({ primary: true }));

        this._parentActor.add_child(this.actor);

        let promptBox = new St.BoxLayout({ vertical: true,
                                           x_align: Clutter.ActorAlign.CENTER,
                                           y_align: Clutter.ActorAlign.CENTER,
                                           x_expand: true,
                                           y_expand: true,
                                           style_class: 'unlock-dialog-payg-layout'});
        promptBox.connect('key-press-event', (actor, event) => {
            if (event.get_key_symbol() == Clutter.KEY_Escape)
                this._onCancelled();

            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.add_child(promptBox);

        let titleLabel = new St.Label({ style_class: 'unlock-dialog-payg-title',
                                        text: _("Your subscription has expired"),
                                        x_align: Clutter.ActorAlign.CENTER });
        promptBox.add_child(titleLabel);

        let promptLabel = new St.Label({ style_class: 'unlock-dialog-payg-label',
                                         text: _("Enter a new code to unlock the computer:"),
                                         x_align: Clutter.ActorAlign.START });
        promptBox.add_child(promptLabel);

        this._entry = new PaygUnlockCodeEntry();
        promptBox.add_child(this._entry);

        this._errorMessage = new St.Label({ opacity: 0,
                                            styleClass: 'unlock-dialog-payg-message' });
        this._errorMessage.clutter_text.line_wrap = true;
        this._errorMessage.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        promptBox.add_child(this._errorMessage);

        this._buttonBox = this._createButtonsArea();
        promptBox.add_child(this._buttonBox);

        Main.ctrlAltTabManager.addGroup(promptBox, _("Unlock Machine"), 'dialog-password-symbolic');

        this._cancelButton.connect('clicked', () => {
            this._onCancelled();
        });
        this._nextButton.connect('clicked', () => {
            this._startVerifyingCode();
        });

        this._entry.connect('code-changed', () => {
            this._updateNextButtonSensitivity();
        });

        this._entry.clutter_text.connect('activate', () => {
            this._startVerifyingCode();
        });

        this._idleMonitor = Meta.IdleMonitor.get_core();
        this._idleWatchId = this._idleMonitor.add_idle_watch(IDLE_TIMEOUT_SECS * MSEC_PER_SEC, Lang.bind(this, this._onCancelled));

        this._entry.grab_key_focus()
        this._updateSensitivity();
    },

    _createButtonsArea: function() {
        let buttonsBox = new St.BoxLayout({ style_class: 'unlock-dialog-payg-button-box',
                                            vertical: false,
                                            x_expand: true,
                                            x_align: Clutter.ActorAlign.FILL,
                                            y_expand: true,
                                            y_align: Clutter.ActorAlign.END });

        this._cancelButton = new St.Button({ style_class: 'modal-dialog-button button',
                                             button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
                                             reactive: true,
                                             can_focus: true,
                                             label: _("Cancel"),
                                             x_align: St.Align.START,
                                             y_align: St.Align.END });
        buttonsBox.add_child(this._cancelButton);

        let buttonSpacer = new St.Widget({ layout_manager: new Clutter.BinLayout(),
                                           x_expand: true,
                                           x_align: Clutter.ActorAlign.END });
        buttonsBox.add_child(buttonSpacer);

        // We make the most of the spacer to show the spinner while verifying the code.
        let spinnerIcon = Gio.File.new_for_uri('resource:///org/gnome/shell/theme/process-working.svg');
        this._spinner = new Animation.AnimatedIcon(spinnerIcon, SPINNER_ICON_SIZE_PIXELS);
        this._spinner.actor.opacity = 0;
        this._spinner.actor.show();
        buttonSpacer.add_child(this._spinner.actor);

        this._nextButton = new St.Button({ style_class: 'modal-dialog-button button',
                                           button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
                                           reactive: true,
                                           can_focus: true,
                                           label: _("Unlock"),
                                           x_align: St.Align.END,
                                           y_align: St.Align.END });
        this._nextButton.add_style_pseudo_class('default');
        buttonsBox.add_child(this._nextButton);

        return buttonsBox;
    },

    _onCancelled: function() {
        this._cancelled = true;
        this._reset();

        // The ScreenShield will connect to the 'failed' signal
        // to know when to cancel the unlock dialog.
        if (this._verificationStatus != UnlockStatus.SUCCEEDED)
            this.emit('failed');
    },

    _validateCurrentCode: function() {
        // The PaygUnlockCodeEntry widget will only accept valid
        // characters, so we only need to check the length here.
        return this._entry.length == CODE_REQUIRED_LENGTH_CHARS;
    },

    _updateNextButtonSensitivity: function() {
        let sensitive = this._validateCurrentCode() && this._verificationStatus != UnlockStatus.VERIFYING;
        this._nextButton.reactive = sensitive;
        this._nextButton.can_focus = sensitive;
    },

    _updateSensitivity: function() {
        this._updateNextButtonSensitivity();
        this._entry.setEnabled(this._verificationStatus != UnlockStatus.VERIFYING);
    },

    _setErrorMessage: function(message) {
        if (message) {
            this._errorMessage.text = message;
            this._errorMessage.opacity = 255;
        } else {
            this._errorMessage.text = '';
            this._errorMessage.opacity = 0;
        }
    },

    _startSpinning: function() {
        this._spinner.play();
        this._spinner.actor.show();
        Tweener.addTween(this._spinner.actor,
                         { opacity: 255,
                           time: SPINNER_ANIMATION_TIME_SECS,
                           delay: SPINNER_ANIMATION_DELAY_SECS,
                           transition: 'linear' });
    },

    _stopSpinning: function() {
        this._spinner.actor.hide();
        this._spinner.actor.opacity = 0;
        this._spinner.stop();
    },

    _reset: function() {
        this._stopSpinning();
        this._entry.reset();
        this._updateSensitivity();
    },

    _showError: function(error) {
        if (error.matches(PaygManager.PaygErrorDomain, PaygManager.PaygError.INVALID_CODE)) {
            this._setErrorMessage(_("Invalid code"));
        } else if (error.matches(PaygManager.PaygErrorDomain, PaygManager.PaygError.CODE_ALREADY_USED)) {
            this._setErrorMessage(_("Code already used"));
        } else if (error.matches(PaygManager.PaygErrorDomain, PaygManager.PaygError.TOO_MANY_ATTEMPTS)) {
            this._setErrorMessage(_("Too many attempts"));
        } else {
            // We don't consider any other error here (and we don't consider DISABLED explicitly,
            // since that should not happen), but still we need to show something to the user.
            this._setErrorMessage(_("Unknown error"));
        }

        // The actual error will show up in the journal, no matter what.
        logError(error, 'Error adding PAYG code');
    },

    _clearError: function() {
        this._setErrorMessage(null);
    },

    _addCodeCallback: function(error) {
        // We don't care about the result if we're closing the dialog.
        if (this._cancelled)
            return;

        if (error) {
            this._verificationStatus = UnlockStatus.FAILED;
            this._showError(error);
        } else {
            this._verificationStatus = UnlockStatus.SUCCEEDED;
            this._clearError();
        }

        this._reset();
    },

    _startVerifyingCode: function() {
        if (!this._validateCurrentCode())
            return;

        this._verificationStatus = UnlockStatus.VERIFYING;
        this._startSpinning();
        this._updateSensitivity();

        Main.paygManager.addCode(this._entry.code, this._addCodeCallback.bind(this));
    },

    addCharacter: function(unichar) {
        this._entry.addCharacter(unichar);
    },

    cancel: function() {
        this._reset();
        this.destroy();
    },

    finish: function(onComplete) {
        // Nothing to do other than calling the callback.
        if (onComplete)
            onComplete();
    },

    open: function(timestamp) {
        this.actor.show();

        if (this._isModal)
            return true;

        if (!Main.pushModal(this.actor, { timestamp: timestamp,
                                          actionMode: Shell.ActionMode.UNLOCK_SCREEN }))
            return false;

        this._isModal = true;

        return true;
    },

    popModal: function(timestamp) {
        if (this._isModal) {
            Main.popModal(this.actor, timestamp);
            this._isModal = false;
        }
    },

    destroy: function() {
        this.popModal();
        this._parentActor.remove_child(this.actor);
        this.actor.destroy();

        if (this._idleWatchId) {
            this._idleMonitor.remove_watch(this._idleWatchId);
            this._idleWatchId = 0;
        }
    }
});
Signals.addSignalMethods(PaygUnlockDialog.prototype);
