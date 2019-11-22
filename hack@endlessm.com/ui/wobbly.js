/* exported enableWobblyFx, disableWobblyFx */

const { AnimationsDbus, EndlessShellFX, GLib, Gio, GObject, Meta } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Hack = ExtensionUtils.getCurrentExtension();
const Settings = Hack.imports.utils.getSettings();

// ControllableShellWobblyEffect
//
// "Metaclass" that exists to store settings for an effect
// to be attached to a surface. It has a few properties
// which are modified by the AnimationsDbus.ServerEffect that
// owns it when ChangeSetting is called on its owner object. It
// also has a createActorPrivate() method which creates an
// EOSShellWobbly, representing private data for an attached
// effect to an actor.
var ControllableShellWobblyEffect = GObject.registerClass({
    Implements: [AnimationsDbus.ServerEffectBridge],
    Properties: {
        spring_k: GObject.ParamSpec.double('spring-k',
            'Spring K',
            'The Spring Constant to use',
            GObject.ParamFlags.READWRITE |
            GObject.ParamFlags.CONSTRUCT,
            2.0,
            10.0,
            8.0),
        friction: GObject.ParamSpec.double('friction',
            'Friction',
            'The Friction Constant to use',
            GObject.ParamFlags.READWRITE |
            GObject.ParamFlags.CONSTRUCT,
            3.0,
            10.0,
            5.0),
        slowdown_factor: GObject.ParamSpec.double('slowdown-factor',
            'Slowdown Factor',
            'How much to slow animations down',
            GObject.ParamFlags.READWRITE |
            GObject.ParamFlags.CONSTRUCT,
            1.0,
            5.0,
            1.0),
        object_movement_range: GObject.ParamSpec.double('object-movement-range',
            'Object Movement Range',
            'How far apart control points can be from each other',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
            10.0,
            500.0,
            100.0),
    },
}, class ControllableShellWobblyEffect extends GObject.Object {
    vfunc_get_name() {
        void this;
        return 'wobbly';
    }

    createActorPrivate(actor) {
        const effect = new EOSShellWobbly({ bridge: this });
        actor.add_effect_with_name('endless-animation-wobbly', effect);
        return effect;
    }
});

// GSettingsShellWobblyEffect
//
// A subclass of ControllableShellWobblyEffect that gets
// its configuration from GSettings as opposed to an external
// caller.
var GSettingsShellWobblyEffect = GObject.registerClass({
}, class GSettingsShellWobblyEffect extends ControllableShellWobblyEffect {
    vfunc_get_name() {
        void this;
        return 'gsettings-wobbly';
    }

    _init(params) {
        super._init(params);

        const binder = (key, prop) => {
            Settings.bind(key, this, prop, Gio.SettingsBindFlags.GET);
        };

        // Bind GSettings to effect properties
        binder('wobbly-spring-k', 'spring-k');
        binder('wobbly-spring-friction', 'friction');
        binder('wobbly-slowdown-factor', 'slowdown-factor');
        binder('wobbly-object-movement-range', 'object-movement-range');
    }
});

// EOSShellWobbly
//
// Private data that exists for the attached ControllableShellWobblyEffect
// on an AnimationsDbus.ServerSurfaceBridge (eg, a ClutterActor). It is
// a subclass of EndlessShellFX.Wobbly (eg, a ClutterEffect) and binds to
// the properties of the passed ControllableShellWobblyEffect.
var EOSShellWobbly = GObject.registerClass({
    Implements: [AnimationsDbus.ServerSurfaceAttachedEffect],
    Properties: {
        bridge: GObject.ParamSpec.object('bridge',
            '',
            '',
            GObject.ParamFlags.READWRITE |
            GObject.ParamFlags.CONSTRUCT_ONLY,
            ControllableShellWobblyEffect),
    },
}, class EOSShellWobbly extends EndlessShellFX.Wobbly {
    constructor(params) {
        super(params);

        const binder = (key, prop) => {
            this.bridge.bind_property(key, this, prop, GObject.BindingFlags.DEFAULT);
        };

        // Bind to effect properties
        binder('spring-k', 'spring-k');
        binder('friction', 'friction');
        binder('slowdown-factor', 'slowdown-factor');
        binder('object-movement-range', 'object-movement-range');
    }

    grabbedByMouse() {
        void this;
    }

    activate(event, detail) {
        switch (event) {
        case 'move':
            if (detail.grabbed)
                this._grabbedByMouse();
            else
                this._ungrabbedByMouse();
            return true;
        default:
            return false;
        }
    }

    remove() {
        if (this.actor)
            this.actor.remove_effect(this);
    }

    _grabbedByMouse() {
        const position = global.get_pointer();
        const actor = this.get_actor();
        this.grab(position[0], position[1]);

        this._lastPosition = actor.get_position();
        this._positionChangedId =
            actor.connect('allocation-changed', a => {
                const pos = a.get_position();
                const dx = pos[0] - this._lastPosition[0];
                const dy = pos[1] - this._lastPosition[1];

                this.move_by(dx, dy);
                this._lastPosition = pos;
            });
    }

    _ungrabbedByMouse() {
        // Only continue if we have an active grab and change notification
        // on movement
        if (!this._positionChangedId)
            return;

        const actor = this.get_actor();
        this.ungrab();

        actor.disconnect(this._positionChangedId);
        this._positionChangedId = null;
    }
});

const _ALLOWED_ANIMATIONS_FOR_EVENTS = {
    move: ['wobbly', 'gsettings-wobbly'],
};

