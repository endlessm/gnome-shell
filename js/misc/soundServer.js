/* exported getDefault */

const {Gio} = imports.gi;

const SoundServerIface = `
<node>
  <interface name='com.endlessm.HackSoundServer'>
    <method name='PlaySound'>
      <arg type='s' name='sound_event' direction='in'/>
      <arg type='s' name='uuid' direction='out'/>
    </method>
    <method name='StopSound'>
      <arg type='s' name='uuid' direction='in'/>
    </method>
    <signal name='Error'>
      <arg type='s' name='uuid'/>
      <arg type='s' name='error_message'/>
      <arg type='s' name='error_domain'/>
      <arg type='i' name='error_code'/>
      <arg type='s' name='debug'/>
    </signal>
  </interface>
</node>
`;

const SoundServerProxy = Gio.DBusProxy.makeProxyWrapper(SoundServerIface);

var SoundItemStatusEnum = {
    NONE: 0,
    PENDING: 1,
    CANCELLING: 2,
};

var SoundItem = class {

    constructor(name) {
        this._id = this.Status.NONE;
        this.name = name;
    }

    get Status() {
        return SoundItemStatusEnum;
    }

    play() {
        // If we are about to play the sound, do nothing
        if (this._id === this.Status.PENDING)
            return;

        // If we had to play and to stop before the first UUId was returned, then un-cancel
        // the original sound but do not request another one.
        if (this._id === this.Status.CANCELLING) {
            this._id = this.Status.PENDING;
            return;
        }

	// If we are already playing a sound, do nothing (we want to avoid overlapped sounds)
	if (this._id !== this.Status.NONE)
	    return;

        this._id = this.Status.PENDING;
        getDefault().playAsync(this.name).then(uuid => {
            if (this._id === this.Status.CANCELLING) {
                getDefault().stop(uuid);
                this._id = this.Status.NONE;
                return;
            }
            this._id = uuid;
        });
    }

    stop() {
        if (this._id === this.Status.PENDING) {
            this._id = this.Status.CANCELLING;
            return;
        }

        if (this._id === this.Status.CANCELLING || this._id === this.Status.NONE)
            return;
        getDefault().stop(this._id);
        this._id = this.Status.NONE;
    }
}

class SoundServer {
    constructor() {
        this._proxy = new SoundServerProxy(
            Gio.DBus.session,
            'com.endlessm.HackSoundServer',
            '/com/endlessm/HackSoundServer',
            (proxy, err) => {
                if (err)
                    logError(err, 'Could not create sound server proxy');
            });
    }

    // Most common use case, fire and forget, no return value
    play(id) {
        this._proxy.PlaySoundRemote(id, (out, err) => {
            if (err)
                logError(err, `Error playing sound ${id}`);
        });
    }

    // Use if you need the return value to stop the sound
    playAsync(id) {
        return new Promise((resolve, reject) => {
            this._proxy.PlaySoundRemote(id, (out, err) => {
                if (err) {
                    reject(err);
                    return;
                }
                const [uuid] = out;
                resolve(uuid);
            });
        });
    }

    // Use sparingly, only if you need the return value, but also can't use an
    // async function
    playSync(id) {
        return this._proxy.PlaySoundSync(id);
    }

    stop(uuid) {
        this._proxy.StopSoundRemote(uuid, (out, err) => {
            if (err)
                logError(err, `Error stopping sound ${uuid}`);
        });
    }
}

var getDefault = (function () {
    let defaultSoundServer;
    return function () {
        if (!defaultSoundServer)
            defaultSoundServer = new SoundServer();
        return defaultSoundServer;
    };
}());
