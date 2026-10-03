# Connect a Pin: Linux USB, release, and ADB checks

> Part of the [Luma docs](./README.md). The normal Pin setup is in the [main README](../README.md#connect-a-pin) and the [Connect your Pin guide](../guides/connect-your-pin.md). This page holds the signed Pin release check, Linux USB permissions, and ADB readiness checks.


> [!IMPORTANT]
> Only one program can use the Pin's USB ADB interface at a time. Before you
> use Center, close Android Studio, scrcpy, phone-management tools, and any
> terminal streaming `adb` output.

The preparation commands below stop native ADB on purpose before the browser
claims the device.

Browsers offer WebUSB only in a [secure context](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API).
That is why production installation uses Center over HTTPS. The Linux setup
below follows Android's [official Ubuntu device guidance](https://developer.android.com/studio/run/device.html).

#### Verify the matching signed Pin release

Setup takes the exact signed five-APK archive that the operator release
names:

```sh
./luma setup production --profile pin ... --pin-release-archive FILE
```

Before it publishes the archive to Center, setup checks:

- the byte size and SHA-256 bound into the operator
- the internal release ID and version
- the manifest digest
- the signer receipts
- the package roles
- every APK digest

Without `--pin-release-archive`, setup and `pin release acquire` verify the
GitHub release's signed `SHA256SUMS` with the committed public key. They then
download the archive from that release. A release published without a
signature must be given with `--pin-release-archive`.

To confirm the release is still compatible, run:

```sh
./luma pin release acquire --check
```

It never searches a release page or picks the first matching filename. If a
different valid Pin release is present, setup and deployment stop before they
can mix server and device releases. `./luma pin release acquire --archive FILE`
stages the same archive on its own, with the same binding and verification
rules. Luma never publishes a partial set.

#### Prepare Linux USB permissions

On Ubuntu, install the standard Android udev rules and join the USB device
group:

```sh
sudo apt update
sudo apt install adb android-sdk-platform-tools-common
sudo usermod -aG plugdev "$LOGNAME"
```

Log out and back in so the group change takes effect. Then check that the
workstation sees the Pin:

```sh
id -nG | tr ' ' '\n' | grep -x plugdev
lsusb
adb devices -l
```

The Pin must appear in the `device` state. The other states mean:

| State | Meaning |
| --- | --- |
| `unauthorized` | The device still needs to be unlocked or authorized. |
| `no permissions` | The udev rule or group has not taken effect. |

<details>
<summary><strong>Linux fallback: add a device-specific udev rule</strong></summary>

Use this only when `lsusb` sees the Pin but the standard Android rules do not
grant access. Read the Pin's hexadecimal vendor and product IDs from `lsusb`.
Then create `/etc/udev/rules.d/51-ai-pin.rules` with those exact lowercase values:

```udev
SUBSYSTEM=="usb", ATTR{idVendor}=="vvvv", ATTR{idProduct}=="pppp", MODE="0660", GROUP="plugdev", TAG+="uaccess"
```

Replace `vvvv` and `pppp` with the real IDs. Do not copy them literally. Reload
the rules, then unplug the Pin and reconnect it:

```sh
sudo udevadm control --reload-rules
sudo udevadm trigger
```

</details>

macOS does not use udev rules. Windows may require a compatible Android/WinUSB
driver before a Chromium browser can claim the device.

#### Confirm Android finished booting

The installer waits for the same package-manager path it will use for the real
installation. You can check that this path is ready before you open Center:

```sh
adb wait-for-device
adb shell cmd package path android
```

A ready Pin prints an absolute package path such as:

```text
package:/system/framework/framework-res.apk
```

If it prints `cmd: Can't find service: package`, reboot the Pin once. Leave it
powered on and unlocked, and try again after Android finishes starting. Do not
begin installation until the absolute package path appears.

Finally, release the USB interface so the browser can use WebUSB:

```sh
adb kill-server
```

