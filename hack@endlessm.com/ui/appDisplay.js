const { Clutter, Gio, GLib, GObject, St } = imports.gi;

const { AppIcon } = imports.ui.appDisplay;
const IconGridLayout = imports.ui.iconGridLayout;
const Main = imports.ui.main;

const ExtensionUtils = imports.misc.extensionUtils;
const Hack = ExtensionUtils.getCurrentExtension();
const Settings = Hack.imports.utils.getSettings();

const Clubhouse = Hack.imports.ui.clubhouse;

function _shouldShowHackLauncher() {
    // Only show the hack icon if the clubhouse app is in the system
    const show = Settings.get_boolean('show-hack-launcher');
    return show && Clubhouse.getClubhouseApp();
}

var HackAppIcon = GObject.registerClass(
class HackAppIcon extends AppIcon {
    _init() {
        let viewIconParams = {
            isDraggable: true,
            showMenu: true,
        };

        let iconParams = {
            createIcon: this._createIcon.bind(this),
        };

        let app = Clubhouse.getClubhouseApp();
        this._activated = false;

        super._init(app, viewIconParams, iconParams);
        this._pulse = Settings.get_boolean('hack-icon-pulse');
        this._pulseWaitId = 0;

        this._activated = Settings.get_boolean('hack-mode-enabled');
        this.icon.update();

        this._hackModeId = Settings.connect('changed::hack-mode-enabled', () => {
            this._activated = Settings.get_boolean('hack-mode-enabled');
            this.icon.update();
        });

        this._hackPulseId = Settings.connect('changed::hack-icon-pulse', () => {
            this._pulse = Settings.get_boolean('hack-icon-pulse');
            if (this._pulseWaitId) {
                GLib.source_remove(this._pulseWaitId);
                this._pulseWaitId = 0;
            }
            if (this._pulse)
                this._startPulse();
        });

        if (this._pulse)
            this._startPulse();
    }

    _startPulse() {
        const params = {
            duration: 100,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        };
        this._easeIcon({...params, scale_x: 1.1, scale_y: 1.1})
            .then(this._easeIcon.bind(this, {...params, scale_x: 0.9, scale_y: 0.9}))
            .then(this._easeIcon.bind(this, {...params, scale_x: 1.1, scale_y: 1.1}))
            .then(this._easeIcon.bind(this, {...params, scale_x: 0.9, scale_y: 0.9}))
            .then(this._easeIcon.bind(this, {...params, scale_x: 1.0, scale_y: 1.0}))
            .then(() => {
                this._pulseWaitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                    this._pulseWaitId = 0;
                    if (this._pulse)
                        this._startPulse();
                    return GLib.SOURCE_REMOVE;
                });
            });
    }

    _easeIcon(easeParams) {
        return new Promise((resolve) => {
            const params = {...easeParams, onComplete: () => resolve(this) };
            this.icon.icon.ease(params);
        });
    }

    _createIcon(iconSize) {
        let iconUri = `file://${Hack.path}/data/icons/hack-button-off.svg`;
        if (this._activated)
            iconUri = `file://${Hack.path}/data/icons/hack-button-on.svg`;

        let iconFile = Gio.File.new_for_uri(iconUri);
        let gicon = new Gio.FileIcon({ file: iconFile });

        return new St.Icon({
            gicon: gicon,
            icon_size: iconSize,
            pivot_point: new Clutter.Point({ x: 0.5, y: 0.5 }),
        });
    }

    getDragActor() {
        return this._createIcon(this._iconSize);
    }

    activate(button) {
        Settings.set_boolean('hack-icon-pulse', false);
        super.activate(button);
    }

    _canAccept(source) {
        return false;
    }

    // Override to avoid animation on launch
    animateLaunch() {
    }

    remove() {
        Settings.set_boolean('show-hack-launcher', false);
        this._iconGridLayout.emit('changed');
    }

    get name() {
        return 'Hack';
    }

    _onDestroy() {
        if (this._hackModeId)
            Settings.disconnect(this._hackModeId);
        if (this._hackPulseId)
            Settings.disconnect(this._hackPulseId);
        if (this._pulseWaitId)
            GLib.source_remove(this._pulseWaitId);
        super._onDestroy();
    }

    handleDragOver() {
        return DND.DragMotionResult.NO_DROP;
    }

    acceptDrop() {
        // This will catch the drop event and do nothing
        return true;
    }
});


// Monkey patching

const {AllView} = imports.ui.appDisplay;
const originalLoadApps = AllView.prototype._loadApps;

function maybeAddHackIcon(apps) {
    if (!_shouldShowHackLauncher())
        return;

    if (!this._hackAppIcon)
        this._hackAppIcon = new HackAppIcon();

    apps.unshift(this._hackAppIcon);
}

function loadApps() {
    let newApps = originalLoadApps.bind(this)();
    this._maybeAddHackIcon(newApps);
    return newApps;
}

// TODO: implement DnD limits and removement special case

function enable() {
    AllView.prototype._hackAppIcon = null;
    AllView.prototype._maybeAddHackIcon = maybeAddHackIcon;
    AllView.prototype._loadApps = loadApps;

    const iconGridLayout = IconGridLayout.getDefault();
    iconGridLayout.emit('changed');
}

function disable() {
    AllView.prototype._loadApps = originalLoadApps;
    delete AllView.prototype._maybeAddHackIcon;
    delete AllView.prototype._hackAppIcon;

    const iconGridLayout = IconGridLayout.getDefault();
    iconGridLayout.emit('changed');
}
