---
name: cdp-headed-browser
description: Invoke when the agent needs Playwright to drive a web UI behind an interactive auth flow (SSO + device check + FIDO / hardware-key prompts) that a throwaway isolated Chromium can't complete, OR when the operator wants multiple agents to share one auth'd browser, OR when a Playwright MCP session fails because the user-data-dir is unrecognized. Covers the CDP-attach architecture (long-running headed browser + Playwright MCP attaches via `--cdp-endpoint`), the launch ritual, the macOS first-launch trap, the no-`bringToFront()` rule, and reusable `connectOverCDP` patterns. Do NOT invoke for browser tasks against sites where a throwaway isolated Chromium suffices, for headless scraping that doesn't need auth, or when the operator's current Playwright MCP is already working — the architecture switch has a relaunch cost and shouldn't be paid speculatively.
---

# cdp-headed-browser

This skill inherits all invariants in `../../principles.md`. Read them first if they are not already in context.

> **overlay users**: consumer overlays for org-managed Macs may ship their own managed-browser skill (covering corporate IdP conditional access, platform SSO, and managed-Edge specifics). This skill stays generic.

The default Playwright MCP shape (throwaway isolated Chromium per session) breaks against any web surface with strict auth because:

1. **Device-binding checks fail on fresh profiles** — a fresh `--user-data-dir` is an unrecognized device. SSO can refuse the sign-in before auth even gets to FIDO / hardware key.
2. **Sessions can't share state** — every isolated launch starts from scratch; even if you somehow auth once, the next agent invocation re-FIDOs.
3. **Headless mode silently swallows interactive auth prompts** — Windows Hello / hardware-key prompts can't be completed; the script just hangs at "Please wait."

The fix is a different architecture: one **long-running headed browser** outside any agent session, with **Playwright MCP attaching to it via CDP**. Each session opens its own tab; auth state lives in the shared browser profile; multiple agents can drive concurrently without profile-lock conflicts.

This skill covers how to set that up, the gotchas the agent has actually hit, and the patterns to drive a CDP-attached browser without trampling the operator.

## When to set this up vs. when to leave it alone

Setting it up costs a relaunch ritual and a one-time browser profile bootstrap. Pay that cost when:

- The operator's task needs an authenticated web UI that won't complete in an isolated Chromium.
- Multiple agents need to drive Playwright concurrently against the same surface.
- A previous attempt with the default isolated Chromium hit a device-binding / SSO error or got stuck at a hardware-key prompt.

Don't pay it for one-off scraping against external sites where the isolated Chromium works fine.

## The 3-constraint architecture

| Constraint | Default isolated MCP | CDP-attach to headed browser |
|---|---|---|
| Any number of agents | Each spawns own Chromium. No state shared. | All MCP sessions attach to one browser, each opens its own tab. |
| Headed for human interaction + oversight | Headless by default; FIDO un-completable. | Browser is a real window; operator can intervene. |
| Maintain session context (auth) | Fresh profile each session; auth lost. | Profile is persistent in `~/.playwright-agent-browser`. |

## Workspace MCP config

Workspace MCP config `[mcps.servers.playwright]` block for CDP-attach:

```toml
[mcps.servers.playwright]
type = "stdio"
command = "npx"
args = [
  "-y",
  "@playwright/mcp@latest",
  "--cdp-endpoint", "http://localhost:9222",
]
```

No `--browser`, no `--isolated`, no `--user-data-dir`, no `--headless`. The browser running at `:9222` dictates the rest.

After editing the workspace MCP config, the operator must relaunch the agent for the MCP to re-read its config.

## Browser launch

Pick a Chromium-derived browser the operator has installed (Chrome, Edge, Chromium, Brave). Launch it with a persistent profile directory and the CDP debugging port:

```bash
nohup "<path-to-browser-binary>" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.playwright-agent-browser" \
  > /tmp/agent-browser.log 2>&1 &
disown
```

