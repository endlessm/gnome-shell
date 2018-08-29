
// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Lang = imports.lang;

const Main = imports.ui.main;
const SideComponent = imports.ui.sideComponent;

const ClubhouseIface = '<node> \
<interface name="com.endlessm.Clubhouse"> \
<method name="show"> \
  <arg type="u" direction="in" name="timestamp"/> \
</method> \
<method name="hide"> \
  <arg type="u" direction="in" name="timestamp"/> \
</method> \
<property name="Visible" type="b" access="read"/> \
</interface> \
</node>';

const CLUBHOUSE_NAME = 'com.endlessm.Clubhouse';
const CLUBHOUSE_PATH = '/com/endlessm/Clubhouse';

var Clubhouse = new Lang.Class({
    Name: 'Clubhouse',
    Extends: SideComponent.SideComponent,

    _init: function() {
        this.parent(ClubhouseIface, CLUBHOUSE_NAME, CLUBHOUSE_PATH);
    },

    enable: function() {
        this.parent();
        Main.clubhouse = this;
    },

    disable: function() {
        this.parent();
        Main.clubhouse = null;
    },

    callShow: function(timestamp) {
        this.proxy.showRemote(timestamp);
    },

    callHide: function(timestamp) {
        this.proxy.hideRemote(timestamp);
    }
});
const Component = Clubhouse;
