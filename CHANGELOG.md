# Changelog

All notable changes made to Discross between **February 23–27, 2026**.

---

## February 27, 2026

- **[#272](https://github.com/larsenv/discross/pull/272) Fix messages and drawings stuck on Discord timeout** — Added AsyncLock timeout, bot readiness guards, and per-call 15-second timeouts in `send.js`, `reply.js`, and `senddrawing.js`; removed undici override that caused `webhook.send` to hang.
- **[#274](https://github.com/larsenv/discross/pull/274) Sync channel.html layout changes to channel_reply.html** — Removed `display:flex`/`height:100vh` from `channel_reply.html` to match the plain block layout introduced in `channel.html`, fixing the PlanetWeb 3 (Dreamcast) broken layout.
- **[#270](https://github.com/larsenv/discross/pull/270) Convert privacy/terms pages to dynamic templates** — Created `pages/privacy.js` and `pages/terms.js` handlers with full theme and header support; removed old static HTML files.
- **[#264](https://github.com/larsenv/discross/pull/264) Move server template partial CSS into main.css** — Removed duplicate inline `<style>` blocks from `images_enabled.html`, `no_images_warning.html`, `server_list_only.html`, and `sync_warning.html`; all rules now live in `main.css`.
- **[#262](https://github.com/larsenv/discross/pull/262) Add 2FA (TOTP), password change, and updated password rules** — Added TOTP-based two-factor authentication with QR code setup, backup codes, and a disable flow; added a change-password page; tightened password validation to require ≥7 chars, ≥1 uppercase, ≥1 lowercase, and ≥1 number.
- **[#250](https://github.com/larsenv/discross/pull/250) Fix DSi color picker row overflow and toolbar centering on draw page** — Eliminated HTML-comment whitespace causing 8-per-row color boxes to break into two columns on DSi; centered toolbar; separated pen-size buttons onto their own row.
- **[#260](https://github.com/larsenv/discross/pull/260) Suppress dotenv startup log** — Passed `{ quiet: true }` to `dotenv.config()` to stop the informational injection message from appearing on every startup.
- **[#244](https://github.com/larsenv/discross/pull/244) Add Sentry integration for exception logging** — Added opt-in Sentry error reporting via a `SENTRY_DSN` environment variable; wraps all page handlers, `unhandledRejection`, and `uncaughtException` events.
- **[#254](https://github.com/larsenv/discross/pull/254) Apply Discord role colors to message author names** — Fixed `getMemberColor` to use `member.roles.color` (highest colored role) instead of `member.roles.highest`; unified member lookup to always call `ensureMemberData`.
- **[#252](https://github.com/larsenv/discross/pull/252) Fix reply indicator shape, nickname priority, and member lookup** — Corrected the L-shaped reply indicator to match Discord's top-left corner style; unified member lookup for all messages including replies and forwarded messages; fixed server nickname priority (server nickname → global name → username).
- **[#242](https://github.com/larsenv/discross/pull/242) Remove animation toggle; add URL param support for theme and images** — Removed the non-functional animation toggle; converted `/switchtheme` and `/toggleImages` to GET; added `theme` and `images` URL parameters that take priority over cookies.
- **[#248](https://github.com/larsenv/discross/pull/248) UI fixes: button colors, channel list contrast, curly quotes, and more** — Fixed AMOLED/light theme button colors on the server page; improved channel list text contrast; stripped curly/smart quotes before rendering; fixed warning box button styles; converted theme-switch and image-toggle HTML buttons to anchor links.

---

## February 26, 2026

- **[#246](https://github.com/larsenv/discross/pull/246) Fix post-login redirect broken on local IP/port** — Replaced hardcoded `http://discross.net` base URL with relative redirect paths, fixing login on any host or port.
- **[#240](https://github.com/larsenv/discross/pull/240) Consolidate all CSS, JS, and HTML head into external files** — Moved all inline CSS into `pages/static/css/main.css`; extracted all inline JavaScript into `pages/static/js/channel.js`, `draw.js`, and `server.js`; introduced a shared `pages/templates/partials/head.html` partial; fixed numerous IE1/IE2 and legacy browser compatibility issues.
- **[#238](https://github.com/larsenv/discross/pull/238) Fix draw page send button floating on modern browsers** — Restored `position: fixed; bottom: 0` on `.message-form-container` for screens wider than 256 px via `@media (min-width: 257px)`; DSi (≤256 px) retains static positioning.
- **[#236](https://github.com/larsenv/discross/pull/236) Fix 3DS file upload** — Restored `<button type="button">` trigger for the file input; replaced ES6 `let` with `var` in the console-warning loop that was crashing the entire script block on the 3DS NetFront browser.
- **[#232](https://github.com/larsenv/discross/pull/232) Fix user and channel mention resolution after bot restart** — After a restart the Discord.js cache is empty; added async batch-fetch paths for unresolved `<@ID>` user mentions and `<#ID>` channel mentions using `Promise.allSettled`.
- **[#224](https://github.com/larsenv/discross/pull/224) Fix draw page scrolling, send bar layout, and DSi canvas performance** — Matched `channel.html` scroll container; removed `position: fixed` from send bar so it flows in normal document order; batched canvas stroke calls with `setInterval` for ~33 fps on DSi; shrunk canvas buffer to 240×140 on DSi for ~6× faster repaints.
- **[#230](https://github.com/larsenv/discross/pull/230) Replace deprecated `url.parse()` with WHATWG URL API** — Replaced all `url.parse()` calls across 14 files with `new URL()`; removed now-unused `url` require statements.
- **[#228](https://github.com/larsenv/discross/pull/228) Remove black empty embed box for inline image embeds** — Added special handling for `embed.type === 'image'` and `'gifv'` so Discord-generated image embeds render inline instead of showing a blank color-bar container.
- **[#226](https://github.com/larsenv/discross/pull/226) Fix WebTV HTML compatibility errors** — Fixed numerous HTML issues for WebTV: replaced self-closing tags, removed `sizes=` from favicon links, replaced `<button>` with `<a>` links, removed `required=` attributes, eliminated `<tbody>` tags, added explicit `width`/`height` on images, and replaced the Unicode category arrow with a GIF.

---

## February 25, 2026

- **[#216](https://github.com/larsenv/discross/pull/216) Add sessionID URL parameter propagation** — Login now redirects with `?sessionID=` appended; the parameter is carried through channel links, server icon links, the home logo link, and the draw page, enabling session support for browsers without cookie support (e.g. IE1/IE2).
- **[#211](https://github.com/larsenv/discross/pull/211) Fix drawing canvas on DS-based devices** — Fixed smushed canvas aspect ratio on 3DS/Wii; fixed coordinate bugs on DSi Opera 9.5 (`offsetX`/`offsetY` now used as primary source); fixed `xml.opera.com` connection attempts caused by `*::before`/`*::after` CSS selectors; added `@media (max-width: 256px)` DSi layout overrides for `position: fixed` and toolbar sizing.

---

## February 24, 2026

- **[#220](https://github.com/larsenv/discross/pull/220) Fix incorrect mentionsRepliedUser null check** — Changed `!== undefined` to `!= null` so a `null` `repliedUser` is correctly treated as "not mentioned", preventing a false mention ping.
- **[#218](https://github.com/larsenv/discross/pull/218) Fix infinite member fetch loop for unresolvable users** — `ensureMemberData` now caches `null` on fetch failure so subsequent calls for the same user short-circuit instead of retrying the API on every page load.
- **[#214](https://github.com/larsenv/discross/pull/214) Fix header, purple buttons, and theme support on index, privacy, and terms pages** — Unified the padded header layout across all pages; added purple `.discross-button` styling for light/AMOLED themes; fixed nav links on `logged_out.html`/`logged_in.html`; wrapped logos in home links; added `<!DOCTYPE html>` to privacy and terms pages.
- **[#209](https://github.com/larsenv/discross/pull/209) Add selective Unicode normalization** — Added `pages/unicodeUtils.js` with `normalizeWeirdUnicode()` that converts Mathematical Alphanumeric Symbols, full-width ASCII, typographic punctuation (curly quotes, dashes, ellipsis) to ASCII equivalents while preserving CJK, Arabic, Hebrew, and other legitimate foreign scripts; applied across display names, channel names, embed fields, and server names.
- **[#207](https://github.com/larsenv/discross/pull/207) Fix canvas draw page background color and send button placement** — Removed conflicting background colors on `#toolbar-container` and `#canvas-wrapper`; fixed `background: ##40444b` double-hash CSS bug; added `position: fixed; bottom: 0` to the send form; moved `#emoji` into `.message-form-container`.
- **[#205](https://github.com/larsenv/discross/pull/205) Fix drawing pen off-center on scaled canvas** — Applied the canvas display scale factor to drawing coordinates so the pen marks the correct position on devices where the canvas is CSS-scaled.
- **[#203](https://github.com/larsenv/discross/pull/203) Shrink images and simplify HTML for Wii Internet Channel** — Resized all images to max 256×256 GIF with full 256-color palette; added 1×1 transparent GIF fallback on upstream errors; capped attachment images to 256×200 and stickers to 100×100; replaced CSS Grid embed fields with `<table>` layout; proxied Tenor, Giphy, and YouTube thumbnail URLs through `imageProxy`.

---

## February 23, 2026

- **[#204](https://github.com/larsenv/discross/pull/204) Fix emoji picker rendering behind send button** — Moved `#emoji` div into `.message-form-container` in `channel_reply.html`; added `scrollIntoView()` when opening the picker (with `try/catch` for legacy browser compat).
- **[#200](https://github.com/larsenv/discross/pull/200) Fix input and button styling on login, register, and forgot-password pages** — Standardized text input and submit button appearance across all three pages and all themes; fixed AMOLED white body background patch; made register page single-column; corrected spacing between form elements.
- **[#202](https://github.com/larsenv/discross/pull/202) Fix `{$MENU_OPTIONS}` not replaced in login, register, and forgot pages** — `login.js`, `register.js`, and `forgot.js` now load and substitute `logged_out.html` for the `{$MENU_OPTIONS}` placeholder before serving the page.
- **[#191](https://github.com/larsenv/discross/pull/191) Fix broken reply feature and consolidate channel_reply.js** — Added missing `{$REPLY_MESSAGE_ID}` hidden input (root cause of broken reply); fixed reply form action from `../send` to `../../send`; extracted shared `buildMessagesHtml` function; fixed null `replyUser` crash with optional chaining; fixed URL hostname sanitization.
- **[#193](https://github.com/larsenv/discross/pull/193) Fix extra space between Login and Register nav links** — Reduced double `&nbsp;` to a single `&nbsp;` between the Login and Register links in the header.