Then verify CDP is listening:

```bash
curl -s http://localhost:9222/json/version | jq '.Browser'
```

Expected: a string identifying the browser and version.

(overlay users on an org-managed Mac: consumer overlays may ship the specific managed-Edge binary path, platform SSO behavior, and conditional-access notes.)

## macOS first-launch trap

On the very first launch with a new `--user-data-dir`, macOS Chromium-derived browsers tend to prioritize their first-run UX (welcome page, default-browser ask, sync setup) over any URL passed as a positional argument. The URL gets dropped on the floor.

Workaround: launch without a URL, wait for CDP to come up, then open the actual target URL via CDP HTTP API:

```bash
curl -s -X PUT "http://localhost:9222/json/new?https://example.com/..."
```

After the profile is established (the first run is over), subsequent launches honor a URL arg normally. The trap only bites once per `--user-data-dir`.

## The no-`bringToFront()` rule

When driving the CDP-attached headed browser, **never call `page.bringToFront()`**. The call yanks the browser app to the OS foreground every time it runs, stealing focus away from whatever the operator is doing in their other windows.

This is invisible under the prior `--isolated` headless mode (no window = nothing to raise) but extremely visible under a CDP-attached headed browser. Operators have called it out by name as a focus-grabbing trap.

Playwright's CDP-synthesized click/fill events don't require the window to be in foreground. The page can be backgrounded for the entire automation while still responding to all CDP commands.

If a specific action genuinely needs the page visible (a Save-As dialog, an OS-level permission prompt — rare), surface that to the operator instead of grabbing focus silently.

## Sending to a real human — read the authoritative outbound layer before you send

The highest-stakes operation on a CDP-driven UI is pressing Send on a message to a real person. A rich web editor (Teams, OWA, Slack, etc.) keeps an internal **model** separate from the **DOM**: a real paste or a real keystroke commits to the model, but `document.execCommand('insertText')` and similar DOM-injection only rewrite the DOM. Pressing Send transmits the **model**, not the DOM. So a script that injects into the DOM, "verifies" by reading `innerText` (the DOM), and presses Send can transmit content the agent never actually saw — including stale or wrong content it had explicitly rejected.

**HARD RULE: never send without reading the EXACT content that will transmit, via the authoritative path — never a layer you just manipulated.** If you can't reliably read what will go out, you don't send.

Mechanics:

