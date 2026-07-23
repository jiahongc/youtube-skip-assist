# Changelog

## 1.18

- Made the pre-skip notice playback-speed aware so it appears about five real-world seconds before a known skip at speeds such as 2× or 0.5×.

## 1.17

- Replaced the countdown with a single `Jump Ahead detected, skipping soon.` notice shown up to five seconds before a known skip.

## 1.16

- Clarified the countdown notice to read `Jump Ahead detected — skipping in 3…`.

## 1.15

- Preserved handled-segment suppression across same-video YouTube lifecycle events, preventing replayed segments from being skipped again.
- Added a three-second on-player countdown before known upcoming automatic skips.

## 1.14

- Pressing the left arrow immediately after an automatic skip now returns to the start of that skipped segment.
- Manually seeking back into a skipped segment suppresses only that segment for the current video; later segments continue to skip normally.
- Updated the on-screen Undo action to use the same per-segment suppression behavior.

## 1.13

Chrome Web Store submission prep (no behavior change):

- Renamed the extension to `Auto Jump Ahead for YouTube`. The `… for YouTube` form avoids implying official affiliation, which is the main trademark-rejection risk. Name propagated across manifest, README, popup, and privacy pages.
- Replaced the red, YouTube-style play-button icon with a neutral indigo skip-forward glyph to avoid a trademark/affiliation rejection.
- Reworded the store description to state plainly that this is not an ad blocker — it only automates skip actions YouTube already provides. Rewrote `docs/CHROME_WEB_STORE.md` into a fill-in submission sheet.
- Renamed the GitHub repo to `auto-jump-ahead-for-youtube` and updated all URLs, including the GitHub Pages privacy-policy link.

## 1.12

Jump Ahead reliability: remove the cases where a skip only fired after mouse interaction.

- Parse the `yt-navigate-finish` event `detail` payload directly. On SPA and cache-hit navigation the window globals often keep the previous video's data and no interceptable network request fires — the fresh watch response rides in the event itself.
- Added the live player API (`movie_player.getPlayerResponse()`) as a third data source; it always reflects the current video, immune to stale globals.
- DOM button sightings now feed the data path: when content.js sees YouTube's own Jump Ahead/skip button (even hidden) and nothing is armed for the current time, injected.js reprocesses all sources instead of relying on a DOM click that silently no-ops while controls are hidden. No-op clicks trigger the same reprocess.
- Broadened seek-command extraction across known wrapper shapes (`serialCommand` → `commandExecutorCommand` → direct `innertubeCommand`), still as an explicit ordered path — no blind deep search.
- Match `timelyActions` lists anywhere in payloads (all occurrences) instead of only the first `timelyActionsOverlayViewModel` container.
- Debug surface fixes: `filteredOut` now actually records dropped segments with reasons (incl. onTap shape summaries for payload-drift diagnosis), network-payload source records survive `processAllSources()` runs, `jumpAhead.activeSegments` mirrors the real armed list, and button sightings are recorded under `domButtonSightings`.

## 1.11

- Restored an opening-seconds grace: no auto-skip while playback is under 5s, so opening a video no longer skips the instant it starts (regression from 1.10 dropping the lead-in guard). Applies to jump-ahead, `SMART_SKIP`, and ad-chapter segments, in both the data and DOM-click paths.

## 1.10

- Redesigned the Jump Ahead toast notification: shows `label · from → to · +duration` (e.g. `YouTube Jump Ahead · 2:14 → 2:36 · +22s`) instead of a flat one-line status.
- Added an Undo button on the toast that rewinds to the pre-skip timestamp and clears the matching done-zone so the segment is not immediately re-skipped.
- Added a second Jump Ahead data source: decode `SMART_SKIP` entity mutations from `frameworkUpdates` so we pick up segments that never surface in `timelyActionsOverlayViewModel`.
- Removed the global jump-ahead cache so late-arriving payloads can add new segments, and replaced the all-or-nothing stale-globals bail with per-source video-id staleness filtering.
- Relaxed jump-ahead acceptance thresholds (min delta 1s, max 15min, no 10s lead-in guard) and deduplicated segments across sources.
- Added a direct-seek path in the content script: when the DOM button exposes a duration in its aria-label (e.g. "Jump ahead 22 seconds"), seek the `<video>` directly instead of clicking a potentially hidden overlay button.
- Suppressed fullscreen-hidden DOM clicks; the data-driven heartbeat now handles those cases on the next tick.
- Improved skip labels: chapter skips now read `Skipped chapter: <title>` and jump-ahead reads `YouTube Jump Ahead` (pulled from the button's own title/accessibility text when available).
- Added a `window.__autoskipDebug` surface (`printJumpAhead()`, `printSnapshot()`, `reprocess()`) and structured debug logging under the `[AutoSkip]` prefix to make misfires diagnosable from the DevTools console.

## 1.9

- Fire the retry/slow-poll cadence on direct page loads (pasted URL, refresh, new tab), not only on SPA navigation — removes the last case where users had to move the mouse before Jump Ahead would trigger.
- Attach the video handler and heartbeat as soon as the `<video>` element exists, independent of segment availability, so the first skip after data arrives never waits on a DOM mutation.
- Suppress the misleading "Jumped ahead" toast in the DOM-click fallback when the click was a no-op against a hidden overlay; the data-driven path handles it on the next heartbeat tick.
- Removed first-chapter guard that was blocking Jump Ahead segments in the first chapter.
- Added heartbeat polling and extra event listeners for more reliable auto-skip timing.
- Added periodic button polling in content script to catch skip buttons without mouse interaction.
- Renamed the extension to `YouTube Skip Assist` for clearer, policy-safe positioning.
- Updated public-facing copy to emphasize supported skip assistance and metadata-dependent chapter skipping.
- Tightened chapter matching to avoid false positives.
- Improved YouTube SPA/navigation reliability.
- Improved payload interception across fetch/XHR variations.
- Added intro-chapter guard (do not skip intro unless ad cues exist).
- Added dedicated privacy policy page and markdown fallback.
- Refreshed README and user documentation.

## 1.4

- Added popup toggles for Jump Ahead and Ad Chapter behavior.
- Added music video guard.
- Improved chapter extraction robustness across YouTube payload shapes.
