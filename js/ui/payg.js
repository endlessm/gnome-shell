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

const Clutter = imports.gi.Clutter;
const Gettext = imports.gettext;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const St = imports.gi.St;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Signals = imports.signals;

const PaygManager = imports.misc.paygManager;

const Animation = imports.ui.animation;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const Tweener = imports.ui.tweener;

var SUCCESS_DELAY_SECONDS = 3;

var SPINNER_ICON_SIZE_PIXELS = 16;
var SPINNER_ANIMATION_DELAY_SECS = 1.0;
var SPINNER_ANIMATION_TIME_SECS = 0.3;

const NOTIFICATION_TITLE_TEXT = _("PayGo");
const NOTIFICATION_EARLY_CODE_ENTRY_TEXT = _("Enter an unlock code to extend PayGo time before expiration.");
const NOTIFICATION_DETAILED_FORMAT_STRING = _("Subscription runs out in %s.");

var UnlockStatus = {
    NOT_VERIFYING: 0,
    VERIFYING: 1,
    FAILED: 2,
    TOO_MANY_ATTEMPTS: 3,
    SUCCEEDED: 4,
};

var UnlockUi = new Lang.Class({
    Name: 'PaygUnlockUi',
    Extends: GObject.Object,

    // the following properties and functions are required for any subclasses of
    // this class

    // properties
    //-----------
    //applyButton
    //entryCode
    //spinner
    //verificationStatus

    // functions
    //----------
    //entryReset
    //entrySetEnabled
    //onCodeAdded
    //reset

    _init() {
        this.parent();
        this._clearTooManyAttemptsId = 0;
        this.connect('destroy', this._onDestroy.bind(this));
    },

    updateApplyButtonSensitivity() {
        let sensitive = this.validateCurrentCode() &&
            this.verificationStatus != UnlockStatus.VERIFYING &&
            this.verificationStatus != UnlockStatus.SUCCEEDED &&
            this.verificationStatus != UnlockStatus.TOO_MANY_ATTEMPTS;

        this.applyButton.reactive = sensitive;
        this.applyButton.can_focus = sensitive;
    },

    updateSensitivity() {
        let shouldEnableEntry = this.verificationStatus != UnlockStatus.VERIFYING &&
            this.verificationStatus != UnlockStatus.SUCCEEDED &&
            this.verificationStatus != UnlockStatus.TOO_MANY_ATTEMPTS;

        this.updateApplyButtonSensitivity();
        this.entrySetEnabled(shouldEnableEntry);
    },

    processError(error) {
        logError(error, 'Error adding PAYG code');

        // The 'too many errors' case is a bit special, and sets a different state.
        if (error.matches(PaygManager.PaygErrorDomain, PaygManager.PaygError.TOO_MANY_ATTEMPTS)) {
            let currentTime = GLib.get_real_time() / GLib.USEC_PER_SEC;
            let secondsLeft = Main.paygManager.rateLimitEndTime - currentTime;
            if (secondsLeft > 30) {
                let minutesLeft = Math.max(0, Math.ceil(secondsLeft / 60));
                this.setErrorMessage(Gettext.ngettext("Too many attempts. Try again in %s minute.",
                                                      "Too many attempts. Try again in %s minutes.", minutesLeft)
                                      .format(minutesLeft));
            } else {
                this.setErrorMessage(_("Too many attempts. Try again in a few seconds."));
            }

            // Make sure to clean the status once the time is up (if this dialog is still alive)
            // and make sure that we install this callback at some point in the future (+1 sec).
            this._clearTooManyAttemptsId = Mainloop.timeout_add_seconds(Math.max(1, secondsLeft), () => {
                this.verificationStatus = UnlockStatus.NOT_VERIFYING;
                this.clearError();
                this.updateSensitivity();
                return GLib.SOURCE_REMOVE;
            });

            this.verificationStatus = UnlockStatus.TOO_MANY_ATTEMPTS;
            return;
        }

        // Common errors after this point.
        if (error.matches(PaygManager.PaygErrorDomain, PaygManager.PaygError.INVALID_CODE)) {
            this.setErrorMessage(_("Invalid code. Please try again."));
        } else if (error.matches(PaygManager.PaygErrorDomain, PaygManager.PaygError.CODE_ALREADY_USED)) {
            this.setErrorMessage(_("Code already used. Please enter a new code."));
        } else if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT)) {
            this.setErrorMessage(_("Time exceeded while verifying the code"));
        } else {
            // We don't consider any other error here (and we don't consider DISABLED explicitly,
            // since that should not happen), but still we need to show something to the user.
            this.setErrorMessage(_("Unknown error"));
        }

        this.verificationStatus = UnlockStatus.FAILED;
    },

    _onDestroy() {
        if (this._clearTooManyAttemptsId > 0) {
            Mainloop.source_remove(this._clearTooManyAttemptsId);
            this._clearTooManyAttemptsId = 0;
        }
    },

    setErrorMessage(message) {
        if (message) {
            this.errorLabel.text = message;
            this.errorLabel.opacity = 255;
        } else {
            this.errorLabel.text = '';
            this.errorLabel.opacity = 0;
        }
    },

    clearError() {
        this.setErrorMessage(null);
    },

    startSpinning() {
        this.spinner.play();
        this.spinner.actor.show();
        Tweener.addTween(this.spinner.actor,
                         { opacity: 255,
                           time: SPINNER_ANIMATION_TIME_SECS,
                           delay: SPINNER_ANIMATION_DELAY_SECS,
                           transition: 'linear' });
    },

    stopSpinning() {
        this.spinner.actor.hide();
        this.spinner.actor.opacity = 0;
        this.spinner.stop();
    },

    reset() {
        this.stopSpinning();
        this.entryReset();
        this.updateSensitivity();
    },

    validateCurrentCode() {
        return Main.paygManager.validateCode(this.entryCode);
    },

    startVerifyingCode() {
        if (!this.validateCurrentCode())
            return;

        this.verificationStatus = UnlockStatus.VERIFYING;
        this.startSpinning();
        this.updateSensitivity();
        this.cancelled = false;

        Main.paygManager.addCode(this.entryCode, (error) => {
            // We don't care about the result if we're closing the dialog.
            if (this.cancelled) {
                this.verificationStatus = UnlockStatus.NOT_VERIFYING;
                return;
            }

            if (error) {
                this.processError(error);
            } else {
                this.verificationStatus = UnlockStatus.SUCCEEDED;
                this.onCodeAdded();
            }

            this.reset();
        });
    },
});

