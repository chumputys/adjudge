# adjudge

An ad blocker with no filter list.

Every filter list is a guess someone else made, months ago, about a host you
have not visited yet. `adjudge` replaces the guess with a decision: unknown
third-party hosts, in-feed sponsored blocks, and popup windows are each judged
at the moment they appear by [TypeSafe Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev),
a model that returns typed answers with calibrated probabilities instead of text.
Jev answers in 70–500ms, charges for input tokens only, and every verdict is
cached — so a host costs one classification, ever.

## The three layers

**Requests.** A small seed list blocks the obvious ad networks with zero
latency. `webRequest` observes everything else; unknown third-party hosts are
batched twelve at a time into a single Jev round trip carrying two questions per
host — a `choice` (ad / tracker / functional) and a `score` estimating how badly
the page breaks if the host disappears. Anything judged ad or tracker above the
confidence threshold, with low breakage risk, becomes a persistent
`declarativeNetRequest` rule. Verdicts cache for 30 days.

**Page blocks.** The content script collects candidates — cross-origin iframes,
ad-hinted class names, blocks whose text says "Sponsored" — describes each one
compactly, and sends the batch as one question per block. Matches are hidden
with a reversible inline `display: none`, never removed from the DOM. The
resulting selectors are saved as a template keyed by origin plus route family,
so the next page on that site applies instantly with no API call.

**Popups and redirects.** A `MAIN`-world shield at `document_start` stops the
"click a real control, get an ad tab" pattern: `window.open` without a genuine
trusted gesture returns a stub window rather than `null`, so popunder scripts
don't fall back to navigating the page; programmatic `<a target="_blank">`
clicks outside a gesture are dropped; transparent full-viewport overlay links
and anchors wrapped around a player are defused in place. Any new tab that does
get opened cross-site is checked against Jev before it is allowed to stay.

## Setup

### Prerequisites

- Node.js 18+ or later
- npm
- Google Chrome or Chromium-based browser

### Install dependencies

```bash
git clone https://github.com/chumputys/adjudge.git
cd adjudge
npm install
```

### Build the extension

```bash
npm run build
```

This generates the unpacked extension files in the `dist/` directory.

### Load the extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`.
2. Turn on Developer mode in the top-right corner.
3. Click `Load unpacked`.
4. Select the `dist/` folder inside this project.
5. The extension card should appear in Chrome.

### Configure the API key

Open the extension settings/options page, then paste a [Vercel AI Gateway](https://vercel.com/ai-gateway/models/jev)
API key and press **Test key**. The key is stored in `chrome.storage.local` and
never leaves the browser except as the `Authorization` header on Jev calls.

The extension will not judge requests or page elements until a valid key is
configured.

## Settings

| Setting | Default | Effect |
|---|---|---|
| Block ad & tracker requests | on | The request layer |
| Hide sponsored blocks | on | The page-block layer |
| Hide site promos | off | Also hides newsletter, app-install and paywall nags |
| Block popups & redirects | on | The shield |
| Confidence threshold | 0.75 | Raise to block less, lower to block more |
| Allowlist | empty | Per-site, also togglable from the popup |

## Layout

```
src/
  background.js   service worker: batching, rules, popup guard, messaging
  jev.js          the three Jev calls — hosts, elements, connection test
  shield.js       MAIN-world popup and overlay shield
  content.js      candidate collection, reversible hiding, template reuse
  selectors.js    stable selector generation, route-family keys
  stats.js        buffered daily counters
  cache.js        host verdicts and page templates
  settings.js     defaults and allowlists
```

## Licence

MIT
