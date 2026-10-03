# Connect your Pin to Luma

This guide installs Luma on a stock Ai Pin and connects it to your server,
from a computer, through Center's **Guided setup**. It follows the README's
[Connect a Pin](../README.md#connect-a-pin) section, which stays the
reference. Words in **bold** are Center buttons or pages; unfamiliar terms
are in the [glossary](glossary.md).

**What you need**

- A Luma server that passes `./luma verify production`, with the assistant
  and voice configured ([Set up a server from nothing](server-from-nothing.md)).
- A PenumbraOS USB interposer for the Ai Pin, from the
  [interposer project](https://github.com/PenumbraOS/interposer). A stock
  Pin has no USB socket; the interposer sits against the service contacts
  under the Pin's small moon sticker.


- A USB-C **data** cable (a charge-only cable does not work), plugged
  straight into the computer, not a hub.
- A desktop computer with current **Chrome, Chromium, or Edge**. Safari and
  Firefox cannot talk to USB devices, and phones and tablets cannot either.
- The Pin, charged, switched on, unlocked, and finished booting (give it a
  few minutes after switching on).
- Your Wi-Fi name and password, unless the Pin already has a working mobile
  line.
- Your Center sign-in.

**Time:** about 30 minutes, plus the interposer preparation the first time.

**The one rule:** Center shows the serial number of the Pin it found. Continue
only when it is the serial of the Pin on your desk, and never pick a
different device partway through.

One Luma server supports one physical Pin. Once it is paired, provisioned,
or enters enrollment, that server stays assigned to it. You can repair or
reactivate the same Pin; removing its pairing does not allow a different one.
See [the admission policy](../README.md#connect-a-pin). You can prepare Center
and link services before doing any of the physical steps below.

## Before you start

### Coming from PenumbraOS or another Ai Pin project

Installing Luma replaces what is on the Pin, and there is no button to go
back. If the Pin runs PenumbraOS v0 (MABL), FusionOS, or OpenPin, Stage 3
offers **Remove and install**, which:

- uninstalls those apps: for PenumbraOS v0 that is `com.penumbraos.mabl`,
  `com.penumbraos.plugins.*`, `com.penumbraos.sdk.*`, `com.penumbraos.bridge*`,
  and `com.penumbraos.pinitd`. Their app data goes with them;
- re-enables Humane's Ironman, Onboarding, and System Navigation apps, clears
  PenumbraOS's expanded logging (`persist.log.tag`), and reboots the Pin.

It leaves PenumbraOS's files in `/sdcard/penumbra` and `/data/local/tmp/bin`
alone.

**Back up first,** with the ADB access you used to install PenumbraOS:

```sh
adb pull /sdcard/penumbra penumbra-backup
```

That copies MABL's assistant settings (`etc/mabl/llm_configs.json`: the URL,
key, and model of your OpenAI-compatible endpoint) and the pinitd service
files. The same endpoint works in Luma: enter it in Center under **Settings →
Assistant & voice**. Keep the backup as private as a password; it holds that
key.

**To go back to PenumbraOS later,** choose **Uninstall** on Center's
**Software & updates** page. It removes Luma's apps and re-enables the stock
apps Luma had turned off, but it does not reinstall PenumbraOS. Reinstall it
with PenumbraOS's own installer ([penumbraos.com](https://penumbraos.com)),
then restore your settings from the backup. Because one Luma server serves one
Pin, test Luma by setting up a server and Center first; connect the Pin only
when you are ready to move it.

### Prepare the Pin for the interposer (first time only)

Follow the interposer project's illustrated
[stock-Pin preparation](https://github.com/PenumbraOS/interposer/blob/master/preparation.md)
to expose the service contacts safely. Do this before the Pin ever touches the
interposer.

### Prepare your computer

- **Windows:** the browser may need a compatible Android/WinUSB driver before
  it can see the Pin. If the USB chooser in stage 1 stays empty, install the
  Android USB driver, replug the Pin, and try again.
- **macOS:** nothing to install.
- **Linux (Ubuntu):** give your user access to Android devices, then log out
  and back in:

  ```sh
  sudo apt update
  sudo apt install adb android-sdk-platform-tools-common
  sudo usermod -aG plugdev "$LOGNAME"
  ```

  After logging back in, `adb kill-server` releases the Pin so the browser
  can claim it. Full details, including a fallback udev rule, are in
  [Prepare Linux USB permissions](../docs/connect-a-pin.md#prepare-linux-usb-permissions).

- **All systems:** close Android Studio, scrcpy, phone-management tools, and
  any terminal running `adb`. Only one program can own the Pin's USB
  interface at a time. Unplug other Android devices.

## Open Guided setup

1. Place the Pin on the interposer, aligned with its outline, and connect
   the cable to the computer.

2. In desktop Chrome or Edge, open `https://YOUR_DOMAIN`, sign in, open
   **Settings → My Ai Pin**, and choose **Open guided setup**.

   You see: **Set up your Ai Pin**, with seven stages listed. A stage turns
   green only when Center has read something from the Pin or your server;
   **Check again** re-reads everything.


> **If the page says "This browser can't reach your Pin" or "WebUSB is not
> supported in this browser":** you are in Safari, Firefox, a phone browser,
> or a non-HTTPS address. Open the `https://` address in desktop Chrome,
> Chromium, or Edge.

## Stage 1: Connect your Pin

*Place your Pin on a USB interposer, then choose it in the browser.*

1. Choose **Connect over USB** (or **Connection help** first for the
   interposer alignment picture).

   You see: the browser's USB device chooser, a small window listing USB
   devices.


2. Select the Pin and choose **Connect**.

   You see: **Checking your Pin…**. If the Pin asks whether to allow this
   computer, accept on its Laser Ink display.

3. Read the serial number Center shows.

   You see: stage 1 turns green with the Pin's serial.

> **If the chooser is empty:** the Pin is locked, still booting, the cable is
> charge-only, or (Linux) the udev rules are not active yet. See
> [troubleshooting](troubleshooting.md#connecting-the-pin-from-the-browser).
> **If you see `Unable to claim interface`:** another program owns the Pin's
> USB interface; close it, run `adb kill-server` if you have ADB, replug, and
> choose **Connect over USB** again.

## Stage 2: Network & time

*Center turns on the Pin's Wi-Fi, joins your network over USB, and checks
the Pin's clock.*

1. Choose **Turn on Wi-Fi**.

   You see: **Turning on Wi-Fi…**, then **Waiting to see whether the Pin
   rejoins a network it already knows…**. A Pin that knows a nearby network
   rejoins it by itself; then skip to step 3.

2. Otherwise, under **Wi-Fi networks your Pin can see**, pick your network
   (or **Other network** for a hidden one), type its password, and join.

   The password travels from the browser to the Pin over the cable and is
   saved on the Pin like any other network. It never reaches your server.


3. Wait for the clock check.

   You see: **Checking the Pin's clock…**, then stage 2 turns green. A Pin
   that sat unused often reads February 2025, which makes every certificate
   look "not yet valid"; Android fixes it within seconds of going online,
   and Center sets it only if it stays wrong.

> **Decision: no cable at hand?** **Wi-Fi QR code** (`/wifi` in Center) makes
> a code the Pin can scan instead. A Pin already online over mobile data
> needs no Wi-Fi at all.

## Stage 3: Install Luma

*Center installs and checks the Luma release published on your server.*

1. Choose **Open installer**.

   You see: the **Software & updates** page. It reads what is on the Pin and
   shows **Luma isn't installed yet** with the release it will install, the
   current and target versions, and the serial.


2. Choose **Install**.

   You see: a confirmation, **Install Luma on this Pin?**, naming the release
   and the serial, with the note **This changes your Pin's system software**
   and a warning that a loose cable or a Pin that locks partway may need a
   repair afterwards.

3. **Decision:** check that the serial in the confirmation is your Pin's.
   If it is, confirm. If it is any other device, cancel and disconnect the
   other hardware.

   You see: a progress bar. It takes a few minutes and the Pin restarts.
   Keep the tab open, the Pin unlocked, and the cable connected. Center
   reconnects to the same serial by itself; never pick a different device to
   continue.

4. Wait for **Your Pin is up to date**, then return to **Guided setup**.

   You see: stage 3 green.

> **If the page says "Apps from another Ai Pin project":** the Pin has apps
> that conflict with Luma. Center lists them and offers **Remove and
> install**; it removes those apps first, then continues. Back them up before
> you choose it: see
> [Coming from PenumbraOS or another Ai Pin project](#coming-from-penumbraos-or-another-ai-pin-project).
> **If it says "No Pin release to install":** the server has no Pin archive
> staged. On the server run `./luma pin release acquire --check`; if that
> reports none, run `./luma pin release acquire --archive ../luma-pin-*.tar.gz`
> from the operator folder, then choose **Check again**.
> **If the Pin shows a lock screen after restarting:** unlock it with the
> passcode it had before Luma and leave it on the cable; Center continues.

## Stage 4: Required services

*Set up the assistant and speech. Every other service is optional.*

1. Read the stage.

   You see: green if you completed Part H of the server guide. Otherwise it
   links to **Settings → Assistant & voice**; complete the fields marked
   **Needs setup**, choose **Test** and **Save changes**, and return.

Weather, nearby places, music, and food logging are optional; add them later
in **Settings → Assistant & voice** or **Settings → Music**.

## Stage 5: Connect to your Luma

*Center points the Pin at your Luma server and pairs it with your account.*

1. **Decision:** does this Pin still need its own first setup (it never went
   through Humane's original setup, or was reset)? If so, first choose four
   digits in **Settings → Passcode & password**. Cosmos immediately turns
   them into a password file it cannot read back, so stage 6 asks you to type
   them once more. A Pin that already finished Humane's setup skips this;
   Guided setup says so.

   You see: the stage shows **Set your Pin passcode** while this is missing.

2. Choose **Open Provisioning** (the page is **Settings → Advanced → Connect
   to your server**). Keep the Pin on the cable; if asked, choose **Connect
   over USB** and select the same Pin.

3. Choose **Connect this Pin to Cosmos**.

   You see: Center reads the hardware ID, pairs it with your signed-in
   account, creates its one-time identity, installs the server address and
   trust roots, and verifies the activation on that exact device.


4. Return to **Guided setup**.

   You see: stage 5 green. If it offers **Turn on remote access**, choose it,
   so Center can reach this Pin later without the cable.

> **If it says "USB is connected, but Luma isn't responding yet":** keep the
> Pin unlocked and connected; Center keeps trying, and **Check connection**
> retries at once. **Retry remote access** keeps the identity already
> installed on the Pin.

## Stage 6: Pin passcode

*Finish the Pin's own setup when needed. A Pin that is already set up keeps
its current passcode.*

1. If the stage shows the field **Your four-digit Pin passcode**, type the
   same four digits you chose in stage 5 and choose **Finish setup on this
   Pin**.

   You see: the field clears immediately. The browser sends that copy to the
   Pin over USB only; it never goes to your server. Center waits up to 30
   seconds while the Pin's own setup finishes and makes those digits its
   lock code.


2. If the stage says the Pin already finished its setup, do nothing; it keeps
   the passcode it has today.

   You see: stage 6 green.

> **If you see "A passcode is exactly four digits.":** the field accepts only
> digits, exactly four. Type them again.

## Stage 7: Try it

*Ask your Pin a question, then confirm that it heard, answered, and responded
to your touch.*

1. Hold the Pin's touchpad and ask a question, for example the time or the
   weather.

   You see (and hear): the Pin answers through its speaker.

2. Choose **Confirm microphone, speaker & gesture**.

   You see: **Your Pin is ready.** All seven stages are green.


That confirmation is stored on the Pin itself, tied to its serial, the
installed release, and your server; a new release or a new server asks for it
again.

## Afterwards

- Take the Pin off the interposer and put the sticker back if you like. From
  now on Center reaches it remotely; USB is only for updates and repairs.
- Music: open **Settings → Music**, link an account, and choose the provider,
  then **Save** so the Pin receives your choice.
- Reconnecting this Pin later (after a reset or a repair): connect it and run
  Guided setup again. A different Pin is refused: this server stays assigned
  to the first one, and removing its pairing does not free the slot.
- Something did not go green: [troubleshooting](troubleshooting.md).
