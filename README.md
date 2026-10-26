# Clueso

**An agent team that audits AI-built ("vibe-coded") websites before launch, proves every finding with evidence, writes the repair prompt for your coding agent, and tests new inspection tools learned from audit gaps.**

Built at The Recursive Agents Hackathon (Crusoe × Cerebral Valley, Oct 17 2026). Track: **Version N+1**, also covering **Done Means Done** and **Shared Brain**.

## What it checks
| Check | Evidence the Verifier reproduces |
|---|---|
| Third-party trackers that fire **before consent** | Network requests in a fresh browser with zero interaction |
| Vendors used but **not named in the privacy policy** | Policy re-read; a model disclosure claim must quote the policy verbatim or it is not trusted |
| **App Store / Google Play badges** stretched, recolored or rotated | Painted size vs artwork size, CSS filter/transform, re-measured at desktop and mobile widths |
| **Apple badge size and clear space** (review leads) | Measured height and nearest text/media gap against official guidance, including the constrained-advertising exception; element location in the preview |

It flags risks with evidence. It is not legal advice and it does not certify compliance.

## The agent team
```
Scanner (Playwright) ─► deterministic checks ─► Investigator (Nemotron, tool loop)
                    ─► Vision (Nemotron Super VL + official reference images)
                                              ─► Verifier (fresh browser, reproduces each claim)
                                              ─► Fix writer (repair prompt + acceptance checks)
Unresolved items ─► Learner (Nemotron + You.com research) ─► candidate brain ─► Promotion gate ─► shared brain vN+1
```
- **Shared brain** (`brain/versions/*.json`): vendor knowledge (domains, what they collect, consent needs, sources), brand rules, and executable **inspection probes**. Every audit pins one version.
- **Official visual checks:** You.com Search/Contents retrieves approved Apple and Google guidance. The host verifies that each reference image is linked by the official page, downloads it with redirect/host checks, records its hash and rasterizes it for comparison. Apple uses downloadable badge artwork; Google currently uses a publicly served badge example from its official page. Observed source bytes are compared where a probe identifies the image. Different bytes alone do not prove misuse.
- **Vision:** NVIDIA Nemotron 3.5 Super VL on Crusoe compares a labeled image containing the official reference, app badge crop, and page context. The service accepts one image per request. Visual suspicions remain unresolved review leads; they are never injected into confirmed repair instructions. The UI shows both images and reference provenance.
- **Done Means Done:** the controller owns step/token budgets and loop detection. A finding is reported only after the Verifier reproduces it. Anything it can't decide is reported as *unresolved*, never as "all clear".
- **Version N+1:** what the team could not decide becomes learning input:
  - unknown third-party domains → the Learner researches them with **You.com** and proposes a vendor entry (sources must be real search results);
  - badges no probe could measure → the Learner **writes a new probe** (JavaScript intended to inspect the page). Static checks reject recognizable network calls, page changes and app-specific selectors; they do not guarantee safe execution.
- **Promotion gate:** a candidate is kept only if, on development apps, it finds more real issues or leaves fewer unresolved items, with **no new false findings and no regressions**. Rejections are recorded with the reason and fed back to the Learner for a retry.
- **Checker contract:** nine additional development cases require correct painted-size measurements across nested HTML elements, contain/cover, percentage/px/auto sizing, padding and borders. Passing one app is insufficient.
- **Proof:** a frozen before/after on **held-out apps** the Learner never saw (`npm run eval`).

## Run it

The UI is a responsive inspection workspace: findings on the left, a captured website preview in the center, and selected evidence/official references with a copyable fix prompt on the right. It restores completed audits from recent history and keeps agent activity and the learning lab in expandable panels. The preview is saved evidence, not a live embedded website. New audits record geometry-backed finding markers; older reports without coordinates still show their screenshots and evidence.

```sh
npm install && npx playwright install chromium
cp .env.example .env   # add CRUSOE_INTELLIGENCE_API_KEY and YOU_API_KEY
npm run check-model    # confirms the model ID and tool calling
npm run ui             # http://localhost:4300 — landing page; /app — inspection workspace

npm run audit -- fixture:app-a        # or any URL you are authorised to audit
npm run audit -- https://zupapps.com/ # live public-site audit, with real network traffic
npm run learn                         # one learning cycle on the development apps
npm run eval                          # v0 vs current brain on held-out apps
npm run eval:fresh -- v0               # freeze current brain, generate separate test apps, verify transfer without inference
npm run demo                          # reset → learn → held-out eval
npm run brain                         # lineage and gate decisions (npm run brain -- reset)
npm run selftest                      # offline end-to-end test with scripted model output
```

