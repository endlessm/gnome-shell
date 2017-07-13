// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const St = imports.gi.St;

const CloseButton = new Lang.Class({
    Name: 'CloseButton',
    Extends: St.Button,

    _init: function(boxpointer) {
        this.parent({ style_class: 'notification-close'});

        // This is a bit tricky. St.Bin has its own x-align/y-align properties
        // that compete with Clutter's properties. This should be fixed for
        // Clutter 2.0. Since St.Bin doesn't define its own setters, the
        // setters are a workaround to get Clutter's version.
        this.set_x_align(Clutter.ActorAlign.END);
        this.set_y_align(Clutter.ActorAlign.START);

        // XXX Clutter 2.0 workaround: ClutterBinLayout needs expand
        // to respect the alignments.
        this.set_x_expand(true);
        this.set_y_expand(true);

        this._boxPointer = boxpointer;
        if (boxpointer)
            this._boxPointer.connect('arrow-side-changed', Lang.bind(this, this._sync));
    },

    _computeBoxPointerOffset: function() {
        if (!this._boxPointer || !this._boxPointer.actor.get_stage())
            return 0;

        let side = this._boxPointer.arrowSide;
        if (side == St.Side.TOP)
            return this._boxPointer.getArrowHeight();
        else
            return 0;
    },

    _sync: function() {
        let themeNode = this.get_theme_node();

        let offY = this._computeBoxPointerOffset();
        this.translation_x = themeNode.get_length('-shell-close-overlap-x')
        this.translation_y = themeNode.get_length('-shell-close-overlap-y') + offY;
    },

    vfunc_style_changed: function() {
        this._sync();
        this.parent();
    },
});

function makeCloseButton(boxpointer) {
    return new CloseButton(boxpointer);
}
