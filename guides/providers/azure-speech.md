# Connect Azure Speech

Azure Speech gives Luma both halves of the Pin's voice connection:

- **speech to text:** Cosmos sends the Pin's recorded speech to Azure and gets
  text back;
- **text to speech:** Cosmos sends reply text to Azure and gets audio for the
  Pin to play.

This is cloud speech. Setting it up does not install speech recognition on the
Pin, and the **Azure voice** field changes only the voice that speaks replies.
Luma currently asks Azure to recognize spoken input as US English (`en-US`),
regardless of the output voice you choose.

Azure Speech and an assistant provider are the two required services for a
useful Pin. This guide covers Azure Speech only. For the rest of the server
setup, see [Set up a server from nothing](../server-from-nothing.md).

## Checklist

- [ ] Your Luma server and Center are running.
- [ ] You can sign in to Center as an operator. A regular wearer can see service
      status but cannot change provider settings.
- [ ] You have a Microsoft or GitHub account for Azure.
- [ ] You can create a resource in an Azure subscription. A personal subscription
      is fine; an organization may require an Owner or Contributor to do this.
- [ ] You have a payment card and phone available if Azure asks you to verify a
      new account. Microsoft says a temporary verification hold may appear.
- [ ] You have decided which Azure region should process the audio and text.
      A nearby supported region is usually the simplest choice.

Keep the Azure key private. Do not paste it into a terminal command, issue,
chat, or screenshot. You will paste it directly into Center's password field.

## 1. Create or choose an Azure account

If you already have an Azure subscription in which you can create resources,
skip to step 2.

1. Open Microsoft's [Azure account page](https://azure.microsoft.com/en-us/pricing/purchase-options/pay-as-you-go/).
2. Choose **Try Azure for free** or **Pay as you go**, then sign in with a
   Microsoft or GitHub account.
