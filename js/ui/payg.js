// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
//
// Copyright (C) 2018-2020 Endless OS Foundation LLC
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

/* exported PaygUnlockCodeEntry, PaygUnlockUi, PaygUnlockWidget, PaygNotifier,
     ApplyCodeNotification, SPINNER_ICON_SIZE_PIXELS, UnlockStatus, timeToString,
     successMessage */

const { Clutter, Gio, GLib, GObject, Shell, St } = imports.gi;

const PaygManager = imports.misc.paygManager;

const Gettext = imports.gettext;
const Animation = imports.ui.animation;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;

const SUCCESS_DELAY_SECONDS = 3;

const SPINNER_ANIMATION_DELAY_MSECS = 1000;
const SPINNER_ANIMATION_TIME_MSECS = 300;
var SPINNER_ICON_SIZE_PIXELS = 16;

var UnlockStatus = {
    NOT_VERIFYING: 0,
    VERIFYING: 1,
    FAILED: 2,
    TOO_MANY_ATTEMPTS: 3,
    SUCCEEDED: 4,
};

var PaygUnlockCodeEntry = GObject.registerClass({
    Signals: {
        'code-changed': { param_types: [GObject.TYPE_STRING] },
    },
}, class PaygUnlockCodeEntry extends St.Entry {
    _init(params) {
        super._init(params);

        this._code = '';
        this._enabled = false;
        this._buttonPressEventId = this.connect('button-press-event', this._onButtonPressEvent.bind(this));
        this._capturedEventId = this.clutter_text.connect('captured-event', this._onCapturedEvent.bind(this));
        this._textChangedId = this.clutter_text.connect('text-changed', this._onTextChanged.bind(this));

        this.connect('destroy', this._onDestroy.bind(this));
    }

    _onDestroy() {
        if (this._buttonPressEventId > 0) {
            this.disconnect(this._buttonPressEventId);
            this._buttonPressEventId = 0;
        }

        if (this._capturedEventId > 0) {
            this.clutter_text.disconnect(this._capturedEventId);
            this._capturedEventId = 0;
        }

        if (this._textChangedId > 0) {
            this.clutter_text.disconnect(this._textChangedId);
            this._textChangedId = 0;
        }
    }

    _onCapturedEvent(textActor, event) {
        if (event.type() !== Clutter.EventType.KEY_PRESS)
            return Clutter.EVENT_PROPAGATE;

        const keysym = event.get_key_symbol();
        const isDeleteKey =
            keysym === Clutter.KEY_Delete ||
            keysym === Clutter.KEY_KP_Delete ||
            keysym === Clutter.KEY_BackSpace;
        const isEnterKey =
            keysym === Clutter.KEY_Return ||
            keysym === Clutter.KEY_KP_Enter ||
            keysym === Clutter.KEY_ISO_Enter;
        const isExitKey =
            keysym === Clutter.KEY_Escape ||
            keysym === Clutter.KEY_Tab;
        const isMovementKey =
            keysym === Clutter.KEY_Left ||
            keysym === Clutter.KEY_Right ||
            keysym === Clutter.KEY_Home ||
            keysym === Clutter.KEY_KP_Home ||
            keysym === Clutter.KEY_End ||
            keysym === Clutter.KEY_KP_End;

        // Make sure we can leave the entry and delete and
        // navigate numbers with the keyboard.
        if (isExitKey || isEnterKey || isDeleteKey || isMovementKey)
            return Clutter.EVENT_PROPAGATE;

        const character = event.get_key_unicode();
        this.addCharacter(character);

        return Clutter.EVENT_STOP;
    }

    _onTextChanged(textActor) {
        this._code = textActor.text;
        this.emit('code-changed', this._code);
    }

    _onButtonPressEvent() {
        if (!this._enabled)
            return;

        this.grab_key_focus();
        return false;
    }

    addCharacter(character) {
        if (!this._enabled || !GLib.unichar_isprint(character) ||
            character === Main.paygManager.codeFormatPrefix ||
            character === Main.paygManager.codeFormatSuffix)
            return;

        const pos = this.clutter_text.get_cursor_position();
        const before = pos === -1 ? this._code : this._code.slice(0, pos);
        const after = pos === -1 ? '' : this._code.slice(pos);
        const newCode = before + character + after;

        if (!Main.paygManager.validateCode(newCode, true))
            return;

        this.clutter_text.insert_unichar(character);
    }

    setEnabled(value) {
        if (this._enabled === value)
            return;

        this._enabled = value;
        this.reactive = value;
        this.can_focus = value;
        this.clutter_text.reactive = value;
        this.clutter_text.editable = value;
        this.clutter_text.cursor_visible = value;
    }

    reset() {
        this.text = '';
    }

    get code() {
        return this._code;
    }

    get length() {
        return this._code.length;
    }
});

