// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const St = imports.gi.St;
const Signals = imports.signals;
const Atk = imports.gi.Atk;

var ANIMATED_ICON_UPDATE_TIMEOUT = 16;

var Animation = new Lang.Class({
    Name: 'Animation',

    _init: function(file, width, height, speed) {
        this.actor = new St.Bin();
        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));
        this._speed = speed;
        this._frameTimeouts = [this._speed];

        this._isLoaded = false;
        this._isPlaying = false;
        this._timeoutId = 0;
        this._frame = 0;

        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._animations = St.TextureCache.get_default().load_sliced_image (file, width, height, scaleFactor,
                                                                            Lang.bind(this, this._animationsLoaded));
        this.actor.set_child(this._animations);
    },

    play: function() {
        if (this._isLoaded && this._timeoutId == 0) {
            // Set the frame to be the previous one, so when we update it
            // when play is called, it shows the current frame instead of
            // the next one.
            if (this._frame == 0)
                this._frame = this._animations.get_n_children() - 1;
            else
                this._frame -= 1;

            this._update();
        }

        this._isPlaying = true;
    },

    stop: function() {
        if (this._timeoutId > 0) {
            Mainloop.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        this._isPlaying = false;
    },

    _showFrame: function(frame) {
        let oldFrameActor = this._animations.get_child_at_index(this._frame);
        if (oldFrameActor)
            oldFrameActor.hide();

        this._frame = (frame % this._animations.get_n_children());

        let newFrameActor = this._animations.get_child_at_index(this._frame);
        if (newFrameActor)
            newFrameActor.show();
    },

    _update: function() {
        this._showFrame(this._frame + 1);

        // Show the next frame after the timeout of the current one
        let currentFrameTimeoutIndex = this._frame % this._frameTimeouts.length;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_LOW,
                                           this._frameTimeouts[currentFrameTimeoutIndex],
                                           Lang.bind(this, this._update));

        GLib.Source.set_name_by_id(this._timeoutId, '[gnome-shell] this._update');

        return GLib.SOURCE_REMOVE;
    },

    _animationsLoaded: function() {
        this._isLoaded = this._animations.get_n_children() > 0;

        if (this._isPlaying)
            this.play();
    },

    _onDestroy: function() {
        this.stop();
    },

    setFrameTimeouts: function(timeoutList) {
        if (timeoutList.length == 0)
            throw new Error('Cannot set an empty list as the frame-timeouts for animation!');

        let wasPlaying = this._isPlaying;
        this.stop();

        this._frameTimeouts = timeoutList;

        // If the animation was playing, we continue to play it here (where it will
        // use the new timeouts)
        if (wasPlaying)
            this.play();
    }
});

var AnimatedIcon = new Lang.Class({
    Name: 'AnimatedIcon',
    Extends: Animation,

    _init: function(file, size) {
        this.parent(file, size, size, ANIMATED_ICON_UPDATE_TIMEOUT);
    }
});
