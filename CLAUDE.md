# KMHD Playlist History

KMHD radio playlist fetcher + its public page. The session homed here is named "KMHD Playlist history".

**Deploying to teedlo.com (zero-effort rule):** the playlist pages live at https://teedlo.com/1/ — `index.html` (daily playlist + "By Show"), `headnod.html` (The Headnod Show landing page), plus `playlist-utils.js`, `shows-schedule.js`, `itunes-cache.json` and `.htaccess`.

**/1/ deploys from THIS repo**, not teedlo-site: push to `main` in github.com/teedlo/kmhd-playlist-fetcher-update and `.github/workflows/deploy.yml` runs `node --test`, then SFTPs each file to `teedlo.com/1/`. Live in well under a minute. To add a new file to the site, add an upload step for it to that workflow — the deploy uploads a fixed list, not a directory.

The teedlo-site repo (github.com/teedlo/teedlo-site, local clone ~/Documents/Projects/teedlo-site — pull before use) deploys the *rest* of teedlo.com by committing under `site/` and pushing to main (~25s). It does **not** publish /1/; there is no `site/1/` there.

Never use the DreamHost panel. Commit author for both repos must be `teedlo <213245817+teedlo@users.noreply.github.com>` (the `213245817+` form is what attributes the commit to the GitHub account). Cloud sessions can deploy too — the repo is the pipeline.

**Two local gotchas that look like breakage but aren't:**
- The Cloudflare Worker (`kmhd-playlist-cache.teedlo.workers.dev`) sends `Access-Control-Allow-Origin: https://teedlo.com` only, so playlist fetches are CORS-blocked when serving from localhost and the direct-KMHD fallback is blocked too. Verify playlist/tracklist behavior on the deployed URL.
- Bump the `?v=` cache-bust on the `<script>` tags in **both** index.html and headnod.html whenever playlist-utils.js or shows-schedule.js changes, or browsers serve a stale copy and the page breaks silently.

Jonathan's preferences: dark mode, larger fonts, high-contrast (WCAG AAA) text; one-shot end-to-end handling.
