const ExtensionUtils = imports.misc.extensionUtils;
const Hack = ExtensionUtils.getCurrentExtension();

// To import custom files
const { appDisplay, codeView,  } = Hack.imports.ui;


function init(metadata) {
}

function enable() {
    log("HACK ENABLE");
    appDisplay.enable();
}

function disable() {
    log("HACK DISABLE");
    appDisplay.disable();
}