var PaygUnlockWidget = new Lang.Class({
    Name: 'PaygUnlockWidget',
    Extends: UnlockUi,
    Signals: { 'code-added' : {},
               'code-rejected' : { param_types: [GObject.TYPE_STRING] } },

    _init() {
        this.parent();

        this._verificationStatus = UnlockStatus.NOT_VERIFYING;
        this._codeEntry = this._createCodeEntry();
        this._spinner = this._createSpinner();
        let entrySpinnerBox = new St.BoxLayout({ style_class: 'notification-actions',
                                                 x_expand: false, });
        entrySpinnerBox.add_child(this._codeEntry);
        entrySpinnerBox.add_child(this._spinner.actor);

        this._buttonBox = new St.BoxLayout({ style_class: 'notification-actions',
                                                     x_expand: true,
                                                     vertical: true, });
        global.focus_manager.add_group(this._buttonBox);
        this._buttonBox.add(entrySpinnerBox);

        this._applyButton = this._createApplyButton();
        this._applyButton.connect('clicked', Lang.bind(this, () => {
            this.startVerifyingCode();
        }));
        this._buttonBox.add(this._applyButton);

        this.updateSensitivity();
    },

    _createCodeEntry() {
        let codeEntry = new St.Entry({ style_class: 'notification-payg-entry',
                                       x_expand: true,
                                       can_focus: true });
        codeEntry.clutter_text.connect('activate', Lang.bind(this, this.startVerifyingCode));
        codeEntry.clutter_text.connect('text-changed', Lang.bind(this, this.updateApplyButtonSensitivity));
        codeEntry._enabled = true;

        return codeEntry;
    },

    _createSpinner() {
        // We make the most of the spacer to show the spinner while verifying the code.
        let spinnerIcon = Gio.File.new_for_uri('resource:///org/gnome/shell/theme/process-working.svg');
        let spinner = new Animation.AnimatedIcon(spinnerIcon, SPINNER_ICON_SIZE_PIXELS);
        spinner.actor.opacity = 0;
        spinner.actor.hide();

        return spinner;
    },

    _createApplyButton() {
        let box = new St.BoxLayout();

        let label = new St.Bin({ x_expand: true,
                                 child: new St.Label ({
                                                        x_expand: true,
                                                        x_align: Clutter.ActorAlign.CENTER,
                                                        text: _("Apply Code")
                                                       })
                               });
        box.add(label);

        let button = new St.Button({ child: box,
                                     x_fill: true,
                                     x_expand: true,
                                     button_mask: St.ButtonMask.ONE,
                                     style_class: 'hotplug-notification-item button' });

        return button;
    },

    setErrorMessage(message) {
        this.emit('code-rejected', message);
    },

    _onEntryChanged() {
        this.updateApplyButtonSensitivity();
    },

    onCodeAdded() {
        this.emit('code-added');
    },

    entryReset() {
        this._codeEntry.clutter_text.set_text("");
    },

    entrySetEnabled(enabled) {
        if (this._codeEntry._enabled == enabled)
            return;

        this._codeEntry._enabled = enabled;
        this._codeEntry.reactive = enabled;
        this._codeEntry.can_focus = enabled;
        this._codeEntry.clutter_text.reactive = enabled;
        this._codeEntry.clutter_text.editable = enabled;
        this._codeEntry.clutter_text.cursor_visible = enabled;
    },

    get entryCode () {
        return this._codeEntry.get_text();
    },

    get verificationStatus () {
        return this._verificationStatus;
    },

    set verificationStatus (value) {
        this._verificationStatus = value;
    },

    get spinner () {
        return this._spinner;
    },

    get applyButton () {
        return this._applyButton;
    },

    get buttonBox () {
        return this._buttonBox;
    },

});
Signals.addSignalMethods(PaygUnlockWidget.prototype);

