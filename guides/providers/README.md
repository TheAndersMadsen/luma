# Set up provider services

> Part of the [Luma guides](../../docs/README.md). Start with the
> [main README](../../README.md) if you have not installed Luma yet.

Luma keeps provider accounts and keys on your own server. The Pin talks only
to that server. These guides show where to get each account or key, exactly
where it goes in Center, how to test it, what it may cost, and what Luma sends
to the provider.

You only need two services to start:

1. Choose one assistant connection:
   [OpenRouter](openrouter.md), [OpenAI API](openai-api.md), a
   [Codex subscription](codex-subscription.md), or another
   [OpenAI-compatible server](openai-compatible.md).
2. Set up [Azure Speech](azure-speech.md) so the Pin can speak its answers.

Everything below is optional. Add it when you want the feature.

| What you want | Provider guide |
| --- | --- |
| Nearby places, addresses, and routes | [Google Maps](google-maps.md) |
| Current weather and forecasts | [Pirate Weather](pirate-weather.md) |
| Calculations and factual knowledge | [Wolfram\|Alpha](wolfram-alpha.md) |
| Food and nutrition lookups | [Open Food Facts](open-food-facts.md) |
| Private web search included with Luma | [SearXNG](searxng.md) |
| Hosted web-search fallback | [SerpAPI](serpapi.md) |
| Research answers with sources | [Perplexity](perplexity.md) |
| Native playback on the Pin | [Spotify](spotify.md) |
| Public-track playback and saves | [YouTube Music](youtube-music.md) |
| TIDAL search and approved playback | [TIDAL](tidal.md) |
| Work delegated to your other devices | [Rabbit OS3](rabbit-os3.md) |

Provider pages and prices change. Each guide says when its provider details
were checked and links to the provider's own documentation. Luma's field names
and behavior are checked against this repository.

Apple Music appears in Center, but it cannot be selected for playback until an
official Android playback runtime is available. It therefore has no setup
guide yet. [Configure services in Center](../../docs/services.md#music)
explains the current limitation.

Never paste a key, password, session cookie, or device code into a terminal
command, issue, or support message. Enter secrets only in Center's protected
fields or at a `--stdin` prompt that you started yourself.
