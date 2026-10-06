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
back. If the Pin runs PenumbraOS v0 (MABL), FusionOS, or OpenPin, the
**Software & updates** page in Stage 3 lists those apps. When you choose
**Install Luma**, Center asks **Remove conflicting apps first?** and offers
**Remove and install**. That button does all of this, in this order:

- It uninstalls every installed app that matches this list. Their app data
  goes with them.
  - PenumbraOS v0: `com.penumbraos.mabl*` (this includes
    `com.penumbraos.mabl.pin`, the id PenumbraOS v0 ships its launcher
    under), `com.penumbraos.cli`, `com.penumbraos.adbd`,
    `com.penumbraos.plugins.*`, `com.penumbraos.sdk.*`,
    `com.penumbraos.bridge*`, and `com.penumbraos.pinitd`.
  - FusionOS: `com.ghost.fuionwebhost` and `com.ghost.fusion*`.
  - OpenPin: `org.openpin.primaryapp`.
- It removes the project's leftover device files: PenumbraOS v0's
  `/sdcard/penumbra` and `/data/local/tmp/bin`, and OpenPin's
  `/data/local/tmp/openpin-daemon` and `/data/local/tmp/pty_exec`.
- It re-enables Humane's Ironman, Onboarding, and System Navigation apps,
  clears PenumbraOS's expanded logging (`persist.log.tag`), and sets the
  stock launcher.
- It deletes pinitd's exploit residue (the `hidden_api_blacklist_exemptions`
  setting, which upstream documents as a boot-loop hazard when a crash leaves
  it set), restarts the Pin, and waits for it to finish starting.
- It installs Luma.

The confirmation lists the apps under **Apps from another Ai Pin project**
and, because this removal takes the project's files with them, names the
file removal with the backup reminder below.

The page also has a **Remove conflicting apps…** link. It does everything
above except the last step: it removes the apps and the leftover files,
restores the stock launcher, and restarts the Pin.