var ApplyCodeNotification = new Lang.Class({
    Name: 'ApplyCodeNotification',
    Extends: MessageTray.Notification,

    _init(source, title, banner) {
        this._titleOrig = title;
        // Note: "banner" is actually the string displayed in the banner, not a
        // banner object. This variable name simply follows the convention of
        // the parent class.
        this._bannerOrig = banner;
        this._verificationStatus = UnlockStatus.NOT_VERIFYING;

        this.parent(source, title, banner);
    },

    createBanner() {
        this._banner = new MessageTray.NotificationBanner(this);
        this._unlockWidget = new PaygUnlockWidget();
        this._unlockWidget.connect('code-added', Lang.bind(this, this._onCodeAdded));
        this._unlockWidget.connect('code-rejected', Lang.bind(this, this._onCodeRejected));
        this._banner.setActionArea(this._unlockWidget.buttonBox);

        return this._banner;
    },

    _onCodeAdded() {
        this._setMessage(_("Code applied successfully!"));

        Mainloop.timeout_add_seconds(SUCCESS_DELAY_SECONDS, () => {
            this.emit('done-displaying');
            this.destroy();

            return GLib.SOURCE_REMOVE;
        });
    },

    // if errorMessage is unspecified, a default message will be populated based
    // on whether time remains
    _onCodeRejected(unlockWidget, errorMessage) {
        this._setMessage(errorMessage ? errorMessage : this._bannerOrig);
    },

    _setMessage(message) {
        this.update(this._titleOrig, message);
    },

    activate() {
        // We get here if the Apply button is inactive when we try to click it.
        // Unless we're already done, exit early so we don't destroy the
        // notification)
        if (this._verificationStatus != UnlockStatus.SUCCEEDED)
            return;

        this.parent();
    }
});

// Takes an UNIX timestamp (in seconds) and returns a string
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
        return Gettext.ngettext("%s second", "%s seconds", seconds).format(Math.floor(seconds));

    let minutes = Math.floor(seconds / 60);
    if (minutes < 120)
        return Gettext.ngettext("%s minute", "%s minutes", minutes).format(minutes);

    let hours = Math.floor(minutes / 60);
    if (hours < 24) {
        let hoursStr = Gettext.ngettext("%s hour", "%s hours", hours).format(hours);

        let minutesPast = minutes % 60;
        if (minutesPast == 0)
            return hoursStr;

        let minutesStr = Gettext.ngettext("%s minute", "%s minutes", minutesPast).format(minutesPast);
        return ("%s %s").format(hoursStr, minutesStr);
    }

    let days = Math.floor(hours / 24);
    let daysStr = Gettext.ngettext("%s day", "%s days", days).format(days);

    let hoursPast = hours % 24;
    if (hoursPast == 0)
        return daysStr;

    let hoursStr = Gettext.ngettext("%s hour", "%s hours", hoursPast).format(hoursPast);
    return ("%s %s").format(daysStr, hoursStr);
}

var PaygNotifier = new Lang.Class({
    Name: 'PaygNotifier',

    _init() {
        this.parent();

        this._notification = null;
    },

    notify(secondsLeft) {
        // Only notify when in an regular session, not in GDM or initial-setup.
        if (Main.sessionMode.currentMode != 'user') {
            return;
        }

        if (this._notification)
            this._notification.destroy();

        let source = new MessageTray.SystemNotificationSource();
        Main.messageTray.add(source);

        // by default, this notification is for early entry of an unlock code
        let messageText = NOTIFICATION_EARLY_CODE_ENTRY_TEXT;
        let urgency = MessageTray.Urgency.NORMAL;
        let userInitiated = false;

        // in case this is a "only X time left" warning notification
        if (secondsLeft >= 0) {
            let timeLeft = timeToString(secondsLeft);
            messageText = NOTIFICATION_DETAILED_FORMAT_STRING.format(timeLeft);
            urgency = MessageTray.Urgency.HIGH;
        } else {
            userInitiated = true;
        }

        this._notification = new ApplyCodeNotification(source,
                                                       NOTIFICATION_TITLE_TEXT,
                                                       messageText);

        if (userInitiated)
            this._notification.setResident(true);

        this._notification.setTransient(false);
        this._notification.setUrgency(urgency);
        source.notify(this._notification);

        // if the user triggered this notification, immediately expand so the
        // user sees the input field
        if (userInitiated)
            Main.messageTray._expandActiveNotification();

        this._notification.connect('destroy', () => {
            this._notification = null;
        });
    },
});
