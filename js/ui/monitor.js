// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const GObject = imports.gi.GObject;
const Lang = imports.lang;

const Main = imports.ui.main;
const Params = imports.misc.params;

const MonitorConstraint = new Lang.Class({
    Name: 'MonitorConstraint',
    Extends: Clutter.Constraint,
    Properties: {'primary': GObject.ParamSpec.boolean('primary', 
                                                      'Primary', 'Track primary monitor',
                                                      GObject.ParamFlags.READABLE | GObject.ParamFlags.WRITABLE,
                                                      false),
                 'index': GObject.ParamSpec.int('index',
                                                'Monitor index', 'Track specific monitor',
                                                GObject.ParamFlags.READABLE | GObject.ParamFlags.WRITABLE,
                                                -1, 64, -1),
                 'work-area': GObject.ParamSpec.boolean('work-area',
                                                        'Work-area', 'Track monitor\'s work-area',
                                                        GObject.ParamFlags.READABLE | GObject.ParamFlags.WRITABLE,
                                                        false)},

    _init: function(props) {
        this._primary = false;
        this._index = -1;
        this._workArea = false;

        this.parent(props);
    },

    get primary() {
        return this._primary;
    },

    set primary(v) {
        if (v)
            this._index = -1;
        this._primary = v;
        if (this.actor)
            this.actor.queue_relayout();
        this.notify('primary');
    },

    get index() {
        return this._index;
    },

    set index(v) {
        this._primary = false;
        this._index = v;
        if (this.actor)
            this.actor.queue_relayout();
        this.notify('index');
    },

    get work_area() {
        return this._workArea;
    },

    set work_area(v) {
        if (v == this._workArea)
            return;
        this._workArea = v;
        if (this.actor)
            this.actor.queue_relayout();
        this.notify('work-area');
    },

    vfunc_set_actor: function(actor) {
        if (actor) {
            if (!this._monitorsChangedId) {
                this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', Lang.bind(this, function() {
                    this.actor.queue_relayout();
                }));
            }

            if (!this._workareasChangedId) {
                this._workareasChangedId = global.screen.connect('workareas-changed', Lang.bind(this, function() {
                    if (this._workArea)
                        this.actor.queue_relayout();
                }));
            }
        } else {
            if (this._monitorsChangedId)
                Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;

            if (this._workareasChangedId)
                global.screen.disconnect(this._workareasChangedId);
            this._workareasChangedId = 0;
        }

        this.parent(actor);
    },

    vfunc_update_allocation: function(actor, actorBox) {
        if (!this._primary && this._index < 0)
            return;

        let index;
        if (this._primary)
            index = Main.layoutManager.primaryIndex;
        else
            index = Math.min(this._index, Main.layoutManager.monitors.length - 1);

        let rect;
        if (this._workArea) {
            let ws = global.screen.get_workspace_by_index(0);
            rect = ws.get_work_area_for_monitor(index);
        } else {
            rect = Main.layoutManager.monitors[index];
        }

        actorBox.init_rect(rect.x, rect.y, rect.width, rect.height);
    }
});

const Monitor = new Lang.Class({
    Name: 'Monitor',

    _init: function(index, geometry) {
        this.index = index;
        this.x = geometry.x;
        this.y = geometry.y;
        this.width = geometry.width;
        this.height = geometry.height;
    },

    get inFullscreen() {
        return global.screen.get_monitor_in_fullscreen(this.index);
    }
})