var PaygUnlockUi = GObject.registerClass({
    Signals: {
        'code-reset': {},
    },
}, class PaygUnlockUi extends St.Widget {

    // the following properties and functions are required for any subclasses of
    // this class

    // properties
    // -----------
    // applyButton
    // entryCode
    // spinner
    // verificationStatus

    // functions
    // ----------
    // entryReset
    // entrySetEnabled
    // onCodeAdded
    // reset

    _init(params = {}) {
        super._init(params);
        this._clearTooManyAttemptsId = 0;
        this.connect('destroy', this._onDestroy.bind(this));
    }

    updateApplyButtonSensitivity() {
        const sensitive = this.validateCurrentCode(false) &&
            this.verificationStatus !== UnlockStatus.VERIFYING &&
            this.verificationStatus !== UnlockStatus.SUCCEEDED &&
            this.verificationStatus !== UnlockStatus.TOO_MANY_ATTEMPTS;

        this.applyButton.reactive = sensitive;
        this.applyButton.can_focus = sensitive;
    }

    updateSensitivity() {
        const shouldEnableEntry =
            this.verificationStatus !== UnlockStatus.VERIFYING &&
            this.verificationStatus !== UnlockStatus.SUCCEEDED &&
            this.verificationStatus !== UnlockStatus.TOO_MANY_ATTEMPTS;

        this.updateApplyButtonSensitivity();
        this.entrySetEnabled(shouldEnableEntry);
    }

    processError(error) {
        logError(error, 'Error adding PAYG code');

        // The 'too many errors' case is a bit special, and sets a different state.
        if (error.matches(PaygManager.PaygErrorDomain, PaygManager.PaygError.TOO_MANY_ATTEMPTS)) {
            const currentTime = Shell.util_get_boottime() / GLib.USEC_PER_SEC;
            const secondsLeft = Main.paygManager.rateLimitEndTime - currentTime;
            if (secondsLeft > 30) {
                const minutesLeft = Math.max(0, Math.ceil(secondsLeft / 60));
                this.setErrorMessage(
                    Gettext.ngettext(
                        'Too many attempts. Try again in %s minute.',
                        'Too many attempts. Try again in %s minutes.', minutesLeft)
                        .format(minutesLeft));
            } else {
                this.setErrorMessage(_('Too many attempts. Try again in a few seconds.'));
            }

            // Make sure to clean the status once the time is up (if this dialog is still alive)
            // and make sure that we install this callback at some point in the future (+1 sec).
            this._clearTooManyAttemptsId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                Math.max(1, secondsLeft),
                () => {
                    this._verificationStatus = UnlockStatus.NOT_VERIFYING;
                    this._clearError();
                    this._updateSensitivity();
                    return GLib.SOURCE_REMOVE;
                });

            this.verificationStatus = UnlockStatus.TOO_MANY_ATTEMPTS;
            return;
        }

        // Common errors after this point.
        if (error.matches(PaygManager.PaygErrorDomain, PaygManager.PaygError.INVALID_CODE)) {
            this.setErrorMessage(_('Invalid keycode. Please try again.'));
        } else if (error.matches(PaygManager.PaygErrorDomain, PaygManager.PaygError.CODE_ALREADY_USED)) {
            this.setErrorMessage(_('Keycode already used. Please enter a new keycode.'));
        } else if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT)) {
            this.setErrorMessage(_('Time exceeded while verifying the keycode'));
        } else if (error.matches(PaygManager.PaygErrorDomain, PaygManager.PaygError.SHOW_ACCOUNT_ID)) {
            this.setErrorMessage(_('Your Pay As You Go Account ID is: %s').format(Main.paygManager.accountID));
        } else {
            // We don't consider any other error here (and we don't consider DISABLED explicitly,
            // since that should not happen), but still we need to show something to the user.
            this.setErrorMessage(_('Unknown error'));
        }

        this.verificationStatus = UnlockStatus.FAILED;
    }

    processReset() {
        // If time has been removed entirely, we show the user the according message
        // that the time has been reset to zero.
        this.emit('code-reset');
        this.verificationStatus = UnlockStatus.FAILED;
    }

    _onDestroy() {
        if (this._clearTooManyAttemptsId > 0) {
            GLib.source_remove(this._clearTooManyAttemptsId);
            this._clearTooManyAttemptsId = 0;
        }
    }

    setErrorMessage(message) {
        if (message) {
            this.errorLabel.text = message;
            this.errorLabel.opacity = 255;
        } else {
            this.errorLabel.text = '';
            this.errorLabel.opacity = 0;
        }
    }

    clearError() {
        this.setErrorMessage(null);
    }

    startSpinning() {
        this.spinner.play();
        this.spinner.show();
        this.spinner.ease({
            opacity: 255,
            delay: SPINNER_ANIMATION_DELAY_MSECS,
            duration: SPINNER_ANIMATION_TIME_MSECS,
            mode: Clutter.AnimationMode.LINEAR,
        });
    }

    stopSpinning() {
        this.spinner.hide();
        this.spinner.opacity = 0;
        this.spinner.stop();
    }

    reset() {
        this.stopSpinning();
        this.entryReset();
        this.updateSensitivity();
    }

    validateCurrentCode(partial=true) {
        return Main.paygManager.validateCode(this.entryCode, partial);
    }

    startVerifyingCode() {
        if (!this.validateCurrentCode(false))
            return;

        this.verificationStatus = UnlockStatus.VERIFYING;
        this.startSpinning();
        this.updateSensitivity();
        this.cancelled = false;

        const code = '%s%s%s'.format(
            Main.paygManager.codeFormatPrefix,
            this.entryCode,
            Main.paygManager.codeFormatSuffix);

        Main.paygManager.addCode(code, error => {
            // We don't care about the result if we're closing the dialog.
            if (this.cancelled) {
                this.verificationStatus = UnlockStatus.NOT_VERIFYING;
                return;
            }

            if (error) {
                this.processError(error);
            } else if (Main.paygManager.lastTimeAdded <= 0) {
                this.processReset();
            } else {
                this.verificationStatus = UnlockStatus.SUCCEEDED;
                this.onCodeAdded();
            }

            this.reset();
        });
    }
});

