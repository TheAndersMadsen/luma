# Pin onboarding

Every device command uses the exact serial printed by `adb devices`.

## 1. Check the host and device

```sh
./revival pin doctor --serial SERIAL
```

The target must identify as the expected Pin product. Resolve USB, ADB,
toolchain, signing-input, or storage failures before continuing.

## 2. Prepare device identity

Import an existing DeviceUser CA:

```sh
./revival pki import device-user --cert FILE --key FILE
./revival pki import device-user --cert FILE --key FILE --confirm
```

Or create one:

```sh
./revival pki init device-user
./revival pki init device-user --confirm
```

The first invocation prints the plan. Confirmation changes only the DeviceUser
CA and does not replace the separate attestation CA.

## 3. Verify a signed release

```sh
./revival pin release inspect --release-dir DIR
./revival pin release verify --release-dir DIR
```

A valid release contains one signed artifact for each of the five roles:
Server, Hook, Hook injector, installer, and bootstrap.

## 4. Install

Plan first:

```sh
./revival pin install --serial SERIAL --release-dir DIR
```

Then perform the same exact plan:

```sh
./revival pin install --serial SERIAL --release-dir DIR --confirm
```

The installer rechecks the serial, product, signatures, versions, free space,
installed package identities, and Hook path. If the existing Hook is under an
unexpected randomized Android package path, stop. Do not force the update or
run bootstrap recovery on a healthy device.

## 5. Activate

```sh
./revival pin activate \
  --serial SERIAL \
  --credential-file FILE \
  --edge-ipv4 A.B.C.D
./revival pin activate \
  --serial SERIAL \
  --credential-file FILE \
  --edge-ipv4 A.B.C.D \
  --confirm
```

Check it:

```sh
./revival pin activate status --serial SERIAL
```

## 6. Network

```sh
./revival pin network --serial SERIAL
./revival pin network qr --open
```

QR credentials stay in the browser and do not enter the process arguments.

## 7. Confirm behavior

After a Hook update, restart the affected stock host processes so they load the
new Hook. Check voice, projection, connectivity, settings, and Center sync on
the physical device.