A Pin that runs the current generation of PenumbraOS is a different case. Its
apps use Luma's own package ids (`com.penumbraos.server`,
`com.penumbraos.hook`, `com.penumbraos.hook.injector`, and
`com.penumbraos.systeminjector`) but are signed by a different key. This no
longer dead-ends: the installer offers **Replace and install**, and its
confirmation (**Another project's apps are on this Pin**) says before you
confirm that recovery removes those apps with their app data and installs
Luma's signed apps. That erases the other project's app data, so copy
anything you want to keep first.

A leftover Luma Setup Helper (`com.penumbraos.systeminjector.exploit`, left
behind by an interrupted first install) no longer blocks everything either.
The page reports **The Setup Helper is present unexpectedly.** and offers
**Repair**; choosing it removes the helper and continues.

Back up first, with the ADB access you used to install PenumbraOS:

```sh
adb pull /sdcard/penumbra penumbra-backup
```

That copies MABL's assistant settings and the pinitd service files. The
assistant settings are in `etc/mabl/llm_configs.json`: the URL, key, and model
of your OpenAI-compatible endpoint. The same endpoint works in Luma. Enter it
in Center under **Settings → Assistant & voice**. Keep the backup as private as
a password, because it holds that key.

To go back to PenumbraOS later, connect the Pin and open
**Settings → Advanced → Software & updates**. Open the **More tools** menu
(the **⋯** button), choose **Uninstall Luma…**, and confirm with
**Uninstall**. Center first disconnects the Pin from your server: it removes
the Cosmos connection and the identity material left on the Pin, and the Pin
restores the settings those replaced. It then removes Luma's five apps and
turns back on the Humane apps that installing Luma turned off: Bort, Bort
OTA, the Memfault usage reporter, the metric reporter, and Humane OTA. The
Pin no longer points at your server. It does not restart the Pin, and it
does not reinstall PenumbraOS. Reinstall that with PenumbraOS's own
installer ([penumbraos.com](https://penumbraos.com)), then restore your
settings from the backup.

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

   **Settings → Set up a Pin** opens the same page.

   You see: the **Guided setup** page. Its **Set up your Ai Pin** section
   reads **0 of 7 steps complete**, and **Your setup** lists the seven
   stages. A stage turns green only when Center has read something from the
   Pin or your server. **Check again** re-reads everything.

> **If the page says "This browser cannot reach a Pin over USB":** the reason
> under it is "WebUSB is not available in this browser" or "The installer
> requires a secure context (HTTPS or localhost)". You are in Safari, Firefox,
> a phone browser, or on an address without HTTPS. Open the `https://` address
> in desktop Chrome, Chromium, or Edge.

## Stage 1: Connect your Pin

*Place your Pin on a USB interposer, then choose it in the browser.*

1. Choose **Connect over USB**. If you want to see how the Pin sits on the
   interposer, choose **Connection help** first.

   You see: the browser's USB device chooser, a small window that lists USB
   devices.

2. Select the Pin and choose **Connect**.

   You see: the button reads **Connecting…**. If the Pin asks whether to
   allow this computer, accept on its Laser Ink display.

3. Read the serial number Center shows.

   You see: stage 1 turns green and reads **Connected over USB · SERIAL**,
   with your Pin's serial.

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

A Pin that is already online goes straight to step 3.

1. If the stage shows **Turn on Wi-Fi**, choose it.

   You see: **Turning on Wi-Fi…**, then **Waiting to see whether the Pin
   rejoins a network it already knows…**. A Pin that knows a nearby network
   rejoins it by itself. In that case, skip to step 3.

2. Otherwise, Center looks for networks and lists the ones the Pin can see.
   Pick your network (or **Other network** for a hidden one), type its
   password, and choose **Join network**. If your network is missing, choose
   **Scan again**.

   The password goes from the browser to the Pin over the cable, and the Pin
   saves it like any other network. It never reaches your server.

3. Wait for the clock check.

   You see: **Checking the Pin's clock…**, then stage 2 turns green.

   A Pin that sat unused often reads February 2025. That date makes every
   certificate look "not yet valid". Android fixes it within seconds of going
   online. If it stays wrong, Center sets it. If the stage shows **Set the
   Pin's clock**, choose it.

> **Decision: no cable at hand?** **No cable? Make a Wi-Fi QR code instead**
> opens the **Wi-Fi** page (`/wifi` in Center), which makes a code the Pin can
> scan. A Pin already online over mobile data needs no Wi-Fi at all.

## Stage 3: Install Luma

*Center installs and checks the Luma release published on your server.*

1. Choose **Open installer**.

   You see: the **Software & updates** page. It reads what is on the Pin and
   shows **Luma isn't installed yet**. Below that are the Pin's name and
   serial and a list of the Luma apps, each **Not installed**.

2. Choose **Install Luma VERSION** (VERSION is your server's release).

   You see: a confirmation titled **Install Luma on this Pin?**. The text
   names the release and your Pin's serial. Below it are two notes. **This
   changes your Pin's system software** says a loose cable, or a Pin that
   locks partway, may need a repair afterwards. **What installing does** says
   Center installs Luma's five apps, turns off Humane's update and
   usage-reporting apps, and makes Luma the home screen. Luma isn't on the
   Pin yet, so there is no Luma data to erase.

3. **Decision:** check that the serial in the confirmation is your Pin's. If
   it is, choose **Install Luma**. If it is any other device, choose
   **Cancel** and disconnect the other hardware.

   You see: a progress bar under titles such as **Downloading Luma** and
   **Installing Luma**. It takes a few minutes, and the Pin restarts. Keep
   the tab open, the Pin unlocked, and the cable connected. Center
   reconnects to the same serial by itself. Never pick a different device to
   continue.

4. Wait for **Your Pin is up to date**. Then choose **Continue Guided
   setup**.

   You see: stage 3 green.

A Pin that already runs an older Luma shows **Update to VERSION** instead.

A Pin with only some of Luma's apps, or a broken Luma installer, shows
**Your Pin needs a repair** and a **Repair** button. So does a Pin whose
Device Installer is too old to update safely, such as one from an early
PenumbraOS release. Its confirmation is
titled **Recover this Pin?**, with the note **Recovery erases Luma's app
data** and the button **Start recovery**. Center removes what is left of
Luma and installs it again.

The page can also show a quiet **Unrecognized apps** advisory. It lists
installed apps that are neither Luma's, the Pin's original software, nor
known conflicts. Nothing removes them by itself. **Remove unrecognized
apps…** behind the advisory asks **Remove unrecognized apps?** and names the
exact packages before Center removes the ones you confirmed.

> **If stage 3 says known conflicting apps must be removed before
> installing:** the Pin has apps from another Ai Pin project. Choose **Open
> installer**, then **Install Luma VERSION**. Center asks **Remove
> conflicting apps first?** and lists the apps under **Apps from another Ai
> Pin project**. When the project also leaves device files behind, the
> confirmation names them with a backup reminder:
> `adb pull /sdcard/penumbra penumbra-backup`. **Remove and install** removes
> the apps and the files, restores the stock launcher, restarts the Pin, and
> installs. See
> [Coming from PenumbraOS or another Ai Pin project](#coming-from-penumbraos-or-another-ai-pin-project).
>
> **If stage 3 shows a command instead of Open installer:** your server has
> no Pin release to install yet. The **Software & updates** page says **No
> Pin release to install** in the same case. On the server, run
> `./luma pin release acquire --check`. If that reports none, run
> `./luma pin release acquire --archive ../luma-pin-*.tar.gz` from the
> operator folder. Then choose **Check again**.
>
> **If the Pin shows a lock screen after restarting:** unlock it with the
> passcode it had before Luma and leave it on the cable. If the page shows
> **Unlock your Pin**, choose **Check again** once it is unlocked.

## Stage 4: Required services

*Set up the assistant and speech. Every other service is optional.*

1. Read the stage.

   You see: green if you completed Part H of the server guide. Otherwise
   choose **Open Assistant & voice**, which opens **Settings → Assistant &
   voice**. Fill in the fields marked **Needs setup**, choose **Test** and
   **Save changes**, then choose **Open Guided setup** at the bottom of the
   page.

Weather, nearby places, music, and food logging are optional. You can add
them later in **Settings → Assistant & voice** or **Settings → Music**.

## Stage 5: Connect to your Luma

*Center points the Pin at your Luma server and pairs it with your account.*

1. **Decision:** does this Pin still need its own first setup? That is the
   case if it never went through Humane's original setup, or if it was reset.
   If so, choose **Set your Pin passcode** first. It opens
   **Settings → Passcode & password**. Under **Ai Pin passcode**, choose
   **Set passcode**, type four digits twice, and choose **Save passcode**.
   Cosmos immediately turns them into a password file it cannot read back, so
   stage 6 asks you to type them once more. A Pin that already finished
   Humane's setup skips this, and Guided setup says so.

   You see: the stage shows **Set your Pin passcode** while this is missing.

2. Choose **Open Provisioning**. The page is headed **Connect your Pin**. In
   the menu it is **Settings → Advanced → Connect to your server**. Keep the
   Pin on the cable. If the page shows **Connect over USB**, choose it and
   select the same Pin.

3. Choose **Connect this Pin to Cosmos**.

   You see: **Connecting to Cosmos…**. Center reads the hardware ID and pairs
   it with your signed-in account. It creates the Pin's one-time identity,
   installs the server address and trust roots, and verifies the activation
   on that exact device. Then the page shows **Connected to Cosmos** and
   **Remote access is ready**.

4. Choose **Open Guided setup** lower on the page.

   You see: stage 5 green. If it offers **Turn on remote access**, choose it,
   so Center can reach this Pin later without the cable.

> **If Connect your Pin says "USB is connected, but Luma isn't responding
> yet":** keep the Pin unlocked and connected, then choose **Check
> connection**. If Luma still doesn't answer, **Install or repair Luma**
> opens the installer. If the page shows **Remote access pending**, choose
> **Retry remote access**. It keeps the identity already installed on the
> Pin.
>
> **If Connect your Pin says "This Pin is connected to another Luma
> server":** the message names the other server's address. The Pin is active
> with a different Luma server. **Switch this Pin to this server**
> disconnects it from that server — the Pin restores the settings its
> connection there replaced — and connects it to this one.

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

   You see: **Your Pin is ready.** and **7 of 7 steps complete**. All seven
   stages are green.

The Pin stores that confirmation itself, tied to its serial, the installed
release, and your server. A new release or a new server asks for it again.

> **If stage 6 times out with no setup screen on the Pin, or stage 7 fails
> with certificate errors:** the Pin finished Humane's original setup before
> it ever reached this server, so the server never issued its credential, and
> the stock setup ceremony cannot run on such a Pin unaided. In
> **Provisioning**, open **Pin still can't reach your server?** and choose
> **Run its original setup**. Center re-arms the Pin's original setup
> ceremony, reconnects it, and opens its setup screen on the Pin. Follow the
> prompts on the Pin, and finish Guided setup stage 6 with the same four
> digits when Center asks for them; the Pin keeps the passcode it already
> unlocks with.

## Afterwards

You can take the Pin off the interposer and put the sticker back. From now on
Center reaches the Pin remotely. You only need USB for updates and repairs.

For music, open **Settings → Music**, link an account, and choose the
provider. Then choose **Save** so the Pin receives your choice.

To reconnect this Pin later, after a reset or a repair, connect it and run
Guided setup again. A different Pin is refused. This server stays assigned to
the first one, and removing its pairing does not free the slot.

If something did not go green, see [troubleshooting](troubleshooting.md).
