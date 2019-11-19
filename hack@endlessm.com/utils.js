const { Gio } = imports.gi;
const Extension = imports.misc.extensionUtils.getCurrentExtension();

function getSettings() {
    let dir = Extension.dir.get_child('schemas').get_path();
    let source = Gio.SettingsSchemaSource.new_from_directory(dir,
            Gio.SettingsSchemaSource.get_default(),
            false);

    if(!source) {
        throw new Error('Error Initializing the thingy.');
    }

    let schema = source.lookup('org.gnome.shell.extensions.hack', false);

    if(!schema) {
        throw new Error('Schema missing.');
    }

    return new Gio.Settings({
        settings_schema: schema
    });
}

function loadInterfaceXML(iface) {
    let dir = Extension.dir.get_child('data').get_child('dbus-interfaces').get_path();

    let xml = null;
    let uri = `file://${dir}/${iface}.xml`;
    let f = Gio.File.new_for_uri(uri);

    try {
        let [ok_, bytes] = f.load_contents(null);
        if (bytes instanceof Uint8Array)
            xml = imports.byteArray.toString(bytes);
        else
            xml = bytes.toString();
    } catch (e) {
        log(`Failed to load D-Bus interface ${iface}`);
    }

    return xml;
}

function override(object, methodName, callback) {
    if (!object._fnOverrides)
        object._fnOverrides = {};

    const original = object.prototype[methodName];
    object._fnOverrides[methodName] = original;
    object.prototype[methodName] = callback;
}

function restore(object) {
    if (object._fnOverrides) {
        Object.keys(object._fnOverrides).forEach((k) => {
            object.prototype[k] = object._fnOverrides[k];
        });
        delete object._fnOverrides;
    }
}

function original(object, methodName) {
    return object._fnOverrides[methodName];
}
