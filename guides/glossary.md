# Glossary

Short definitions of the words the Luma guides use. The
[README](../README.md) is the reference. This page only explains the terms.

| Term | Meaning |
| --- | --- |
| **Center** | Luma's web app, your own humane.center. You sign in to it in a browser at `https://YOUR_DOMAIN` to change settings, connect providers, and set up the Pin. |
| **Cosmos** | Luma's cloud service, the recreation of Humane's cloud. It runs on your server, stores all cloud data, and answers the Pin. Center reads its data from Cosmos. |
| **Penumbra** | The community device foundation ([PenumbraOS](https://github.com/PenumbraOS)) that lets owner-authorized apps such as Luma's run on a stock Ai Pin. Luma's Pin apps are built on it. |
| **Compatibility Layer** | One of Luma's five Pin apps. It redirects the stock Pin software's cloud calls to your Cosmos server. When your server is unreachable it fails closed: the Pin does not fall back to anyone else's cloud. |
| **Device Services** | One of Luma's five Pin apps. It runs on the Pin, keeps the Pin's local settings, and is what Center talks to over USB or the remote bridge. When Center says "Luma isn't responding", it means Device Services. |
| **Device Installer** | One of Luma's five Pin apps. It installs and repairs the other apps on the Pin. Center's **Software & updates** page drives it over USB. |
| **interposer** | A small circuit board from the [PenumbraOS interposer project](https://github.com/PenumbraOS/interposer). A stock Pin has no USB socket. The interposer presses against the Pin's service contacts (under the small moon sticker) and gives you a USB-C port. |
| **operator** | The person who runs the server. The first account Luma creates is the operator, and only the operator can change providers and connect a Pin. Also the name of the server-side CLI (`./luma`) and its archive. |
| **wearer** | The person whose Pin it is: the account the Pin is paired with, whose notes, captures, and contacts live in Cosmos. On a personal Luma the operator and the wearer are the same person. |
| **profile** | An optional feature set you switch on at setup: `pin` (the Pin's connection edge, which needs your public IPv4), `search` (built-in SearXNG web search), `spotify` (music playback, which needs `pin`), and `observability` (Prometheus and Grafana). |
| **ACME / Let's Encrypt** | Let's Encrypt is the free certificate authority, and ACME is the protocol it uses. Luma's server obtains and renews your HTTPS certificate automatically, which is why ports 80 and 443 must stay open and your domain must point at the server. |
| **A record** | The DNS entry that maps a name (`center.example.com`) to an IPv4 address (`203.0.113.10`). Luma needs exactly one, pointing at your server, with no proxy in front of it. |
| **GHCR** | GitHub Container Registry (`ghcr.io`), where Luma's container images are published. The images are public, so your server pulls them with no sign-in (a private fork signs in once with `./luma registry login`). |
| **release / operator archive** | A release is one tested set of server images and Pin apps with a version such as `0.3.16`. It comes as five files, the last the maintainer's cosign signature over `SHA256SUMS`. The operator archive `luma-operator-VERSION-linux.tar.gz` holds the `./luma` CLI and the digest-pinned list of images for that release. |
| **update source** | The Luma Center your server asks, every hour, which release is newest (it reads that Center's public `/api/version`, which answers with the newest release published at `github.com/TheAndersMadsen/luma`, whether or not that Center runs it yet). It is the Center whose installer you used (for a server installed from the release files, the one the release names) unless you chose another with `./luma setup production --update-source https://CENTER`. With automatic updates on, the server installs a newer release it finds there at night. |
| **Pin archive** | The `luma-pin-PIN_VERSION.tar.gz` file of a release: the signed set of the five Pin apps. Setup checks it against the release and stages it so Center can install it on the Pin. |
| **OPAQUE** | The password protocol Cosmos uses for the Pin passcode: the server keeps a file it can verify against, never the four digits themselves. Nobody, including you, can read the passcode back out of the server. |
| **Keycloak** | The sign-in service inside Luma. It holds your Center account and password, and enforces the lockout after repeated wrong passwords. |
| **Traefik** | The web front door on your server. It owns ports 80 and 443, obtains the Let's Encrypt certificate, and routes browser traffic to Center. |
| **Envoy** | The Pin's front door on your server (part of the `pin` profile). It terminates the Pin's own encrypted connection on your public IPv4 and hands the calls to Cosmos. |
| **WebUSB** | The browser feature that lets a web page talk to a USB device. Center uses it to install and set up the Pin. Only desktop Chrome, Chromium, and Edge have it. Safari and Firefox do not. |
| **ADB** | Android Debug Bridge, Android's USB service interface. The Pin exposes it through the interposer, and Center speaks it from the browser through WebUSB. You never run `adb` commands yourself for a normal setup. Only one program can own the Pin's ADB interface at a time. |
| **Guided setup** | The page in Center (**Settings → My Ai Pin → Open guided setup**, at `/settings/pin/setup`) that walks through the seven stages of connecting a Pin. |
| **first-login file** | `~/.config/luma/production/first-login.txt` on the server: the Center address, the Guided setup link, the owner email, and the initial password. Show it once, sign in, change the password, delete the file. |
| **backup** | A folder written by `./luma backup production` with everything Luma cannot recreate. It holds every key and secret of the server. Keep it as private as a password and copy it off the server. |
