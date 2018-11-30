const Lang = imports.lang;
const St = imports.gi.St;
const GObject = imports.gi.GObject;
const SoundServer = imports.misc.soundServer;


var Button = new Lang.Class({
    Name: 'SoundableButton',
    Extends: St.Button,
    Properties: {
        'click-sound-event-id': GObject.ParamSpec.string(
            'click-sound-event-id',
            '',
            '',
            GObject.ParamFlags.READWRITE,
            ''
        ),
        'hover-sound-event-id': GObject.ParamSpec.string(
            'hover-sound-event-id',
            '',
            '',
            GObject.ParamFlags.READWRITE,
            ''
        ),
        'stop-hover-sound-on-click': GObject.ParamSpec.boolean(
            'stop-hover-sound-on-click',
            '',
            '',
            GObject.ParamFlags.READWRITE,
            ''
        )
    },

    _init: function(params) {
        this.parent(params);
        if (this.stop_hover_sound_on_click === undefined)
            this.stop_hover_sound_on_click = false;
    },

    set hover_sound_event_id(value) {
        this._hover_sound_event_id = value;
        this.connect('notify::hover', this._onHoverChanged.bind(this));
    },

    set click_sound_event_id(value) {
        this._click_sound_event_id = value;
        this.connect('clicked', () => {
            if (this.stop_hover_sound_on_click) {
                this._stopHoverSound();
            }
            SoundServer.getDefault().play(this._click_sound_event_id);
        });
    },

    _onHoverChanged: function() {
        if (this.hover) {
            this._startHoverSound();
        } else {
            this._stopHoverSound();
        }
    },

    _startHoverSound() {
        if (this._hoverSoundID === 'pending')
            return;
        if (this._hoverSoundID === 'cancel') {
            // Hovered in and out and back in quickly, before the first UUID was
            // returned. In this case, un-cancel the original sound but don't
            // request another one.
            this._hoverSoundID = 'pending';
            return;
        }
        this._hoverSoundID = 'pending';
        SoundServer.getDefault().playAsync(this._hover_sound_event_id)
        .then(uuid => {
            if (this._hoverSoundID === 'cancel') {
                SoundServer.getDefault().stop(uuid);
                this._hoverSoundID = null;
                return;
            }

            this._hoverSoundID = uuid;
        });
    },

    _stopHoverSound() {
        if (this._hoverSoundID === 'pending') {
            this._hoverSoundID = 'cancel';
        } else if (this._hoverSoundID) {
            SoundServer.getDefault().stop(this._hoverSoundID);
            this._hoverSoundID = null;
        }
    }
});
