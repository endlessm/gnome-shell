const ExtensionUtils = imports.misc.extensionUtils;
const Hack = ExtensionUtils.getCurrentExtension();

// To import custom files
const {codeView, } = Hack.imports.ui;


function init(metadata) {
}

function enable() {
    log("HACK ENABLE");
}

function disable() {
    log("HACK DISABLE");
}