var PaygUnlockWidget = GObject.registerClass({
    Signals: {
        'code-added': {},
        'code-rejected': { param_types: [GObject.TYPE_STRING] },
    },
}, class PaygUnlockWidget extends PaygUnlockUi {
    _init() {
        super._init();

        this._verificationStatus = UnlockStatus.NOT_VERIFYING;
        this._codeEntry = this._createCodeEntry();
        this._spinner = this._createSpinner();
        const entrySpinnerBox = new St.BoxLayout({
            style_class: 'notification-actions',
            x_expand: false,
        });
        if (Main.paygManager.codeFormatPrefix !== '') {
            const prefix = new St.Label({
                style_class: 'notification-payg-code-entry',
                text: Main.paygManager.codeFormatPrefix,
                x_align: Clutter.ActorAlign.CENTER,
            });

            entrySpinnerBox.add_child(prefix);
        }
        entrySpinnerBox.add_child(this._codeEntry);
        entrySpinnerBox.add_child(this._spinner);

        if (Main.paygManager.codeFormatSuffix !== '') {
            const suffix = new St.Label({
                style_class: 'notification-payg-code-entry',
                text: Main.paygManager.codeFormatSuffix,
                x_align: Clutter.ActorAlign.CENTER,
            });

            entrySpinnerBox.add_child(suffix);
        }

        this._buttonBox = new St.BoxLayout({
            style_class: 'notification-actions',
            x_expand: true,
            vertical: true,
        });
        global.focus_manager.add_group(this._buttonBox);
        this._buttonBox.add_child(entrySpinnerBox);

        this._applyButton = this._createApplyButton();
        this._applyButton.connect('clicked', this.startVerifyingCode.bind(this));
        this._buttonBox.add_child(this._applyButton);

        this.updateSensitivity();
    }

    _createCodeEntry() {
        const codeEntry = new PaygUnlockCodeEntry({
            style_class: 'notification-payg-entry',
            x_expand: true,
            can_focus: true,
        });
        codeEntry.clutter_text.connect('activate', this.startVerifyingCode.bind(this));
        codeEntry.clutter_text.connect('text-changed', this.updateApplyButtonSensitivity.bind(this));
        codeEntry._enabled = true;

        return codeEntry;
    }

    _createSpinner() {
        // We make the most of the spacer to show the spinner while verifying the code.
        const spinnerIcon = Gio.File.new_for_uri('resource:///org/gnome/shell/theme/process-working.svg');
        const spinner = new Animation.AnimatedIcon(spinnerIcon, SPINNER_ICON_SIZE_PIXELS);
        spinner.opacity = 0;
        spinner.hide();

        return spinner;
    }

    _createApplyButton() {
        const box = new St.BoxLayout();

        const label = new St.Bin({
            x_expand: true,
            child: new St.Label({
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                text: _('Apply Keycode'),
            }),
        });
        box.add_child(label);

        const button = new St.Button({
            child: box,
            x_expand: true,
            button_mask: St.ButtonMask.ONE,
            style_class: 'hotplug-notification-item button',
        });

        return button;
    }

    setErrorMessage(message) {
        this.emit('code-rejected', message);
    }

    _onEntryChanged() {
        this.updateApplyButtonSensitivity();
    }

    onCodeAdded() {
        this.emit('code-added');
    }

    entryReset() {
        this._codeEntry.set_text('');
    }

    entrySetEnabled(enabled) {
        if (this._codeEntry._enabled === enabled)
            return;

        this._codeEntry._enabled = enabled;
        this._codeEntry.reactive = enabled;
        this._codeEntry.can_focus = enabled;
        this._codeEntry.clutter_text.reactive = enabled;
        this._codeEntry.clutter_text.editable = enabled;
        this._codeEntry.clutter_text.cursor_visible = enabled;
    }

    get entryCode() {
        return this._codeEntry.get_text();
    }

    get verificationStatus() {
        return this._verificationStatus;
    }

    set verificationStatus(value) {
        this._verificationStatus = value;
    }

    get spinner() {
        return this._spinner;
    }

    get applyButton() {
        return this._applyButton;
    }

    get buttonBox() {
        return this._buttonBox;
    }

});

