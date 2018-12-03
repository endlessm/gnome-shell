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

        this._isLoaded = false;
        this._isPlaying = false;
        this._timeoutId = 0;
        this._framesInfo = [];
        this._frameIndex = 0;

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
            if (this._frameIndex == 0)
                this._frameIndex = this._framesInfo.length - 1;
            else
                this._frameIndex -= 1;

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

    _getCurrentFrame: function() {
        return this._framesInfo[this._frameIndex];
    },

    _getCurrentFrameActor: function() {
        let currentFrame = this._getCurrentFrame();
        return this._animations.get_child_at_index(currentFrame.frameIndex);
    },

    _getCurrentDelay: function() {
        let currentFrame = this._getCurrentFrame();
        return currentFrame.frameDelay;
    },

    _showFrame: function(frame) {
        let oldFrameActor = this._getCurrentFrameActor();
        if (oldFrameActor)
            oldFrameActor.hide();

        this._frameIndex = (frame % this._framesInfo.length);

        let newFrameActor = this._getCurrentFrameActor();
        if (newFrameActor)
            newFrameActor.show();
    },

    _update: function() {
        this._showFrame(this._frameIndex + 1);

        // Show the next frame after the timeout of the current one
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_LOW, this._getCurrentDelay(),
                                           Lang.bind(this, this._update));

        GLib.Source.set_name_by_id(this._timeoutId, '[gnome-shell] this._update');

        return GLib.SOURCE_REMOVE;
    },

    _animationsLoaded: function() {
        this._isLoaded = this._animations.get_n_children() > 0;

        if (this._isLoaded && this._framesInfo.length === 0) {
            // If a custom sequence of frames wasn't provided,
            // fallback to play the frames in sequence.
            for (let i = 0; i < this._animations.get_n_children(); i++)
                this._framesInfo.push({'frameIndex': i, 'frameDelay': this._speed});
        }

        if (this._isPlaying)
            this.play();
    },

    _onDestroy: function() {
        this.stop();
    },

    setFramesInfo: function(framesInfo) {
        let wasPlaying = this._isPlaying;
        this.stop();

        this._framesInfo = framesInfo;

        // If the animation was playing, we continue to play it here
        // (where it will use the new frames)
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
