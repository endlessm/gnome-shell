// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const St = imports.gi.St;
const Shell = imports.gi.Shell;

const AppActivation = imports.ui.appActivation;
const BoxPointer = imports.ui.boxpointer;
const IconGridLayout = imports.ui.iconGridLayout;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;

const BackgroundMenu = new Lang.Class({
    Name: 'BackgroundMenu',
    Extends: PopupMenu.PopupMenu,

    _init: function(layoutManager) {
        this.parent(layoutManager.dummyCursor, 0, St.Side.TOP);

        this.addSettingsAction(_("Change Background…"), 'gnome-background-panel.desktop');
        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.addAction(_("Add App"), Lang.bind(this, function() {
            let app = Shell.AppSystem.get_default().lookup_app('org.gnome.Software.desktop');
            let activationContext = new AppActivation.AppActivationContext(app);
            activationContext.activate(Clutter.get_current_event());
        }));

        this.addAction(_("Add Website"), Lang.bind(this, function() {
            Main.appStore.showPage(global.get_current_time(), 'web');
        }));

        this.addAction(_("Add Folder"), Lang.bind(this, function() {
            IconGridLayout.layout.addFolder();
        }));

        this.actor.add_style_class_name('background-menu');

        layoutManager.uiGroup.add_actor(this.actor);
        this.actor.hide();
    }
});

function _addBackgroundMenuFull(actor, clickAction, layoutManager) {
    // Either the actor or the action has to be defined
    if (!actor && !clickAction)
        return;

    if (actor) {
        clickAction = new Clutter.ClickAction();
        actor.add_action(clickAction);
    } else {
        actor = clickAction.get_actor();
    }

    actor.reactive = true;
    actor._backgroundMenu = new BackgroundMenu(layoutManager);
    actor._backgroundManager = new PopupMenu.PopupMenuManager({ actor: actor });
    actor._backgroundManager.addMenu(actor._backgroundMenu);

    function openMenu(x, y) {
        Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
        actor._backgroundMenu.open(BoxPointer.PopupAnimation.NONE);
    }

    clickAction.connect('long-press', function(action, actor, state) {
        if (state == Clutter.LongPressState.QUERY)
            return ((action.get_button() == 0 ||
                     action.get_button() == 1) &&
                    !actor._backgroundMenu.isOpen);
        if (state == Clutter.LongPressState.ACTIVATE) {
            let [x, y] = action.get_coords();
            openMenu(x, y);
            actor._backgroundManager.ignoreRelease();
        }
        return true;
    });
    clickAction.connect('clicked', function(action) {
        if (action.get_button() == 3) {
            let [x, y] = action.get_coords();
            openMenu(x, y);
        }
    });

    let grabOpBeginId = global.display.connect('grab-op-begin', function () {
        clickAction.release();
    });

    actor.connect('destroy', function() {
        actor._backgroundMenu.destroy();
        actor._backgroundMenu = null;
        actor._backgroundManager = null;
        global.display.disconnect(grabOpBeginId);
    });
}

function addBackgroundMenu(actor, layoutManager) {
    _addBackgroundMenuFull(actor, null, layoutManager);
}

function addBackgroundMenuForAction(clickAction, layoutManager) {
    if (!Main.sessionMode.hasOverview)
        return;

    _addBackgroundMenuFull(null, clickAction, layoutManager);
}
