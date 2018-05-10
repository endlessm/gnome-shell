// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const { GObject } = imports.gi;

const Main = imports.ui.main;
const SideComponent = imports.ui.sideComponent;

const DISCOVERY_FEED_NAME = 'com.endlessm.DiscoveryFeed';
const DISCOVERY_FEED_PATH = '/com/endlessm/DiscoveryFeed';

const DiscoveryFeedIface = '<node> \
<interface name="' + DISCOVERY_FEED_NAME + '"> \
<method name="notifyHideAnimationCompleted" /> \
<method name="show"> \
  <arg type="u" direction="in" name="timestamp"/> \
</method> \
<method name="hide"> \
  <arg type="u" direction="in" name="timestamp"/> \
</method> \
<property name="Visible" type="b" access="read"/> \
</interface> \
</node>';

var DiscoveryFeed = GObject.registerClass(
class DiscoveryFeed extends SideComponent.SideComponent {
    _init() {
        super._init(DiscoveryFeedIface, DISCOVERY_FEED_NAME, DISCOVERY_FEED_PATH);
    }

    enable() {
        super.enable();
        Main.discoveryFeed = this;
    }

    disable() {
        super.disable();
        Main.discoveryFeed = null;
    }

    notifyHideAnimationCompleted() {
        this.proxy.notifyHideAnimationCompletedRemote();
    }

    callShow(timestamp) {
        this.proxy.showRemote(timestamp);
    }

    callHide(timestamp) {
        this.proxy.hideRemote(timestamp);
    }
});
var Component = DiscoveryFeed;
