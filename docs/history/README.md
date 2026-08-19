# History — what used to be here, and where it went

Seven documents lived in this directory: the original build spec, the original
concept, the UX overhaul draft, and four worker briefs (chat, rooms, mobile,
compliance) that agents were given to build those modules from. **They were
removed on 2026-08-19.** Nothing is lost — every one is in git history, and the
recovery command is at the bottom.

## Why they went

Each file already carried a header saying, in its own words, *do not build from
this file*, followed by a list of what in it was dead. Those headers were doing
the work of a tombstone, and they were the only durable content in 1,845 lines.
The bodies were the liability:

- **They are written in the imperative** — "you are implementing", "OWN
  (create)", "BUILD" — because they were agent prompts. Prose written as a
  standing order does not stop reading as one just because a banner above it
  says otherwise.
- **Parts of them do not compile against this tree**, and their own headers said
  so. `COMPLIANCE_K3_BRIEF` named two instructions that "would not even
  compile"; `MOBILE_K3_BRIEF` cited a BINDING path
  (`/Users/mg/Desktop/playin/BUILD_PROMPT.md`) that does not exist.
- **Parts of them describe deleted products.** `BUILD_PROMPT` specified plans,
  a premium relay tier, Stripe checkout and an entitlements service; `CONCEPT`
  specified LiveKit, self-hosted coturn, and an uploads → ffmpeg → HLS media
  service. All of it is gone, and four tombstone suites fail if any of it comes
  back (`services/api/test/no-billing.test.ts`,
  `services/api/test/rooms-ungated.test.ts`,
  `packages/contracts/test/no-billing.test.ts`,
  `apps/web/test/no-paywall.test.ts`).
- **What was worth keeping was already copied somewhere binding.**
  `UX_OVERHAUL`'s locked decisions and the ≤3-step budget are `DESIGN.md`
  §11–12; the briefs' architectural reasoning is in the module headers of the
  code they produced (`services/api/src/modules/chat/service.ts` documents both
  seq scopes, `services/api/src/adapters/ports.ts` pins the scope convention,
  every chat module file carries its own what-it-owns header).

The one thing they genuinely recorded that the code does not — *why* a module
has the shape it does — is what those headers said, and it is preserved above
and in the code's own comments.

## What each one was

| File | What it was | Where its surviving content lives |
|---|---|---|
| `BUILD_PROMPT.md` | The original whole-product build spec | The code; `README.md` for the shape of the workspace |
| `CONCEPT.md` | Original concept + feasibility matrix. The two-mode insight survives | `docs/EXTENSION_FIRST.md`, `docs/CONTENT_MATCHING.md` |
| `UX_OVERHAUL.md` | The redesign draft; executed | `DESIGN.md` §11–12 (the binding copy) |
| `CHAT_K3_BRIEF.md` | Worker brief for the chat module | `services/api/src/modules/chat/*` file headers |
| `ROOMS_K3_BRIEF.md` | Worker brief for the rooms realtime half | `services/api/src/modules/rooms/*` file headers |
| `MOBILE_K3_BRIEF.md` | Worker brief for the Expo app | `apps/mobile/README.md` |
| `COMPLIANCE_K3_BRIEF.md` | Worker brief for the compliance module | `services/api/src/modules/compliance/*` file headers |

## Recovering one

They were last modified in `734c54e` and `439f7e8`. Either of these works:

```bash
git show 734c54e:docs/history/BUILD_PROMPT.md
```

```bash
git log --diff-filter=D --name-only -- 'docs/history/*.md'
```

If you recover one, read its header first. It tells you what in the body is
already dead, and that list is the reason the file is not in the tree.