To test a real site in the UI, paste its full `https://` URL into the URL field and select **Run audit**. Public sites use real browser requests; only the registered fixture apps use offline stubs. The scanner and verifier wait for DOM readiness with a bounded settling period so background media downloads do not hold up inspection.

### Fixture apps (`fixtures/`)
Four small sites with known, labeled issues. Only the built-in fixture server's registered app URLs use offline third-party stubs, so runs are deterministic. Other private/local targets are rejected by the audit pipeline; the separate inspection CLI supports explicit localhost opt-in. Badge artwork in the fixtures is a stand-in, not official art.
- Development (the Learner may use these): **Glowfit** (messy), **Brightbank** (clean control)
- Held-out (final evaluation only): **Pawtrail** (messy, different markup), **Leafnote** (clean control)

Labels live in `fixtures/labels.json` and are read only by `src/eval/score.ts`. No agent sees them.

## Limits (honest)
- Learned probes are intended to read the audited page, with static code checks and a timeout. Those checks do not enforce read-only execution or provide a container sandbox; production use needs isolated execution (OpenShell is the planned path).
- Official visual comparison currently covers English Apple App Store and Google Play badge references. Other brands/variants stay outside this comparison scope. Vision judgments can be wrong; confirmed findings still require browser reproduction.
- Fixture apps are small and few; the held-out result is an illustration of transfer, not a benchmark.
- Vendor knowledge is only as good as the search results it cites; every entry keeps its source URLs.

### Verified learning result

Version `v1` contains a background-artwork checker generated by live Nemotron, not a handwritten checker. It passed all nine development measurement cases. After freezing it, `eval:fresh` generated a separate distorted-badge app and a clean control: the seed brain missed the distortion, the learned checker found and independently reproduced it, and neither version flagged the clean control. Evaluation used zero model calls. Evidence is in `data/fresh-transfer.json`.

The original app-b/app-d fixtures now serve as regression cases: v0 finds 1/4 labeled issues and v1 finds 4/4 with zero false findings. These tiny synthetic examples are not a real-world accuracy benchmark. The test sites use stand-in artwork; official-source visual checks are tested separately with live provider calls.

## Code map
| Path | Role |
|---|---|
| `src/scan/scanner.ts` | Playwright scan: requests before/after consent, probes, store links, policy text, screenshots |
| `src/checks/checks.ts` | Candidate findings and unresolved items from the shared brain |
| `src/agents/` | Controller, Investigator, Verifier, Fix writer |
| `src/learn/` | Learner (vendor research, probe synthesis), promotion gate, You.com search |
| `src/eval/` | Labeled scoring and held-out transfer report |
| `src/brain/` | Versioned shared brain and seed v0 |
| `src/server.ts`, `src/ui/` | Live UI (server-sent events) |
| `src/providers/`, `src/tools/`, `src/agent.ts`, `src/cli.ts` | Integration layer: Crusoe/You.com clients, smoke tests, inspection tools (below) |

## Integration layer (Crusoe, You.com, tools)

### Local configuration

Requires Node.js 22.18 or newer. A local `.env` is already provided and is ignored by Git. Add the values for `CRUSOE_INTELLIGENCE_API_KEY` and `YOU_API_KEY` there; keep credentials out of chat, screenshots, and source code. For a fresh checkout, copy `.env.example` to `.env`.

`CRUSOE_API_KEY` is also accepted for compatibility. If both are populated, `CRUSOE_INTELLIGENCE_API_KEY` takes precedence. Cloud access/secret key pairs manage infrastructure and are not used or sent by the inference client. The Intelligence API key is already the inference credential; no derived key is required.

`CRUSOE_MODEL` is configurable. Confirm the exact ID returned for your account with `npm run models`; native tool calling is verified separately by `npm run agent:smoke`.

Install dependencies and the browser:

```sh
npm install
npm run browser:install
```

### Integration checks

```sh
# Offline: reports configured/missing keys without printing values.
npm run doctor

# Live, billable provider requests; run after configuring keys.
npm run models
npm run smoke:crusoe
npm run smoke:you
npm run agent:smoke

# Local mocked provider tests plus a real Chromium fixture test.
npm test
npm run typecheck
```

