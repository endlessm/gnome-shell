// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;

const Lang = imports.lang;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const Tweener = imports.ui.tweener;

const ICON_BOUNCE_MAX_SCALE = 0.4;
const ICON_BOUNCE_ANIMATION_TIME = 0.4;
const ICON_BOUNCE_ANIMATION_TYPE_1 = 'easeOutSine';
const ICON_BOUNCE_ANIMATION_TYPE_2 = 'easeOutBounce';

const CodingGameIndicator = new Lang.Class({
    Name: 'CodingGameIndicator',
    Extends: PanelMenu.SingleIconButton,

    _init: function() {
        this.parent(_("Coding"), Clutter.ActorAlign.CENTER, Clutter.ActorAlign.CENTER);
        this.setIcon(Gio.icon_new_for_string('folder-drag-accept-symbolic'));
        this.mainIcon.width = 24;
        this.mainIcon.height = 24;
    },

    // overrides default implementation from PanelMenu.Button
    _onEvent: function(actor, event) {
        if (this.menu &&
            (event.type() == Clutter.EventType.TOUCH_BEGIN ||
             event.type() == Clutter.EventType.BUTTON_PRESS)) {
            // animate the icon on button press
            this._animateBounce();

            // pressing the button when the overview is being shown always displays the side bar
            if (Main.overview.visible)
                Main.codingManager.show(event.get_time());
            else
                Main.codingManager.toggle(event.get_time());
        }

        return Clutter.EVENT_PROPAGATE;
    },

    _animateBounce: function() {
        if (Tweener.isTweening(this.actor))
            return;

        Tweener.addTween(this.actor, {
            scale_y: 1 - ICON_BOUNCE_MAX_SCALE,
            scale_x: 1 + ICON_BOUNCE_MAX_SCALE,
            translation_y: this.actor.height * ICON_BOUNCE_MAX_SCALE,
            translation_x: -this.actor.width * ICON_BOUNCE_MAX_SCALE / 2,
            time: ICON_BOUNCE_ANIMATION_TIME * 0.25,
            transition: ICON_BOUNCE_ANIMATION_TYPE_1
        });
        Tweener.addTween(this.actor, {
            scale_y: 1,
            scale_x: 1,
            translation_y: 0,
            translation_x: 0,
            time: ICON_BOUNCE_ANIMATION_TIME * 0.75,
            transition: ICON_BOUNCE_ANIMATION_TYPE_2,
            delay: ICON_BOUNCE_ANIMATION_TIME * 0.25
        });
    },
});
