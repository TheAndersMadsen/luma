# Connect your Pin to Luma

This guide installs Luma on a stock Ai Pin and connects it to your server. You
do it from a computer, through Center's **Guided setup**. It follows the
README's [Connect a Pin](../README.md#connect-a-pin) section, which stays the
reference. Words in **bold** are Center buttons or pages. Unfamiliar terms are
in the [glossary](glossary.md).

**What you need**

- [ ] A Luma server that passes `./luma verify production`, with the assistant
      and voice configured
      ([Set up a server from nothing](server-from-nothing.md)).
- [ ] A PenumbraOS USB interposer for the Ai Pin, from the
      [interposer project](https://github.com/PenumbraOS/interposer). A stock
      Pin has no USB socket. The interposer sits against the service contacts
      under the Pin's small moon sticker.
- [ ] A USB-C data cable, plugged straight into the computer, not a hub. A
      charge-only cable does not work.
- [ ] A desktop computer with current Chrome, Chromium, or Edge. Safari and
      Firefox cannot talk to USB devices, and phones and tablets cannot either.
- [ ] The Pin, charged, switched on, unlocked, and finished booting. Give it a
      few minutes after switching on.
- [ ] Your Wi-Fi name and password, unless the Pin already has a working
      mobile line.
- [ ] Your Center sign-in.

It takes about 30 minutes, plus the interposer preparation the first time.

> [!IMPORTANT]
> Center shows the serial number of the Pin it found. Continue only when it is
> the serial of the Pin on your desk, and never pick a different device partway
> through.

One Luma server supports one physical Pin. Once a Pin is paired, provisioned,
or enters enrollment, that server stays assigned to it. You can repair or
reactivate the same Pin. Removing its pairing does not allow a different one.
See [the admission policy](../README.md#connect-a-pin). You can prepare Center
and link services before you do any of the physical steps below.

## Before you start

### Coming from PenumbraOS or another Ai Pin project

Installing Luma replaces what is on the Pin, and there is no button to go
back. If the Pin runs PenumbraOS v0 (MABL), FusionOS, or OpenPin, Stage 3
offers **Remove and install**. That button does two things:

- It uninstalls those apps. For PenumbraOS v0 that means
  `com.penumbraos.mabl`, `com.penumbraos.plugins.*`, `com.penumbraos.sdk.*`,
  `com.penumbraos.bridge*`, and `com.penumbraos.pinitd`. Their app data goes
  with them.
- It re-enables Humane's Ironman, Onboarding, and System Navigation apps,
  clears PenumbraOS's expanded logging (`persist.log.tag`), and reboots the
  Pin.

It leaves PenumbraOS's files in `/sdcard/penumbra` and `/data/local/tmp/bin`
alone.

Back up first, with the ADB access you used to install PenumbraOS:

```sh
adb pull /sdcard/penumbra penumbra-backup
```

That copies MABL's assistant settings and the pinitd service files. The
assistant settings are in `etc/mabl/llm_configs.json`: the URL, key, and model
of your OpenAI-compatible endpoint. The same endpoint works in Luma. Enter it
in Center under **Settings → Assistant & voice**. Keep the backup as private as
a password, because it holds that key.

To go back to PenumbraOS later, choose **Uninstall** on Center's
**Software & updates** page. It removes Luma's apps and re-enables the stock
apps Luma had turned off, but it does not reinstall PenumbraOS. Reinstall it
with PenumbraOS's own installer ([penumbraos.com](https://penumbraos.com)),
then restore your settings from the backup.

One Luma server serves one Pin. So if you want to try Luma first, set up a
server and Center, and connect the Pin only when you are ready to move it.

### Prepare the Pin for the interposer (first time only)

Follow the interposer project's illustrated
[stock-Pin preparation](https://github.com/PenumbraOS/interposer/blob/master/preparation.md)
to expose the service contacts safely. Do this before the Pin ever touches the
interposer.

### Prepare your computer

On Windows, the browser may need a compatible Android/WinUSB driver before it
can see the Pin. If the USB chooser in stage 1 stays empty, install the Android
USB driver, replug the Pin, and try again.

On macOS there is nothing to install.

On Linux (Ubuntu), give your user access to Android devices:

```sh
sudo apt update
sudo apt install adb android-sdk-platform-tools-common
sudo usermod -aG plugdev "$LOGNAME"
```

Then log out and back in. After that, this command releases the Pin so the
browser can claim it:

```sh
adb kill-server
```

Full details, including a fallback udev rule, are in
[Prepare Linux USB permissions](../docs/connect-a-pin.md#prepare-linux-usb-permissions).

On every system, close Android Studio, scrcpy, phone-management tools, and any
terminal running `adb`. Only one program can own the Pin's USB interface at a
time. Unplug other Android devices too.

## Open Guided setup

1. Place the Pin on the interposer, lined up with its outline, and connect the
   cable to the computer.

2. In desktop Chrome or Edge, open `https://YOUR_DOMAIN` and sign in. Open
   **Settings → My Ai Pin** and choose **Open guided setup**.

   You see: **Set up your Ai Pin**, with seven stages listed. A stage turns
   green only when Center has read something from the Pin or your server.
   **Check again** re-reads everything.

> **If the page says "This browser can't reach your Pin" or "WebUSB is not
> supported in this browser":** you are in Safari, Firefox, a phone browser,
> or on an address without HTTPS. Open the `https://` address in desktop
> Chrome, Chromium, or Edge.

## Stage 1: Connect your Pin

*Place your Pin on a USB interposer, then choose it in the browser.*

1. Choose **Connect over USB**. If you want to see how the Pin sits on the
   interposer, choose **Connection help** first.

   You see: the browser's USB device chooser, a small window that lists USB
   devices.

2. Select the Pin and choose **Connect**.

   You see: **Checking your Pin…**. If the Pin asks whether to allow this
   computer, accept on its Laser Ink display.

3. Read the serial number Center shows.

   You see: stage 1 turns green with the Pin's serial.

> **If the chooser is empty:** the Pin is locked or still booting, the cable
> is charge-only, or (on Linux) the udev rules are not active yet. See
> [troubleshooting](troubleshooting.md#connecting-the-pin-from-the-browser).
>
> **If you see `Unable to claim interface`:** another program owns the Pin's
> USB interface. Close it and run `adb kill-server` if you have ADB. Then
> replug the Pin and choose **Connect over USB** again.

## Stage 2: Network & time

*Center turns on the Pin's Wi-Fi, joins your network over USB, and checks
the Pin's clock.*

1. Choose **Turn on Wi-Fi**.

   You see: **Turning on Wi-Fi…**, then **Waiting to see whether the Pin
   rejoins a network it already knows…**. A Pin that knows a nearby network
   rejoins it by itself. In that case, skip to step 3.

2. Otherwise, under **Wi-Fi networks your Pin can see**, pick your network
   (or **Other network** for a hidden one), type its password, and join.

   The password goes from the browser to the Pin over the cable, and the Pin
   saves it like any other network. It never reaches your server.

3. Wait for the clock check.

   You see: **Checking the Pin's clock…**, then stage 2 turns green.

   A Pin that sat unused often reads February 2025. That date makes every
   certificate look "not yet valid". Android fixes it within seconds of going
   online, and Center sets the clock only if it stays wrong.

> **Decision: no cable at hand?** **Wi-Fi QR code** (`/wifi` in Center) makes
> a code the Pin can scan instead. A Pin already online over mobile data
> needs no Wi-Fi at all.

## Stage 3: Install Luma

*Center installs and checks the Luma release published on your server.*

1. Choose **Open installer**.

   You see: the **Software & updates** page. It reads what is on the Pin and
   shows **Luma isn't installed yet**, with the release it will install, the
   current and target versions, and the serial.

2. Choose **Install**.

   You see: a confirmation, **Install Luma on this Pin?**, naming the release
   and the serial. It carries the note **This changes your Pin's system
   software** and warns that a loose cable, or a Pin that locks partway, may
   need a repair afterwards.

3. **Decision:** check that the serial in the confirmation is your Pin's. If
   it is, confirm. If it is any other device, cancel and disconnect the other
   hardware.

   You see: a progress bar. It takes a few minutes, and the Pin restarts.
   Keep the tab open, the Pin unlocked, and the cable connected. Center
   reconnects to the same serial by itself. Never pick a different device to
   continue.

4. Wait for **Your Pin is up to date**, then go back to **Guided setup**.

   You see: stage 3 green.

> **If the page says "Apps from another Ai Pin project":** the Pin has apps
> that conflict with Luma. Center lists them and offers **Remove and
> install**, which removes those apps first and then continues. Back them up
> before you choose it. See
> [Coming from PenumbraOS or another Ai Pin project](#coming-from-penumbraos-or-another-ai-pin-project).
>
> **If it says "No Pin release to install":** the server has no Pin archive
> staged. On the server, run `./luma pin release acquire --check`. If that
> reports none, run `./luma pin release acquire --archive ../luma-pin-*.tar.gz`
> from the operator folder. Then choose **Check again**.
>
> **If the Pin shows a lock screen after restarting:** unlock it with the
> passcode it had before Luma and leave it on the cable. Center continues.

## Stage 4: Required services

*Set up the assistant and speech. Every other service is optional.*

1. Read the stage.

   You see: green if you completed Part H of the server guide. Otherwise it
   links to **Settings → Assistant & voice**. Fill in the fields marked
   **Needs setup**, choose **Test** and **Save changes**, and come back.

Weather, nearby places, music, and food logging are optional. You can add
them later in **Settings → Assistant & voice** or **Settings → Music**.

## Stage 5: Connect to your Luma

*Center points the Pin at your Luma server and pairs it with your account.*

1. **Decision:** does this Pin still need its own first setup? That is the
   case if it never went through Humane's original setup, or if it was reset.
   If so, first choose four digits in **Settings → Passcode & password**.
   Cosmos immediately turns them into a password file it cannot read back, so
   stage 6 asks you to type them once more. A Pin that already finished
   Humane's setup skips this, and Guided setup says so.

   You see: the stage shows **Set your Pin passcode** while this is missing.

2. Choose **Open Provisioning**. The page is **Settings → Advanced → Connect
   to your server**. Keep the Pin on the cable. If asked, choose **Connect
   over USB** and select the same Pin.

3. Choose **Connect this Pin to Cosmos**.

   You see: Center reads the hardware ID and pairs it with your signed-in
   account. It creates the Pin's one-time identity, installs the server
   address and trust roots, and verifies the activation on that exact device.

4. Go back to **Guided setup**.

   You see: stage 5 green. If it offers **Turn on remote access**, choose it,
   so Center can reach this Pin later without the cable.

> **If it says "USB is connected, but Luma isn't responding yet":** keep the
> Pin unlocked and connected. Center keeps trying, and **Check connection**
> retries at once. **Retry remote access** keeps the identity already
> installed on the Pin.

## Stage 6: Pin passcode

*Finish the Pin's own setup when needed. A Pin that is already set up keeps
its current passcode.*

1. If the stage shows the field **Your four-digit Pin passcode**, type the
   same four digits you chose in stage 5. Then choose **Finish setup on this
   Pin**.

   You see: the field clears immediately. The browser sends the digits to the
   Pin over USB only. They never go to your server. Center waits up to 30
   seconds while the Pin finishes its own setup and makes those digits its
   lock code.

2. If the stage says the Pin already finished its setup, do nothing. The Pin
   keeps the passcode it has today.

   You see: stage 6 green.

> **If you see "A passcode is exactly four digits.":** the field accepts
> exactly four digits and nothing else. Type them again.

## Stage 7: Try it

*Ask your Pin a question, then confirm that it heard, answered, and responded
to your touch.*

1. Hold the Pin's touchpad and ask a question, for example the time or the
   weather.

   You see (and hear): the Pin answers through its speaker.

2. Choose **Confirm microphone, speaker & gesture**.

   You see: **Your Pin is ready.** All seven stages are green.

The Pin stores that confirmation itself, tied to its serial, the installed
release, and your server. A new release or a new server asks for it again.

## Afterwards

You can take the Pin off the interposer and put the sticker back. From now on
Center reaches the Pin remotely. You only need USB for updates and repairs.

For music, open **Settings → Music**, link an account, and choose the
provider. Then choose **Save** so the Pin receives your choice.

To reconnect this Pin later, after a reset or a repair, connect it and run
Guided setup again. A different Pin is refused. This server stays assigned to
the first one, and removing its pairing does not free the slot.

If something did not go green, see [troubleshooting](troubleshooting.md).