// ShellWindowManagerAnimatableSurface
//
// An implementation of AnimationsDbus.ServerSurfaceBridge used to
// communicate from the animations-dbus library to the shell. The
// implementation has an attach_effect method which returns
// an implementation of an AnimationsDbus.ServerSurfaceAttachedEffect
// if a given AnimationsDbus.ServerEffectBridge can be attached
// to the actor.
var ShellWindowManagerAnimatableSurface = GObject.registerClass({
    Implements: [AnimationsDbus.ServerSurfaceBridge],
}, class ShellWindowManagerAnimatableSurface extends GObject.Object {
    _init(actor) {
        super._init();
        this.actor = actor;
    }

    vfunc_attach_effect(event, effect) {
        const effects = _ALLOWED_ANIMATIONS_FOR_EVENTS[event] || [];

        if (effects.length === 0) {
            throw new GLib.Error(AnimationsDbus.error_quark(),
                AnimationsDbus.Error.UNSUPPORTED_EVENT_FOR_ANIMATION_SURFACE,
                `Surface does not support event ${event}`);
        }

        if (effects.indexOf(effect.name) === -1) {
            throw new GLib.Error(AnimationsDbus.error_quark(),
                AnimationsDbus.Error.UNSUPPORTED_EVENT_FOR_ANIMATION_EFFECT,
                `Effect ${effect.name} can't be used on event ${event}`);
        }

        return effect.bridge.createActorPrivate(this.actor);
    }

    vfunc_detach_effect(event, attachedEffect) {
        void this;
        attachedEffect.remove();
    }

    vfunc_get_title() {
        return this.actor.meta_window.title;
    }

    vfunc_get_geometry() {
        return new GLib.Variant('(iiii)', [
            this.actor.x,
            this.actor.y,
            this.actor.width,
            this.actor.height,
        ]);
    }

    vfunc_get_available_effects() {
        void this;
        return new GLib.Variant('a{sv}',
            Object.keys(_ALLOWED_ANIMATIONS_FOR_EVENTS).reduce(
                (acc, key) => {
                    acc[key] = new GLib.Variant('as', _ALLOWED_ANIMATIONS_FOR_EVENTS[key]);
                    return acc;
                }, {}),
        );
    }
});

// ShellWindowManagerAnimationsFactory
//
// An implementation of AnimationsDbus.ServerEffectFactory
// which implements the create_effect() method. When a
// caller tries to create an animation, the name is looked up
// here and a corresponding AnimationsDbus.ServerEffectBridge
// implementation is returned if one is available for that
// effect name, which represents the metaclass for that
// effect as it exists on the shell side.
const ShellWindowManagerAnimationsFactory = GObject.registerClass({
    Implements: [AnimationsDbus.ServerEffectFactory],
}, class ShellWindowManagerAnimationsFactory extends GObject.Object {
    vfunc_create_effect(name) {
        void this;
        switch (name) {
        case 'wobbly':
            return new ControllableShellWobblyEffect();
        case 'gsettings-wobbly':
            return new GSettingsShellWobblyEffect();
        default:
            throw new GLib.Error(AnimationsDbus.error_quark(),
                AnimationsDbus.Error.NO_SUCH_EFFECT,
                `No such effect ${name}`);
        }
    }
});

function getAnimatableWindowActors() {
    return global.get_window_actors().filter(w => [
        Meta.WindowType.NORMAL,
        Meta.WindowType.DIALOG,
        Meta.WindowType.MODAL_DIALOG,
    ].indexOf(w.meta_window.get_window_type()) !== -1);
}

var SETTINGS_HANDLER = null;

function enableWobblyFx(wm) {
    AnimationsDbus.Server.new_async(new ShellWindowManagerAnimationsFactory(), null, (initable, result) => {
        wm._animationsServer = AnimationsDbus.Server.new_finish(initable, result);

        // Go through all the available windows and create an
        // AnimationsDbusServerSurface for it.
        getAnimatableWindowActors().forEach(actor => {
            const surface = wm._animationsServer.register_surface(new ShellWindowManagerAnimatableSurface(actor));
            actor._animatableSurface = surface;
        });

        // Create a server-side animation manager
        wm._animationsManager = wm._animationsServer.create_animation_manager();

        // Watch for the GSetting for the wobbly to change and add
        // the effect to all windows
        function actionWobblyEffectSetting(settings, key) {
            if (settings.get_boolean(key)) {
                wm._wobblyEffect = wm._animationsManager.create_effect('Wobbly Effect',
                    'gsettings-wobbly',
                    new GLib.Variant('a{sv}', {}));

                getAnimatableWindowActors().forEach(actor => {
                    actor._animatableSurface.attach_animation_effect_with_server_priority('move', wm._wobblyEffect);
                });
            } else if (wm._wobblyEffect) {
                wm._wobblyEffect.destroy();
                wm._wobblyEffect = null;
            }
        }

        SETTINGS_HANDLER = Settings.connect('changed::wobbly-effect', actionWobblyEffectSetting);
        actionWobblyEffectSetting(Settings, 'wobbly-effect');
    });
}

function disableWobblyFx(wm) {
    Settings.disconnect(SETTINGS_HANDLER);

    getAnimatableWindowActors().forEach(actor => {
        actor._animatableSurface = null;
    });

    wm._wobblyEffect.destroy();
    wm._wobblyEffect = null;
    wm._animationsServer = null;
}
