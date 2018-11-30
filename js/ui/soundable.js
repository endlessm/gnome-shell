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
        this._hover_sound_item =
            new SoundServer.SoundItem(this._hover_sound_event_id);
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
        this._hover_sound_item.play();
    },

    _stopHoverSound() {
        this._hover_sound_item.stop();
    }
});
