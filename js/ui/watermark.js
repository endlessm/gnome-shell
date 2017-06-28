// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const St = imports.gi.St;
const Background = imports.ui.background;
const Main = imports.ui.main;
const Monitor = imports.ui.monitor;
const Tweener = imports.ui.tweener;

const WATERMARK_SCHEMA = 'org.gnome.shell.watermark';
const WATERMARK_CUSTOM_BRANDING_FILE = '/var/eos-image-defaults/branding/gnome-shell.conf';

const Watermark = new Lang.Class({
    Name: 'Watermark',

    _init: function(bgManager) {
        this._bgManager = bgManager;

        this._watermarkFile = null;

        this._settings = new Gio.Settings({ schema_id: WATERMARK_SCHEMA });

        this._settings.connect('changed::watermark-file',
                               Lang.bind(this, this._updateWatermark));
        this._settings.connect('changed::watermark-size',
                               Lang.bind(this, this._updateScale));
        this._settings.connect('changed::watermark-position',
                               Lang.bind(this, this._updatePosition));
        this._settings.connect('changed::watermark-border',
                               Lang.bind(this, this._updateBorder));
        this._settings.connect('changed::watermark-always-visible',
                               Lang.bind(this, this._updateVisibility));

        this._textureCache = St.TextureCache.get_default();
        this._textureCache.connect('texture-file-changed', Lang.bind(this, function(cache, file) {
                if (!this._watermarkFile || !this._watermarkFile.equal(file))
                    return;

                this._updateWatermarkTexture();
            }));

        this.actor = new St.Widget({ layout_manager: new Clutter.BinLayout(),
                                     opacity: 0 });
        bgManager._container.add_actor(this.actor);

        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));

        let monitorIndex = bgManager._monitorIndex;
        let constraint = new Monitor.MonitorConstraint({ index: monitorIndex,
                                                         work_area: true});
        this.actor.add_constraint(constraint);

        this._bin = new St.Widget({ x_expand: true, y_expand: true });
        this.actor.add_actor(this._bin);

        this._settings.bind('watermark-opacity', this._bin, 'opacity',
                            Gio.SettingsBindFlags.DEFAULT);

        this._updateWatermark();
        this._updatePosition();
        this._updateBorder();

        this._bgDestroyedId =
            bgManager.backgroundActor.connect('destroy',
                                              Lang.bind(this, this._backgroundDestroyed));

        this._bgChangedId =
            bgManager.connect('changed', Lang.bind(this, this._updateVisibility));

        this._updateVisibility();
    },

    _loadBrandingFile: function() {
        try {
            let keyfile = new GLib.KeyFile();
            keyfile.load_from_file(WATERMARK_CUSTOM_BRANDING_FILE, GLib.KeyFileFlags.NONE);
            return keyfile.get_string('Watermark', 'logo');
        } catch(e) {
            return null;
        }
    },

    _updateWatermark: function() {
        let filename = this._settings.get_string('watermark-file');
        let brandingFile = this._loadBrandingFile();

        // If there's no GSettings file, but there is a custom file, use
        // the custom file instead
        if (!filename && brandingFile)
            filename = brandingFile;

        let file = Gio.File.new_for_commandline_arg(filename);
        if (this._watermarkFile && this._watermarkFile.equal(file))
            return;

        this._watermarkFile = file;

        this._updateWatermarkTexture();
    },

    _updateWatermarkTexture: function() {
        if (this._icon)
            this._icon.destroy();

        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;

        this._icon = this._textureCache.load_file_async(this._watermarkFile, -1, -1, scaleFactor);
        this._icon.connect('allocation-changed', Lang.bind(this, this._updateScale));
        this._bin.add_actor(this._icon);
    },

    _updateScale: function() {
        if (this._icon.width == 0)
            return;

        let size = this._settings.get_double('watermark-size');
        let width = this.actor.width * size / 100;
        let height = this._icon.height * width / this._icon.width;
        if (Math.abs(this._icon.height - height) < 1.0 &&
            Math.abs(this._icon.width - width) < 1.0) {
            // size of icon would not significantly change, so don't
            // update the size to avoid recursion in case the
            // manually set size differs just minimal from the eventually
            // allocated size
            return;
        }
        this._icon.set_size(width, height);
    },

    _updatePosition: function() {
        let xAlign, yAlign;
        switch (this._settings.get_string('watermark-position')) {
            case 'center':
                xAlign = Clutter.ActorAlign.CENTER;
                yAlign = Clutter.ActorAlign.CENTER;
                break;
            case 'bottom-left':
                xAlign = Clutter.ActorAlign.START;
                yAlign = Clutter.ActorAlign.END;
                break;
            case 'bottom-center':
                xAlign = Clutter.ActorAlign.CENTER;
                yAlign = Clutter.ActorAlign.END;
                break;
            case 'bottom-right':
                xAlign = Clutter.ActorAlign.END;
                yAlign = Clutter.ActorAlign.END;
                break;
        }
        this._bin.x_align = xAlign;
        this._bin.y_align = yAlign;
    },

    _updateBorder: function() {
        let border = this._settings.get_uint('watermark-border');
        this.actor.style = 'padding: %dpx;'.format(border);
    },

    _updateVisibility: function() {
        let background = this._bgManager.backgroundActor.background._delegate;
        let defaultUri = background._settings.get_default_value('picture-uri');
        let file = Gio.File.new_for_commandline_arg(defaultUri.deep_unpack());

        let visible;
        if (this._settings.get_boolean('watermark-always-visible'))
            visible = true;
        else if (background._file)
            visible = background._file.equal(file);
        else // background == NONE
            visible = false;

        Tweener.addTween(this.actor,
                         { opacity: visible ? 255 : 0,
                           time: Background.FADE_ANIMATION_TIME,
                           transition: 'easeOutQuad'
                         });
    },

    _backgroundDestroyed: function() {
        this._bgDestroyedId = 0;

        if (this._bgManager._backgroundSource) // background swapped
            this._bgDestroyedId =
                this._bgManager.backgroundActor.connect('destroy',
                                                        Lang.bind(this, this._backgroundDestroyed));
        else // bgManager destroyed
            this.actor.destroy();

    },

    _onDestroy: function() {
        this._settings.run_dispose();
        this._settings = null;

        if (this._bgDestroyedId)
            this._bgManager.backgroundActor.disconnect(this._bgDestroyedId);
        this._bgDestroyedId = 0;

        if (this._bgChangedId)
            this._bgManager.disconnect(this._bgChangedId);
        this._bgChangedId = 0;

        this._bgManager = null;
        this._watermarkFile = null;
    }
});

const WatermarkManager = new Lang.Class({
    Name: 'WatermarkManager',

    _init: function() {
        this._watermarks = [];
    },

    init: function() {
        Main.layoutManager.connect('monitors-changed', Lang.bind (this, this._addWatermark));
        Main.layoutManager.connect('startup-prepared', Lang.bind (this, this._addWatermark));
        this._addWatermark();
    },

    _addWatermark: function() {
        this._destroyWatermark();
        _forEachBackgroundManager(Lang.bind(this, function(bgManager) {
            this._watermarks.push(new Watermark(bgManager));
        }));
    },

    _destroyWatermark: function() {
        this._watermarks.forEach(function(l) { l.actor.destroy(); });
        this._watermarks = [];
    }
});

function _forEachBackgroundManager(func) {
    if (Main.overview._bgManagers)
        Main.overview._bgManagers.forEach(func);

    if (Main.layoutManager._bgManagers)
        Main.layoutManager._bgManagers.forEach(func);
}
