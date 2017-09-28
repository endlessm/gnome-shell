// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Lang = imports.lang;
const Gio = imports.gi.Gio;
const St = imports.gi.St;

const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Slider = imports.ui.slider;

const BUS_NAME = 'org.gnome.SettingsDaemon.Power';
const OBJECT_PATH = '/org/gnome/SettingsDaemon/Power';

const BrightnessInterface = '<node> \
<interface name="org.gnome.SettingsDaemon.Power.Screen"> \
<property name="Brightness" type="i" access="readwrite"/> \
</interface> \
</node>';

const BrightnessProxy = Gio.DBusProxy.makeProxyWrapper(BrightnessInterface);

const Indicator = new Lang.Class({
    Name: 'BrightnessIndicator',
    Extends: PanelMenu.SystemIndicator,

    _init: function() {
        this.parent('display-brightness-symbolic');
        this._proxy = new BrightnessProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH,
                                          Lang.bind(this, function(proxy, error) {
                                              if (error) {
                                                  log(error.message);
                                                  return;
                                              }

                                              this._proxy.connect('g-properties-changed', Lang.bind(this, this._sync));
                                              this._sync();
                                          }));

        this._item = new PopupMenu.PopupBaseMenuItem({ activate: false });
        this.menu.addMenuItem(this._item);

        this._slider = new Slider.Slider(0);
        this._slider.connect('value-changed', Lang.bind(this, this._sliderChanged));
        this._slider.connect('drag-begin', Lang.bind(this, this._sliderDragBegan));
        this._slider.connect('drag-end', Lang.bind(this, this._sliderDragEnded));

        this._slider.actor.accessible_name = _("Brightness");

        this._sliderIsDragging = false;
        this._sliderValue = this._proxy.Brightness / 100.0;

        let icon = new St.Icon({ icon_name: 'display-brightness-symbolic',
                                 style_class: 'popup-menu-icon' });
        this._item.actor.add(icon);
        this._item.actor.add(this._slider.actor, { expand: true });
        this._item.actor.connect('button-press-event', Lang.bind(this, function(actor, event) {
            return this._slider.startDragging(event);
        }));
        this._item.actor.connect('key-press-event', Lang.bind(this, function(actor, event) {
            return this._slider.onKeyPressEvent(actor, event);
        }));

    },

    _updateBrightness: function() {
        let percent = this._sliderValue * 100;
        this._proxy.Brightness = percent;
    },

    _sliderChanged: function(slider, value) {
        this._sliderValue = value;

        // It's ok to change the brightness here only if the slider didn't
        // change because of a mouse dragging event (e.g. keyboard), otherwise
        // it could push changes faster than how they can actually be handled.
        if (!this._sliderIsDragging)
            this._updateBrightness();
    },

    _sliderDragBegan: function(slider) {
        this._sliderIsDragging = true;
    },

    _sliderDragEnded: function(slider) {
        this._updateBrightness();
        this._sliderIsDragging = false;
    },

    _sync: function() {
        let visible = this._proxy.Brightness >= 0;
        this._item.actor.visible = visible;
        if (visible)
            this._slider.setValue(this._proxy.Brightness / 100.0);
    },
});
