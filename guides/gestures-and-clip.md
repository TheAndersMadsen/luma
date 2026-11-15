# Try Gestures and Clip

This development feature needs the matching Luma cloud/Center and signed Pin
release. It is on a feature branch; an ordinary production Pin has no Clip
endpoint until that release is installed. Keep the stock-reference, signing and
exact-serial installation checks in [the developer guide](../docs/developers.md#build-the-pin-apps).

## What your Mac needs

For use: Chrome or a compatible Chromium browser, the Luma Clip extension below,
and your signed-in Center. Keep its Clip tab open while the article tab is in
front. A paired remote Pin uses the existing Iroh bridge; USB uses Center's
existing browser device connection. No native Mac daemon, separate finger
driver, Python service or cloud provider key is required.

For development: follow `./luma setup contributor` and `./luma pin doctor`.
Docker supplies the pinned JDK, Android SDK/NDK and Rust cross-build tools. An
optional host Android Studio/NDK install is not needed for the canonical build.

## Install the matching software

For a local branch trial, start the matching Center/Cosmos development stack with
`pnpm dev` after [contributor setup](../docs/developers.md).
It serves Center at `http://localhost:4000`; sign in there and use that address
in the extension. The production Center cannot save a Clip until it runs the
matching cloud changes.

1. Build and verify the feature branch using the normal component checks. Build
   a signed five-APK release with a fresh version/version-code, and export it:

   ```sh
   ./luma pin release build --version YYYY-MM-DD.N --version-code INTEGER
   ./luma pin release export --output /absolute/path/luma-pin-YYYY-MM-DD.N.tar.gz
   ```

2. Use Center's **Pin → Set up a Pin** / installer with that exact signed release.
   The owner connects the physical Pin, selects it in the browser USB chooser,
   verifies its serial and confirms installation/activation. Do not replace an
   APK alone or bypass compatibility, signer, space or keep-data checks.
3. Verify that **Pin → Gestures** loads the installed catalog and that **Pin →
   Clip** can read the device. A 404 means the Pin does not have this feature.
   An offline/authorization error is not evidence that the feature is ready.

For an isolated candidate store, the developer CLI uses the same installation
checks as Center. Read the plan first, with the connected Pin's exact serial:

```sh
./luma pin install --store /absolute/path/to/candidate/pin-releases --serial SERIAL
```

The owner confirms that exact plan before adding `--confirm`. Activation remains
a separate owner-confirmed step if the plan says it is needed. This lets a branch
candidate stay outside the release store served by the ordinary Center.

## Test finger shortcuts first

1. Open **Settings → Pin → Gestures**. Add a shortcut such as middle finger →
   Open Music, with a 400 ms hold. Select **Test without opening apps** and save.
2. Start the inspector. Unlock your Pin, return to Home with the dashboard
   closed, raise an open hand and hold still for calibration.
3. Curl just the chosen finger, hold, then open your hand. Check the curled
   fingers, hold progress, projection availability and `observed` result.
4. Test both hands and the interruption cases below. Download the recording for
   each run. Keep the signed release/version and firmware alongside it.
5. Once the checks pass, select **Use shortcuts** and save. Repeat the sequence
   and verify the correct app opens once. To disable, select **Off** and save.

Turning shortcuts off does not cancel an independently staged Clip article.
Use **Cancel article** in Clip before its pinch if you no longer want it copied.

## Hand off an article

1. In Center, open **Settings → Pin → Clip** and download the extension archive.
   Extract it. At `chrome://extensions`, enable Developer mode, choose **Load
   unpacked**, and select the extracted `luma-clip` folder. Pin it to the toolbar.
   Developers can load `center/runtime/luma-clip` directly from the checkout.
2. In the extension, enter your Center origin, such as `https://center.example.com`,
   and click **Connect**. Grant access to your own Center host. No password or
   token goes in the extension. Chrome's site permission spans ports; the
   extension selects only the exact saved Center origin.
3. In the Center Clip tab, click **Enable browser handoff**. Leave one Clip tab
   open. Switch to the article. Optionally select an excerpt, open the extension
   and click **Hand off to Pin**. The article tab stays in front.
4. Within 60 seconds, unlock the Pin, return Home and raise the hand. Pinch once.
   The implementation shows a publisher mark, then the title when Cosmos
   confirms the note. Hold the pinch and move the hand closer to reveal the
   selected excerpt or URL. Lowering the hand cancels the visual presentation.
5. Check **Saved to Notes** in Center and open the saved note. Confirm the exact
   title, publisher, URL and selected text. A retry of an uncertain save uses
   the same ID; it must not create two notes.

If the Pin cannot project in the video's back-of-hand pose, stop the 1:1 test at
that result. An open-palm success is a different test. Luma does not force a
projection mesh or disable the projector's native safety gates. The NYTimes glyph
and ring are included; their exact projection scale and placement still need
comparison with the reference.

Closing, discarding, sleeping or signing out of the Center tab interrupts the
save path. **Copy not confirmed** means check Notes; it does not prove failure.
Reconnect while the lease is live to reconcile. If it expires, check Notes
before starting another handoff. **Pause browser handoff** stops accepting new
articles; it does not undo an already requested or saved copy.

## Physical acceptance record

Record the exact serial privately, firmware, signed release ID and version,
browser/version, USB or remote connection, hand, configuration and lighting.
Keep a synchronized video of laptop and projection with the inspector export.
Use the original nine-second video as the visual reference.

| Check | Evidence required |
| --- | --- |
| Calibration and individual fingers | Repeated correct finger states on both hands; count misses and false activations |
| Short/long hold and release | One action after stable release; no action from jitter or loss |
| Stock controls | Thumb/index selection, fist, Home/dashboard and other experiences still work |
| Tracking interruption | Loss, reversed/stalled timestamps, hand swap and HATS restart cancel safely |
| Lifecycle | Lock, pause, focus loss and navigation cancel; returning cannot replay an old action |
| Native Clip press | Copy requested once; Home underneath never activates |
| Exact demo pose | Continuous landmarks, usable native mesh and readable projection on the back of the hand |
| Clip timing and pull | Measure pinch → publisher/title times and inward-pull response against the reference |
| Visual fidelity | Compare publisher mark, font, line breaks, scale, placement, colour and transitions |
| Persistence | Exact article content saved once in the correct wearer's Notes |
| Interruption | Browser/Pin/network loss gives pending or failure, never fabricated success |
| Remote path | Repeat through the paired Iroh connection after USB passes |

The source and packaged extension tests produce synthetic software evidence.
They cannot fill in these physical results. See [the technical reference](../docs/gestures.md)
for API ownership, native findings, thresholds and developer extension points.