Provider smoke tests check real responses. `doctor` checks configuration only and never claims the APIs are live. Before agent execution, `/models` must advertise `tools` support. The agent smoke then verifies a native model tool call, the matching tool response, and the model's final answer.

### Use the tools

```sh
npm run search -- Instagram official brand assets guidelines
npm run contents -- https://www.meta.com/brand/resources/instagram/instagram-brand/

# Inspect an owner-authorized site. Produces observations, not confirmed findings.
npm run inspect -- https://example.com
npm run inspect -- https://example.com --mobile

# Explicit loopback opt-in for your own local preview only.
npm run inspect -- http://localhost:3000 --allow-localhost

# Download an image from a manually approved reference host.
# Replace the example with an asset URL actually linked by an official page.
npm run asset -- https://brand.example/assets/logo.svg brand.example
```

Artifacts are written under `ARTIFACT_ROOT` (default `./artifacts`) and excluded from Git. The asset fetcher records its URL, redirects, retrieval time, SHA-256, MIME type, and byte count. Every redirect host must also be explicitly approved. Asset authority remains `unreviewed`: a successful download does not establish that the source is official or its use permitted. SVG files are stored as data, not injected into a web page.

The browser collects image/SVG references, CSS backgrounds and masks, ancestor transformations, geometry, links, controls, a short keyboard-focus trace, and a viewport screenshot. It blocks non-read HTTP methods and WebSockets. Some applications require those requests to render; blocked requests are reported as coverage limitations. It does not click buttons, submit forms, or execute generated code.

### Tools exposed to Nemotron

| Tool | Scope |
| --- | --- |
| `integration_status` | Configuration booleans only |
| `search_references` | You.com public web search; results are untrusted leads |
| `read_reference_pages` | You.com Contents restricted to owner-approved hosts |
| `fetch_reference_asset` | Bounded reference download and hash, approved hosts only |
| `inspect_page` | Browser observations for owner-authorized target origins |
| `read_source_file` | Bounded code reads within an explicitly authorized source root |
| `search_source` | Bounded literal search within that source root |

The host chooses permitted tools, target origins, source root, and reference hosts. Model-generated arguments cannot grant new permissions. Unknown tools and extra arguments are rejected. The loop has model-call, tool-call, and tool-result limits.

### Current boundaries

Provider keys remain in the host process. HTTP errors do not print response bodies, request headers, or exception stacks. Retries are limited to explicit 429/503 responses, using bounded exponential backoff with jitter or the provider's Retry-After value; uncertain network POST failures are not automatically replayed. Usage, request timing, and the four documented Crusoe rate-limit headers are available to the host. The integration follows the linked Crusoe hackathon skill; exact model capabilities still require live account verification.

Source tools exclude hidden files, dependencies, binaries, and symlinks escaping the authorized root. They are read-only. This does not guarantee that user-written source contains no secrets; approve the source scope accordingly before sending it to inference.

URL guards reject private addresses and inspect redirects where controlled by our fetcher. DNS validation is not connection-level IP pinning, and browser runtime network restrictions are not a container boundary. You.com may follow redirects in its own crawler. Production use still requires the restricted worker/network isolation described in the system design. This foundation is intended for authorized development targets.

### Provider references

