# Marketing site: motion.digitop.ai

Date: 2026-09-26 (Asia/Saigon). Status: built and verified locally, not deployed, not committed.

## What was built

The static site lives in `apps/marketing`. It is one HTML page with no framework. The only script is a 20-line copy button, and the page works without it.

| File | Purpose |
|---|---|
| `package.json` | `@motion-mcp/marketing`, private, `dev`/`deploy` scripts, `wrangler` 4.141.0 pinned exactly |
| `wrangler.jsonc` | `motion-mcp-marketing`, compatibility date 2026-09-25, `assets.directory ./public`, custom domain `motion.digitop.ai` |
| `public/index.html` | Sections: hero, how it works (four roles plus the two director modes), 8 tools, connect snippet, cost, open source, footer |
| `public/css/site.css` | Design tokens, light and dark themes, layout, CSS-only motion |
| `public/js/copy.js` | Progressive-enhancement copy button (hidden if the Clipboard API is missing) |
| `public/favicon.svg`, `public/img/mark.svg` | Timeline-and-playhead mark; the header mark inverts in dark mode |
| `public/llms.txt` | Product summary, endpoint, auth, tools, director modes and cost for AI agents |
| `public/robots.txt` | Allow all |

There is no `og.png`. Open Graph title and description are set without an image.

## Design decisions

- **Type.** Instrument Serif carries the display and section heads, Inter the body text, and JetBrains Mono the labels, tool names and numbers. Hierarchy comes from scale and rules, not boxes.
- **Color.** Paper `#f4f1ea`, ink `#111` and one accent `#e4572e`. On paper the accent reaches only 3.3:1, so it is used for graphics, rules and large display italics. Small accent text uses `--accent-ink #b5401d` (5.0:1). In dark mode the accent itself passes at 5.1:1. Muted text is 6.3:1 in light mode and 7.4:1 in dark mode.
- **Signature motion.** The hero has a render timeline: a playhead sweeps the execution graph (brief, direction, IR, build, lint and check, render, ffmpeg) and lights each clip it passes. It uses only transforms, container-query units and negative animation delays. Under `prefers-reduced-motion`, it shows a static frame with the playhead parked on "render". The timeline is `aria-hidden` because section 01 describes the same stages in text.
- **Honesty.** Following the docs, a status line says the project is in active development and the hosted endpoint is in early access. Credit values are labelled indicative design values from BILLING.md, with an "Early access" tag. No plan tiers are shown.
- **Accessibility.** The page has a skip link, header, nav, main and footer landmarks, and a single h1. Tools are marked up as a `dl` and prices as a table with a caption and scoped headers. Focus is shown with a 2px accent outline. Touch targets are at least 44px. The code block `pre` is focusable so it can be scrolled with the keyboard.

## Verification

- `wrangler dev` served every asset with status 200 and the correct content type. The server was stopped afterwards and port 8787 is free.
- Screenshots were taken with Puppeteer and the system Chrome: desktop at 1440px in light and dark mode, 375px in light mode, 360px in dark mode, and 375px with reduced motion. At 360 and 375, `scrollWidth` equals the viewport and no element overflows. Only the code block scrolls horizontally, which is intended.
- `biome check apps/marketing` passes.

## Notes

- `pnpm add` updated the root `pnpm-lock.yaml`. That was unavoidable with the prescribed command.
- pnpm reported that the `workerd` build script was ignored, because it is not in `onlyBuiltDependencies`. `wrangler dev` still worked locally. If a clean install breaks `wrangler dev` or `deploy`, add `workerd` to `pnpm-workspace.yaml` (outside this task's scope).

## Unresolved questions

- The key format for the config placeholder is unknown. The page uses `<YOUR_API_KEY>`. Swap in the real prefix once `api_keys.prefix` is decided.
- The footer links "Built by Digitop" to `github.com/digitopvn`. Replace it with the company site URL if one should be used.
- Should the "Connect" call to action stay live before the hosted endpoint opens, or point to a waitlist?