var ApplyCodeNotification = GObject.registerClass({
    Signals: {
        'done-displaying': {},
    },
}, class ApplyCodeNotification extends MessageTray.Notification {
    _init(source, title, banner) {
        super._init(source, title, banner);

        this._titleOrig = title;

        // Note: "banner" is actually the string displayed in the banner, not a
        // banner object. This variable name simply follows the convention of
        // the parent class.
        this._bannerOrig = banner;
        this._verificationStatus = UnlockStatus.NOT_VERIFYING;

        this._codeAddedId = 0;
        this._codeRejectedId = 0;
        this._doneId = 0;

        this.connect('destroy', this._onDestroy.bind(this));
    }

    _onDestroy() {
        if (this._codeAddedId > 0) {
            this._unlockWidget.disconnect(this._codeAddedId);
            this._codeAddedId = 0;
        }

        if (this._codeRejectedId > 0) {
            this._unlockWidget.disconnect(this._codeRejectedId);
            this._codeRejectedId = 0;
        }

        if (this._doneId > 0) {
            GLib.source_remove(this._doneId);
            this._doneId = 0;
        }
    }

    createBanner() {
        if (this._codeAddedId > 0) {
            this._unlockWidget.disconnect(this._codeAddedId);
            this._codeAddedId = 0;
        }

        if (this._codeRejectedId > 0) {
            this._unlockWidget.disconnect(this._codeRejectedId);
            this._codeRejectedId = 0;
        }

        this._banner = new MessageTray.NotificationBanner(this);
        this._unlockWidget = new PaygUnlockWidget();
        this._codeAddedId = this._unlockWidget.connect('code-added', this._onCodeAdded.bind(this));
        this._codeRejectedId = this._unlockWidget.connect('code-rejected', this._onCodeRejected.bind(this));
        this._banner.setActionArea(this._unlockWidget.buttonBox);

        return this._banner;
    }

    _onCodeAdded() {
        this._setMessage(successMessage());

        if (this._doneId > 0) {
            GLib.source_remove(this._doneId);
            this._doneId = 0;
        }

        this._doneId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            SUCCESS_DELAY_SECONDS,
            () => {
                this.emit('done-displaying');
                this.destroy();

                return GLib.SOURCE_REMOVE;
            });
    }

    // if errorMessage is unspecified, a default message will be populated based
    // on whether time remains
    _onCodeRejected(unlockWidget, errorMessage) {
        this._setMessage(errorMessage ? errorMessage : this._bannerOrig);
    }

    _setMessage(message) {
        this.update(this._titleOrig, message);
    }

    activate() {
        // We get here if the Apply button is inactive when we try to click it.
        // Unless we're already done, exit early so we don't destroy the
        // notification)
        if (this._verificationStatus !== UnlockStatus.SUCCEEDED)
            return;

        super.activate();
    }
});