3. Complete Microsoft's identity and payment verification.
4. Open the [Azure portal](https://portal.azure.com/).

You see: the Azure portal home page and at least one subscription available to
your account.

The account offer and trial credit are separate from the Speech resource's
pricing tier. Creating an Azure account does not by itself create Speech or
give Luma a key.

## 2. Create a Speech resource

Microsoft's current Speech quickstart links directly to the correct
[resource-creation page](https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices).
The portal may call it a **Speech service**, an **AI Services resource for
Speech**, or a **Foundry resource for Speech** as Microsoft updates the product
names. Luma needs a resource that provides an Azure Speech key and region; it
does not need a Foundry project, a deployed language model, or a custom voice.

1. Open the resource-creation link and sign in if asked.
2. For **Subscription**, choose the subscription that should own the charges.
3. For **Resource group**, choose an existing group or create a small dedicated
   one, such as `luma`.
4. For **Region**, choose a nearby entry from Microsoft's
   [supported Azure Speech regions](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions).
   Remember this choice: Center needs its region identifier later.
5. Give the resource a unique **Name**, such as `luma-speech` plus a short
   personal suffix.
6. For **Pricing tier**, choose **Free F0** if Azure offers it for this
   subscription and region. Choose **Standard S0** if F0 is unavailable or its
   allowance and request limits are too small for your use.
7. Continue to **Review + create**, review any terms and networking choices,
   then choose **Create**.
8. Wait for deployment to finish and choose **Go to resource**.

You see: a successful deployment and the overview page for the new resource.

If the portal says the resource name is already taken, change only the name.
If F0 is unavailable, the usual causes are that the subscription already has
its allowed free resource or that the selected region does not offer that
tier. Do not choose S0 until you have reviewed the live price for your region
and currency.

## 3. Copy the key and region

1. In the resource's left navigation, open **Resource Management → Keys and
   Endpoint**. In some portal layouts it appears simply as **Keys and
   Endpoint**.
2. Reveal and copy **KEY 1** or **KEY 2**. Either works. Use one key consistently
   and leave the other available for rotation.
3. Copy or note the resource's **Location/Region** identifier. Microsoft uses
   compact identifiers such as `westeurope`, `northeurope`, or `eastus`.

You see: two masked keys and the resource endpoint. The endpoint begins with
the region identifier, for example `https://westeurope.api.cognitive.microsoft.com/`.

Copy the identifier, not the friendly display name: enter `westeurope`, not
`West Europe`. The key is tied to its region, so a correct key with the wrong
region is rejected. Microsoft's [region reference](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions#use-region-identifiers)
explains that relationship.

## 4. Choose an output voice

Luma starts with `en-US-AvaMultilingualNeural`, which is a good first choice and
is listed in Microsoft's
[supported languages and voices](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts).
You can keep it and change the voice later.

If you choose another voice:

1. Use Microsoft's list to find a prebuilt neural voice for the language and
   accent you want.
2. Copy the exact voice name, including capitalization, for example
   `en-GB-SoniaNeural` or `da-DK-ChristelNeural`.
3. For now, avoid HD voice identifiers containing a colon, such as
   `:DragonHDLatestNeural`; Center accepts the conventional letters, numbers,
   and hyphens format used by the voices above.

The output voice does not translate an answer and does not change input
recognition. A Danish output voice can speak Danish reply text, but this Luma
version still labels recorded input as `en-US` when it asks Azure to transcribe
it.

## 5. Enter the settings in Center

1. Sign in to your Center as the operator.
2. Open **Settings → Assistant & voice**.
3. Expand **Voice**.
4. Fill in the fields exactly as follows:

   | Center field | Enter |
   | --- | --- |
   | **Azure Speech key** | The complete value of KEY 1 or KEY 2. This is a password field. |
   | **Azure region** | The lowercase region identifier, such as `westeurope`. |
   | **Azure voice** | The exact supported voice name, such as `en-US-AvaMultilingualNeural`. |

5. Choose **Save changes** if you want to save without contacting Azure.

You see: **Settings saved. Your next request will use them.** The **Voice**
group says **Configured**. After a secret is saved, Center does not show it
again; the empty field means “keep the stored value.”

Saving proves only that Cosmos accepted and stored the settings. It does not
prove that Azure accepts the key, region, and voice.

## 6. Test Azure from Center

1. In the same **Voice** group, choose **Test**.
2. Wait up to 30 seconds.

**Test** first saves every pending change on the page, then asks Azure to turn
the text `Cosmos is ready.` into 24 kHz mono PCM audio. You do not need to
choose **Save changes** again after a successful test.

You see: **Working** beside **Test** and the message **Azure Speech returned
audio.** The services overview shows **Speech** as **Ready** once its cached
status refreshes. If it still shows the earlier state, reload the page.

This test proves that Cosmos can synthesize audio with the saved key, region,
and voice. It does not test the Pin's microphone, cloud transcription, network
connection, speaker, or gesture controls.

## 7. Verify both directions on the Pin

After the assistant provider is also ready:

1. Unlock the Pin and start the normal voice gesture.
2. Say a short US-English question with an unmistakable answer, such as “What
   is two plus two?”
3. Confirm that the Pin understood the words and speaks the answer aloud.
4. Try once more in the place where you normally use the Pin.

Hearing the answer proves output playback; receiving the right answer from the
spoken question also exercises microphone capture and Azure cloud
transcription. A typed question in Center can test spoken output, but it does
not prove the Pin's input path.

Changing Azure settings applies to the next request. It does not require a
Cosmos restart, Pin reinstall, or Pin activation.

## Costs and limits

**Checked October 2026.** Azure prices, free allowances, eligible regions, and
quotas can change. Check Microsoft's live
[Azure Speech pricing page](https://azure.microsoft.com/en-us/pricing/details/speech/)
for your region and currency before choosing a paid tier.

- Microsoft currently lists F0 allowances of 5 audio hours per month for
  real-time speech to text and 0.5 million characters per month for neural text
  to speech. Speech-to-text hours are billed from audio duration; text-to-speech
  usage is billed by character.
- F0 currently permits one concurrent real-time speech-to-text request and 20
  real-time text-to-speech transactions per 60 seconds. These F0 quotas are not
  adjustable.
- S0 is pay as you go. Microsoft publishes its regional price rather than one
  universal amount. Its default concurrency/rate limits are higher and some
  can be increased.
- Luma additionally limits a short transcription request to about 60 seconds
  of 16 kHz mono WAV audio (at most 4 MiB), and limits text sent for one speech
  synthesis request to 8 KiB.

The current authoritative details are in Microsoft's
[Speech quotas and limits](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits).
For one personal Pin, start with F0 when it is available, watch usage in Azure,
and move to S0 only when you need it. Check Azure usage and quota information
if requests stop near a free allowance or request-rate limit. Luma does not
silently switch to a different speech provider.

## What Luma sends

The path is **Pin → your Cosmos server → the regional Azure Speech endpoint**.
The Azure key stays in Cosmos's owner-only state file. Center keeps no second
copy, does not return the saved key to the browser, and never sends it to the
Pin.

For speech to text, Cosmos sends:

- the captured audio as 16 kHz, 16-bit, mono PCM in a WAV container;
- the configured subscription key in Azure's authentication header;
- the configured region as part of the HTTPS endpoint;
- `language=en-US` and a request for Azure's simple transcription response;
- the product User-Agent `luma-cosmos`.

For text to speech, Cosmos sends:

- the text that should be spoken, escaped inside SSML;
- the exact configured voice name;
- the requested stock-compatible audio format;
- the same subscription key, regional HTTPS endpoint, and `luma-cosmos`
  User-Agent.

Cosmos does not log the key, recorded utterance, or reply text in the Azure
adapter. Microsoft says real-time speech-to-text audio is processed in server
memory and is not stored at rest, and that real-time text-to-speech input and
generated audio are not retained. Read Microsoft's current
[speech-to-text privacy statement](https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/speech-service/speech-to-text/data-privacy-security)
and [text-to-speech privacy statement](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/speech-service/text-to-speech/data-privacy-security)
for the provider's terms and exceptions. Microsoft also says Azure Speech
processes this data in the region where the resource was created.

Center's browser microphone is separate: when available, it uses the browser's
own `SpeechRecognition` implementation. The Azure settings on this page cover
Cosmos's Pin speech and Center's synthesized spoken replies, not an on-device
or browser-local recognizer.

## Troubleshooting

<details>
<summary><strong>Test is disabled</strong></summary>

Enter both **Azure Speech key** and **Azure region**. If a key was already
saved, leave its password field blank to keep it; the saved key still counts.
If you chose **Remove**, choose **Keep** or paste a replacement before testing.

</details>

<details>
<summary><strong>Center says the region is invalid</strong></summary>

Use Azure's lowercase identifier with no spaces, such as `westeurope` or
`eastus`. Do not enter a display label such as `West Europe`, the full endpoint
URL, or a trailing slash.

</details>

<details>
<summary><strong>Test says the provider did not complete the request</strong></summary>

Check all three values:

1. Recopy one key from the same resource's **Keys and Endpoint** page.
2. Make sure **Azure region** belongs to that exact resource. Keys are
   region-scoped.
3. Reset **Azure voice** to `en-US-AvaMultilingualNeural` and test again.

Also check the Azure resource's status, quota, subscription billing state, and
network restrictions. A regenerated key stops working immediately; paste the
new value into Center before retrying.

</details>

<details>
<summary><strong>Test works, but the Pin does not understand me</strong></summary>

The Center test checks text to speech only. Luma's Azure short-audio request
currently specifies `en-US`, so first test with a short US-English phrase.
Then check the Pin is unlocked, online, and using its normal voice gesture.
Microphone capture and device networking are separate from Azure synthesis.

</details>

<details>
<summary><strong>The Pin understands me but does not speak</strong></summary>

Run **Test** again. If it succeeds, try the Pin at a higher volume and restart
the request. A successful Center test proves Azure returned audio to Cosmos,
not that the Pin received or played it. Continue with
[Luma troubleshooting](../troubleshooting.md)
if the problem remains.

</details>

<details>
<summary><strong>The voice is silent, wrong, or rejects a newer HD name</strong></summary>

Restore `en-US-AvaMultilingualNeural` and test. Voice names are exact and are
not translated from friendly names. This Luma version's Center validation does
not accept the colon found in newer `:DragonHDLatestNeural` identifiers. Once
the default works, choose a conventional neural name containing letters,
numbers, and hyphens from Microsoft's supported list.

</details>

<details>
<summary><strong>Requests sometimes fail with a rate-limit or availability error</strong></summary>

Wait and retry once. F0 allows little concurrency, and Microsoft notes that
some text-to-speech 429 responses can reflect capacity for a particular voice
in a region rather than your numerical quota. If the problem repeats, check
Azure metrics and quotas, try the default voice, or review S0 and a nearby
supported region. Changing region means creating or using a resource in that
region and updating both the key and region in Center.

</details>

## Remove or rotate access

### Remove Azure Speech from Luma

1. In Center, open **Settings → Assistant & voice → Voice**.
2. Beside **Azure Speech key**, choose **Remove**.
3. Choose **Save changes**.

You see: the key is no longer configured and Speech returns to **Needs setup**.
Cosmos stops authenticating to Azure. Removing the key from Luma does not
delete the Azure resource or stop Azure-side billing for anything else using
it.

To remove the provider resource too, open it in the Azure portal and choose
**Delete**, or delete its resource group only if that group contains nothing
else you need. Microsoft includes portal and CLI removal in its
[Speech quickstart cleanup](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/get-started-text-to-speech#clean-up-resources).

### Rotate the key without losing speech

Azure provides two keys specifically for rotation. Microsoft's
[key-rotation procedure](https://learn.microsoft.com/en-us/azure/ai-services/rotate-keys)
warns that regenerating a key invalidates its old value immediately.

1. Identify which key Luma currently uses. If you are unsure, treat it as KEY 1
   and rotate KEY 2 first; do not regenerate both.
2. In Azure **Keys and Endpoint**, regenerate the unused key.
3. In Center, paste that new key into **Azure Speech key** and choose **Test**.
   Test saves it first.
4. Confirm **Working** and verify one spoken Pin request.
5. Back in Azure, regenerate the old key so any leaked copy becomes invalid.

Luma now uses the new key. Keep using one key at a time so the other remains a
safe path for the next rotation.
