# Connect Open Food Facts

Open Food Facts supplies Luma’s packaged-food and nutrition data. The important
part is simple: **food lookups and the Pin’s food log do not require an Open
Food Facts account**. Luma reads the public API with no key.

An account is optional. In the current implementation, saving a username and
password only lets Center verify that sign-in. Luma has no provider-write path
today, so connecting an account does not upload products, images, corrections,
or food-log entries to Open Food Facts. Your food log stays in Cosmos.

**Provider details checked October 2026.** Open Food Facts documents that read
operations need no authentication, while product edits and image uploads do.
See its [official API introduction and authentication rules](https://openfoodfacts.github.io/openfoodfacts-server/api/).

## What this enables

Without any account:

- nutrition lookup for a packaged food or drink by name or barcode;
- product name, brand, serving size, ingredients, and available nutrient data;
- the stock text-based food-identification path; and
- food logging and totals stored privately on your Luma server.

What it does not enable:

- identifying food from a photo without a separate vision backend;
- guaranteed matches for restaurant meals, recipes, generic foods, or products
  missing from the community database;
- allergy-safety guarantees; or
- contribution to Open Food Facts from Luma today, even with an account saved.

## Checklist

For lookup and food logging, there is nothing to configure. Verify that your
server can reach `search.openfoodfacts.org` and `world.openfoodfacts.org`, then
skip to [Verify food lookup](#verify-food-lookup).

Only use the optional account steps if you want Center to keep and test an Open
Food Facts sign-in:

- [ ] You understand that Luma does not currently write to the provider.
- [ ] You can create an Open Food Facts production account.
- [ ] You can sign in to Center as the operator.

## Optional: create an Open Food Facts account

1. Open [Open Food Facts](https://world.openfoodfacts.org/) and choose the
   account or sign-in control, then choose the registration option.

2. Create the account and complete any email confirmation Open Food Facts
   requests.

   You see: a signed-in Open Food Facts account. Remember the **username** you
   chose; Luma needs the username, not the email address. Open Food Facts’s API
   documentation explicitly distinguishes `user_id` from email.

3. Open Food Facts asks API users to submit its
   [API usage form](https://docs.google.com/forms/d/e/1FAIpQLSdIE3D8qvjC_zRJw1W8OmuHhsWJ_NSckiiniAHlfaVwUZCziQ/viewform)
   so it can identify legitimate traffic. This does not create a Luma key.

Production and staging have separate account databases. Create the account on
`world.openfoodfacts.org`; a staging account from `.net` will not pass Luma’s
production sign-in test.

## Optional: add the account to Luma

1. In Center, open **Settings → Assistant & voice**.
2. Expand **Food & nutrition**.
3. Enter the account name in **Open Food Facts username**.
4. Enter the account password in **Open Food Facts password**.
5. Choose **Test Open Food Facts**. Testing also saves every pending change on
   this page.

   You see: **Open Food Facts sign-in succeeded.** The test proves only that
   the production service accepts the saved username and password. It does not
   perform a product lookup, write a product, or add anything to the wearer’s
   Luma food log.

Both fields are required for the test and for Center to label the optional
account **Connected**. After saving, Center clears both fields and never reads
the password back into the browser.

## Verify food lookup

1. Unlock the Pin and ask for a specific packaged product, for example:
   **“How many calories are in a can of Coca-Cola?”** A barcode is more precise
   when you know it.

   You see and hear: the matched product and the nutrition fields Open Food
   Facts supplies. A missing nutrient is omitted rather than estimated.

2. Add the item through the Pin’s normal food-log experience.

   You see: the entry and its available nutrition in **Settings → Food &
   nutrition**. The log is stored in Cosmos, not posted to Open Food Facts.

3. If a product does not match, try its barcode or a more exact product and
   brand name. A no-match is reported honestly with no fabricated nutrition.

The **Test Open Food Facts** button is not a lookup test: it appears only when
both optional credentials are saved and tests sign-in. Lookups continue to
work when that card says **Optional**.

## Costs and limits

**Checked October 2026.** Open Food Facts publishes its database as open data
and does not require a paid API key for Luma’s reads. Its current API limits
are:

- **15 requests per minute per IP address** for product reads;
- **10 requests per minute per IP address** for searches; and
- additional global protection that may return HTTP 503 during overload.

The provider documents no limit on product-write queries, but Luma does not
make those queries. See the official
[rate-limit and authentication documentation](https://openfoodfacts.github.io/openfoodfacts-server/api/#how-to-best-use-the-api).

A name lookup normally makes one search request and then one product request.
A barcode lookup skips search and makes one product request. These are
community-contributed data: Open Food Facts warns that accuracy, completeness,
and reliability are not guaranteed. Do not use a result as medical advice or
proof that a product is safe for an allergy.

## What Luma sends

For a lookup by name, Cosmos:

- reduces the request to up to eight useful food-search words and sends them
  as `q` to `https://search.openfoodfacts.org/search` with `page_size=5`;
- selects the closest returned product locally; and
- sends that product code to Open Food Facts’s v2 product endpoint, requesting
  only product name, brand, serving size, code, ingredients, and nutriments.

For a valid all-digit barcode, Cosmos skips the search and sends the barcode
directly to the product endpoint. Lookup requests carry Luma’s identifying
User-Agent, as Open Food Facts requires. They carry no Open Food Facts username
or password, wearer account ID, Pin ID, food-log history, preferences, or
dietary goals.

When you choose **Test Open Food Facts**, Cosmos sends the saved **username and
password only in an HTTPS POST form body** to Open Food Facts’s production
login endpoint, along with `body=1`. It does not put them in the URL. Cosmos
checks the returned username and does not retain a provider session cookie.
The credentials stay in Cosmos’s owner-only state volume and never go to the
Pin.

Food-log entries are Luma data. They are written to the wearer’s partition in
Cosmos and are never sent back to Open Food Facts.

## Troubleshooting

<details>
<summary><strong>The card says Optional, but food lookup works</strong></summary>

That is expected. **Optional** refers to the optional provider account, not the
public read API. Leave both credential fields empty unless you specifically
want Center to verify and retain an Open Food Facts sign-in.

</details>

<details>
<summary><strong>Test says the provider did not complete the request</strong></summary>

Use the Open Food Facts **username**, not the email address. Confirm the
password by signing in at `world.openfoodfacts.org`, then replace both fields
and test again. An account made only on the `.net` staging service will not
work against production.

</details>

<details>
<summary><strong>A product is missing or the match is wrong</strong></summary>

Use the barcode when possible. Name search is limited to five candidates and
Luma chooses the closest product name, brand, category, or generic-name match.
The database is community-maintained, so a product may be absent or incomplete.
Correct the product through Open Food Facts’s own app or website; Luma does not
currently submit corrections.

</details>

<details>
<summary><strong>A nutrient or serving value is missing</strong></summary>

Luma returns only values present in the selected product record. It does not
invent nutrients or infer a serving. Check the product in Open Food Facts and
contribute the missing label data there if appropriate.

</details>

<details>
<summary><strong>Lookup works, but the stock food experience is hidden</strong></summary>

The public lookup backend and the Pin’s device-local food-experience switch are
separate. In Center, open **Settings → Experimental features** for that Pin and
check **Food logging**. Read and accept the data acknowledgement before turning
it on. This switch does not make an Open Food Facts account mandatory.

</details>

<details>
<summary><strong>Lookups suddenly fail after many requests</strong></summary>

Wait before retrying. The provider limits name searches to 10 per minute per
server IP and product reads to 15 per minute per server IP. All wearers on one
Luma server share that public IP allowance.

</details>

## Rotate or remove the optional account

To rotate the password, change it through Open Food Facts, then enter the same
username and new password in Center and choose **Test Open Food Facts**.

To remove the saved sign-in, choose **Remove** beside both **Open Food Facts
username** and **Open Food Facts password**, then **Save changes**. Food
lookups and the Luma food log continue to work because they never use those
credentials. Delete the provider account separately on Open Food Facts if you
no longer want it; removing credentials from Luma does not delete that account.