// Takes a number of seconds and returns a string
// with a precision level appropriate to show to the user.
//
// The returned string will be formatted just in seconds for times
// under 1 minute, in minutes for times under 2 hours, in hours and
// minutes (if applicable) for times under 1 day, and then in days
// and hours (if applicable) for anything longer than that in days.
//
// Some examples:
//   - 45 seconds => "45 seconds"
//   - 60 seconds => "1 minute"
//   - 95 seconds => "1 minute"
//   - 120 seconds => "2 minutes"
//   - 3600 seconds => "60 minutes"
//   - 4500 seconds => "75 minutes"
//   - 7200 seconds => "2 hours"
//   - 8640 seconds => "2 hours 24 minutes"
//   - 86400 seconds => "1 day"
//   - 115200 seconds => "1 day 8 hours"
//   - 172800 seconds => "2 days"
function timeToString(seconds) {
    if (seconds < 60)
        return Gettext.ngettext('%s second', '%s seconds', seconds).format(Math.floor(seconds));

    const minutes = Math.floor(seconds / 60);
    if (minutes < 120)
        return Gettext.ngettext('%s minute', '%s minutes', minutes).format(minutes);

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        const hoursStr = Gettext.ngettext('%s hour', '%s hours', hours).format(hours);

        const minutesPast = minutes % 60;
        if (minutesPast === 0)
            return hoursStr;

        const minutesStr = Gettext.ngettext('%s minute', '%s minutes', minutesPast).format(minutesPast);
        return '%s %s'.format(hoursStr, minutesStr);
    }

    const days = Math.floor(hours / 24);
    const daysStr = Gettext.ngettext('%s day', '%s days', days).format(days);

    const hoursPast = hours % 24;
    if (hoursPast === 0)
        return daysStr;

    const hoursStr = Gettext.ngettext('%s hour', '%s hours', hoursPast).format(hoursPast);
    return '%s %s'.format(daysStr, hoursStr);
}