1. **Enter text via a method that commits to the editor model** — a real paste of verified-current clipboard, or real keyboard typing (Shift+Enter for newlines) — NOT `execCommand` DOM injection.
2. **Read the committed / rendered state back** (the model's rendered output, not the layer you injected), confirm it matches the intended text, THEN send.
3. **Don't use the shared OS clipboard as a private staging buffer when a human shares the machine.** A human actively using the box can clobber your clipboard between stage and paste, so the *path* pastes instead of your message; prefer keyboard entry that doesn't depend on clipboard state, or re-read the clipboard immediately before paste.
4. **For outbound messages to real people, default to surfacing the final text for operator confirmation before send**, unless explicitly told to fire autonomously.

Companion: any composer with an autocomplete picker (@-mentions, recipient fields) has its own chip-verification trap on top of this — route through the host context's dedicated posting skill when one exists, which encodes those gates.

## CDP HTTP API — what you can do without Playwright

The browser's CDP server exposes a small HTTP surface (default `:9222`) that's useful for cheap operations without spinning up the Playwright library:

```bash
# List all tabs (filter to type=page to skip background_page extensions)
curl -s http://localhost:9222/json | jq -r '.[] | select(.type=="page") | "\(.id)\t\(.title)\t\(.url)"'

# Browser metadata
curl -s http://localhost:9222/json/version

# Open a new tab to a URL (works around the first-launch trap above)
curl -s -X PUT "http://localhost:9222/json/new?<URL>"

# Activate (focus) an existing tab
curl -X PUT "http://localhost:9222/json/activate/<tab-id>"

# Close a tab
curl -X PUT "http://localhost:9222/json/close/<tab-id>"
```

For anything that requires *interaction* (clicks, fills, navigation tracking), use Playwright's `chromium.connectOverCDP()` — see template below.

## Playwright `connectOverCDP` template

When the agent needs to drive the attached browser from a Node script (e.g. when the Playwright MCP isn't loaded yet but the browser is already running):

```js
import { chromium } from 'playwright';
// (path to playwright will vary — typically ~/.npm/_npx/<hash>/node_modules/playwright/index.mjs
// after any prior `npx @playwright/mcp@latest` has populated the cache)

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];                  // default persistent context
const page = ctx.pages().find(p => p.url().includes('<target>')) || ctx.pages()[0];

// NO page.bringToFront() — see rule above.

await page.locator('[aria-label="<label>"]').click();
// ...

await browser.close({ reason: 'detach' });          // disconnects MCP from browser;
                                                    // browser keeps running.
```

Important: on a CDP-attached browser, `browser.close()` only detaches Playwright — the browser process keeps running for the next agent. That is a property of the attachment, not of the `{ reason }` option: Playwright did not launch this browser, so it does not terminate it. The `reason` is a label that makes a stray call easier to trace, so keep passing it, but do not treat it as the guard. (A browser from `chromium.launch()` *is* owned by the script, and closing that one does terminate it.) To actually terminate an attached browser, use `pkill` (see Cleanup).

There is no `browser.disconnect()`. Calling it throws `TypeError: browser.disconnect is not a function` (checked against `playwright-core` 1.62.1). `close()` is the release call.

## Cleanup

When the operator says "close the browser" or the agent is done with a one-off CDP-attached session:

```bash
pkill -f "user-data-dir=.*playwright-agent-browser"
# Verify:
pgrep -lf playwright-agent-browser || echo "(cleared)"
curl -s --max-time 2 http://localhost:9222/json/version || echo "(CDP gone)"
```

Chromium-derived browsers spawn helper processes (renderer, GPU, utility) that may need a second pass — repeat the `pkill` if any survive. The `--user-data-dir` itself stays on disk; auth state in it persists for the next launch.

## Failure modes

- **CDP not listening (`curl ... | head -c 50` returns empty / connection refused)** — the browser isn't running, or running without `--remote-debugging-port`, or another process is holding the port. Verify with `lsof -i :9222`.
- **SSO / device-binding error on auth** — the user-data-dir isn't recognized by the IdP. overlay users: consumer overlays may ship IdP-specific fallbacks. Otherwise: accept the one-time interactive auth and rely on cached cookies.
- **First navigation lands at a welcome / first-run page regardless of URL arg** — first-launch trap; use `/json/new?url=` workaround.
- **Operator's focus keeps getting stolen** — `bringToFront()` is somewhere in the script. Strip it.
- **Playwright `connectOverCDP` returns 0 contexts** — the browser crashed or restarted without the CDP flag. Re-launch.
- **Never releasing the connection** — every `connectOverCDP` holds one of a small pool of websocket slots on the debug port. A script that exits without calling `browser.close()`, or a loop that reconnects per poll, holds slots indefinitely and eventually starves every session on the machine. The signature is `connectOverCDP` timing out after 30s while `curl` against the same port answers instantly. Diagnose with `lsof -nP -iTCP:9222`, and identify each holder's owner before touching anything — a connection you did not open is not yours to close. Long-running loops connect once and reuse, reconnecting only when `browser.isConnected()` is false.

## Cross-references

- **Workspace MCP config schema** — see `desk:add-workspace-mcp` for the `[mcps.servers.<alias>]` shape and the runtime-spawner gotchas around `type = "npx"` vs `type = "stdio"`.
- **The persistent `~/.playwright-agent-browser` directory** is sacred state. Don't delete it; it holds auth.