- [Crusoe available models](https://docs.crusoecloud.com/serverless-inference/available-models/)
- [Crusoe hackathon API guide](https://github.com/crusoecloud/crusoe-developer-hub/blob/main/examples/hackathons/crusoe-cv-recursive-agents-hackathon/crusoe-cv-recursive-agents-hackathon-skill.md)
- [You.com Search](https://you.com/docs/guides/search)
- [You.com Contents](https://you.com/docs/guides/contents)
- [Playwright browsers](https://playwright.dev/docs/browsers)

### Inspection workspace UI

The light workspace keeps findings, captured website evidence, and official references together. Use **Commands** or **⌘/Ctrl K** to search workspace actions. Six Libraries.dev bot avatars reflect live agent activity; thinking orbs, a form border beam, and CSS text shimmer appear during actual work. Motion respects reduced-motion preferences and pauses when the page is hidden.

`npm run ui` builds the small React effects bundle automatically with esbuild. Run `npm run build:ui` to rebuild it independently. The generated `src/ui/vendor-effects.js` is ignored; source lives in `src/ui/effects.tsx`. The rest of the workspace stays in the existing browser UI.

Framer Motion drives workspace entrances, dynamic evidence and findings, dialogs, button hover/press feedback, and agent activity transitions. The existing DOM renderer uses Motion’s animation API; React islands use motion components and AnimatePresence. Reduced-motion settings disable movement, and hidden pages settle pending transitions.

Navigation uses separate Inspection, Evidence, Learning, and Activity views. Tabs support arrow keys, Home/End, URL deep links via `?view=`, and browser back/forward. Inspection and Evidence share the same selected finding without duplicating report state.

The header theme toggle switches between pearl glass and dark indigo glass. The theme persists locally across reloads. Libraries.dev Border Beam remains visible around the audit input at idle and brightens on focus and during an audit, uses the active theme, and respects reduced-motion and hidden-page settings. Captured website and official-reference images keep their original colors.

### Real website examples

The audit workspace defaults to [Zup](https://zupapps.com/), with [Mojo](https://mojo-app.com/), [Captions](https://captions.ai/), and [Ripl](https://www.ripl.com/) as additional public examples. These official landing pages were checked on October 17, 2026; they offer captioning, social content creation, or related publishing tools. Selecting an example fills the URL; the user starts the audit. Inclusion does not imply a compliance issue or a passing result.

Synthetic Glowfit, Brightbank, Pawtrail, and Leafnote fixtures remain available to the CLI, tests, and controlled learning comparisons. The example picker does not present those benchmark results as measurements of these real websites.

### Real-site learning experiment

`npm run learn:real` learns vendor recognition from Zup, freezes a candidate and its SHA-256, then inspects Mojo, Captions, and Ripl. Both versions classify the same captured request set. Any new recognition must recur in another fresh browser context. No inference is used during transfer and no candidate is automatically promoted. Results are saved to `data/real-learning-latest.json`; the Learning Lab shows them separately from controlled synthetic benchmark scores.

The first real run reproduced learned Cloudflare Web Analytics recognition on Captions. Zup had no unmeasured store-badge gap, so it did not produce a new executable checker. Vendor recognition does not establish a consent or disclosure violation; the candidate's policy assumptions are unvalidated. Real sites have no complete ground-truth issue labels, so this workflow does not report recall or false-positive rates.


### Brand layout and executable checker learning

Apple badge height and clear-space measurements now run during capture, before consent interaction. They use [Apple’s official guidance](https://developer.apple.com/app-store/marketing/guidelines/). Measurements produce review leads with dimensions, source and preview location. DOM spacing is an estimate; masks, transparent margins and complex layouts can require manual review. These rules are implemented by the maintainer, not learned by the agents. Owner design tokens, complete sign-in component validation and visual accessibility remain outside this implementation.

`npm run learn:checker` asks Nemotron 3.5 Super VL through Crusoe (overridable with `CRUSOE_CHECKER_MODEL`) to generate a new SVG inspection tool from a real unsupported badge on Biuty. Each proposal must pass twelve fixed development cases and an independent geometry oracle. The candidate is frozen before preselected real holdouts are opened. Transfer compares the same captured page before and after adding the tool, then repeats new measurements in a fresh browser context, with inference disabled. Only a successful transfer plus regression checks can retain the exact frozen code. Failed attempts leave the active brain unchanged. Results and source are saved in `data/real-checker/` and shown in the Learning Lab. This measures new inspection coverage, not legal compliance accuracy.


### Reproduced real-site checker transfer — v2 → v3

The retained `svg-artwork` probe was generated by Nemotron 3.5 Super VL from Biuty’s unsupported SVG badges. It passed twelve geometry cases plus scope controls. The frozen candidate then produced **six new, independently reproduced measurements on Mojo**, reducing unmeasured store links from 7 to 1. Captions and Ripl produced no additional SVG measurements. Transfer used zero model calls. Development regression checks retained all six existing true findings, with zero false findings in either version. The candidate was retained as **v3** on October 17, 2026.

Evidence: `data/real-checker/checker-2026-10-17T23-36-08-002Z/result.json`, `freeze.json`, the generated `candidate.json`, and each holdout’s paired browser evidence. These are measurements of inspection coverage, not six new violations or a compliance-accuracy score. Earlier failed attempts remain recorded and were never promoted.