// Similar to timeToString, but does not process partial time,
// since it's meant to be used for expiration time changes, with
// a wider range of periods
function successMessage() {
    const seconds = Main.paygManager.lastTimeAdded;
    if (seconds < 60) {
        return Gettext.ngettext("%s second has been added to your Pay As You Go credit.",
                                "%s seconds have been added to your Pay As You Go credit.",
                                Math.floor(seconds))
                                .format(Math.floor(seconds));
    }

    const minutes = Math.floor(seconds / 60);
    if (minutes < 120) {
        return Gettext.ngettext("%s minute has been added to your Pay As You Go credit.",
                                "%s minutes have been added to your Pay As You Go credit.",
                                Math.floor(minutes))
                                .format(Math.floor(minutes));
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return Gettext.ngettext("%s hour has been added to your Pay As You Go credit.",
                                "%s hours have been added to your Pay As You Go credit.",
                                Math.floor(hours))
                                .format(Math.floor(hours));
    }

    const days = Math.floor(hours / 24);
    if (days < 30) {
        return Gettext.ngettext("%s day has been added to your Pay As You Go credit.",
                                "%s days have been added to your Pay As You Go credit.",
                                Math.floor(days))
                                .format(Math.floor(days));
    }

    const months = Math.floor(days / 30);
    if (months < 12) {
        return Gettext.ngettext("%s month has been added to your Pay As You Go credit.",
                                "%s months have been added to your Pay As You Go credit.",
                                Math.floor(months))
                                .format(Math.floor(months));
    }

    const year = Math.floor(months / 12);
    if (year == 1)
        return _("1 year has been added to your Pay As You Go credit.");

    //Unlock permanently message
    return _("You have successfully unlocked your Endless Machine");
}

var PaygNotifier = GObject.registerClass(
class PaygNotifier extends GObject.Object {
    _init() {
        super._init();

        this._notification = null;
    }

    notify(secondsLeft) {
        // Only notify when in an regular session, not in GDM or initial-setup.
        if (!Main.sessionMode.hasOverview)
            return;

        // Clear previous notification
        this.clearNotification();

        const source = new MessageTray.SystemNotificationSource();
        Main.messageTray.add(source);

        // by default, this notification is for early entry of an unlock keycode
        let codeLength = Main.paygManager.codeLength;
        let messageText = Gettext.ngettext(
            'Enter a new keycode (%s character) to extend the time before your credit expires.',
            'Enter a new keycode (%s characters) to extend the time before your credit expires.',
            codeLength).format(codeLength);
        let urgency = MessageTray.Urgency.NORMAL;
        let userInitiated = false;

        // in case this is a "only X time left" warning notification
        if (secondsLeft >= 0) {
            const timeLeft = timeToString(secondsLeft);
            messageText = _('Subscription expires in %s.').format(timeLeft);
            urgency = MessageTray.Urgency.HIGH;
        } else {
            userInitiated = true;
        }

        this._notification = new ApplyCodeNotification(
            source,
            _('Pay As You Go'),
            messageText);

        if (userInitiated)
            this._notification.setResident(true);

        this._notification.setTransient(false);
        this._notification.setUrgency(urgency);
        source.showNotification(this._notification);

        // if the user triggered this notification, immediately expand so the
        // user sees the input field
        if (userInitiated)
            Main.messageTray._expandActiveNotification();

        this._notification.connect('destroy', () => {
            this._notification = null;
        });
    }

    clearNotification() {
        if (this._notification) {
            this._notification.destroy();
            this._notification = null;
        }
    }
});
