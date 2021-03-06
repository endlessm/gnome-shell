const { Gio, GLib } = imports.gi;

const AppLauncherIface = '<node> \
<interface name="org.gnome.Shell.AppLauncher"> \
<method name="Launch"> \
    <arg type="s" direction="in" name="name" /> \
    <arg type="u" direction="in" name="timestamp" /> \
</method> \
</interface> \
</node>';

const AppLauncherProxy = Gio.DBusProxy.makeProxyWrapper(AppLauncherIface);

function getLocalizedAppNames(appName) {
    // trim .desktop part, if present
    const idx = appName.indexOf('.desktop');
    if (idx !== -1)
        appName = appName.substring(0, idx);

    const appNames = [appName];
    const languageNames = GLib.get_language_names();
    const variants = GLib.get_locale_variants(languageNames[0]);
    variants.filter(variant => {
        // discard variants with an encoding
        return variant.indexOf('.') === -1;
    }).forEach(variant => {
        appNames.push(`${appName}.${variant}`);
    });

    appNames.push(`${appName}.en`);
    return appNames;
}

function createProxyAndLaunch(appName) {
    try {
        const proxy = new AppLauncherProxy(
            Gio.DBus.session,
            'org.gnome.Shell',
            '/org/gnome/Shell');
        proxy.LaunchSync(appName, 0);
        return true;
    } catch (error) {
        logError(error, `Failed to launch application '${appName}'`);
        return false;
    }
}

var uri = ARGV[0];
if (!uri) {
    print('Usage: eos-launch endlessm-app://<application-name>\n');
} else {
    const tokens = uri.match(/(endlessm-app:\/\/|)([0-9,a-z,A-Z,-_.]+)/);
    if (tokens) {
        const appNames = getLocalizedAppNames(tokens[2]);
        appNames.some(createProxyAndLaunch);
    }
}
