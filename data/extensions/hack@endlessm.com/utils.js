/* exported getSettings, loadInterfaceXML, override, restore, original */

const { Gio } = imports.gi;
const Extension = imports.misc.extensionUtils.getCurrentExtension();

function getSettings() {
    const dir = Extension.dir.get_child('schemas').get_path();
    const source = Gio.SettingsSchemaSource.new_from_directory(dir,
        Gio.SettingsSchemaSource.get_default(), false);

    if (!source)
        throw new Error('Error Initializing the thingy.');

    const schema = source.lookup('org.gnome.shell.extensions.hack', false);

    if (!schema)
        throw new Error('Schema missing.');

    return new Gio.Settings({ settings_schema: schema });
}

function loadInterfaceXML(iface) {
    const dir = Extension.dir.get_child('data').get_child('dbus-interfaces')
        .get_path();

    let xml = null;
    const uri = `file://${dir}/${iface}.xml`;
    const f = Gio.File.new_for_uri(uri);

    try {
        const [ok_, bytes] = f.load_contents(null);
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

    const baseObject = object.prototype || object;
    const originalMethod = baseObject[methodName];
    object._fnOverrides[methodName] = originalMethod;
    baseObject[methodName] = callback;
}

function restore(object) {
    const baseObject = object.prototype || object;
    if (object._fnOverrides) {
        Object.keys(object._fnOverrides).forEach(k => {
            baseObject[k] = object._fnOverrides[k];
        });
        delete object._fnOverrides;
    }
}

function original(object, methodName) {
    return object._fnOverrides[methodName];
}
