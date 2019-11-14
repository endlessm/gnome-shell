const ExtensionUtils = imports.misc.extensionUtils;
const Hack = ExtensionUtils.getCurrentExtension();

// To import custom files
const { appDisplay, clubhouse, codeView } = Hack.imports.ui;
const Service = Hack.imports.service;


function init(metadata) {
}

function enable() {
    log("HACK ENABLE");
    appDisplay.enable();
    clubhouse.enable();

    Service.enable();
}

function disable() {
    log("HACK DISABLE");
    appDisplay.disable();
    clubhouse.disable();

    Service.disable();
}
