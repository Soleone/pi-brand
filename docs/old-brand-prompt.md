---
description: Name an app, fast shortlist first, deep check only on picks
argument-hint: "[app description]"
---

Product to name: ${@:-Ask me what the app does if I haven't described it.}

Do this in two phases. Phase 1 is speed. Do not deep-verify everything upfront.

## Phase 1: Shortlist (fast, no deep checks)

Generate 20 candidates. Mix styles: short real words, 2-syllable compounds, invented but pronounceable, verb-able.
Constraints: under 10 chars ideally, easy to spell after hearing once, no hyphens or numbers, no generic AI slop (no -ly, -ify, -AI suffix unless it earns it).

Filter only the obvious using your own knowledge, no tool calls except at most one quick web_search if you suspect a famous collision:
- Drop names that are famous products or brands in any space (if a normal person hears it and thinks of the other product first, drop it).
- Drop names that only work with a desperate dodge (getX, Xhq, Xly, tryX).
- Group what remains by direction (e.g. playful vs plain vs invented) so choosing is easy.

Output a numbered list of 12-15 survivors with one-line flavor notes. Then STOP and ask me to pick 3-4 favorites plus any direction notes (e.g. "more like #4, less cute"). Do not run npm, gh, DNS, or trademark checks in Phase 1.

## Phase 2: Verify only my picks (thorough)

Only when I have picked names, check each pick:

1. npm: `npm view <name> version 2>&1 | head -5` — 404 means free on npm.
2. GitHub: `gh search repos <name> --match name --json fullName,stargazersCount -q '.[0:5]' 2>&1 | head -20` — exact-match repos with stars are collisions.
3. DNS (no whois on this box, use DoH): `curl -sm5 "https://dns.google/resolve?name=<name>.com&type=A"` and repeat for .ai .org .dev .app .io. `"Status": 3` means NXDOMAIN, likely unregistered. `"Status": 0` means taken.
4. Web: one web_search per pick for `"<name>" startup|app|trademark` to catch well-known usage and risk.

Then reason, do not just report DNS. Verdict per pick: Safe / Risky / Avoid.

TLD logic:
- .com taken by an active business in the same or adjacent space = Avoid, even if .ai is free.
- .com taken by an unrelated giant = Avoid anyway if the word is strongly associated. It feels desperate.
- .com parked or for-sale with no product = Risky, note the TLD you would actually use.
- .ai only for AI-native. .org only for open-source or community. .dev for devtools. .app for consumer/mobile. .io is dated unless the audience is infra nerds.
- Prefer a name where .com is free or parked over a clever name stuck on the 4th-choice TLD.

Output: table with Name | npm | GitHub | .com/.ai/.org/.dev/.app/.io | collision | Verdict + why. Then a ranked Top pick with the TLD to register and the exact commands to re-verify it.
