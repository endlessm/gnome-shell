const ExtensionUtils = imports.misc.extensionUtils;
const Hack = ExtensionUtils.getCurrentExtension();

// To import custom files
const { appDisplay, clubhouse, codeView } = Hack.imports.ui;
const Service = Hack.imports.service;


function init(metadata) {
}

function enable() {
    appDisplay.enable();
    clubhouse.enable();
    codeView.enable();

    Service.enable();
}

function disable() {
    appDisplay.disable();
    clubhouse.disable();
    codeView.disable();

    Service.disable();
}
