# ai-docs/web-acp/ — doc-tree orientation

This folder is the **documentation home** for the web-acp initiative. It is
not source code. Every file here either defines a contract (specs, steering),
describes intent (plans, milestones, prompts), records a divergence
(web-acp-vs-standard-acp), or captures a review result (reviews).

## Tree

```
ai-docs/web-acp/
├── steering/          DURABLE — edit in place when the north star shifts.
│   ├── 00-vision.md         One-line + rationale. Edit when goals change.
│   ├── 01-goals.md          Capability checklist. Edit when scope changes.
│   ├── 02-architecture.md   Layer cake, transport boundary, ZenFS layout.
│   ├── 04-principles.md     The rules that survive plans.
│   └── …
├── specs/             LIVING — source-of-truth contracts per package.
│   ├── web-acp-agent/       One file per concern (acp.md, extensions.md, …)
│   └── web-acp-client/      One file per concern.
├── milestones/        STATUS BOARD — index.md is canonical; per-milestone files.
├── plans/             PER-MILESTONE PLANS — written before the work, archived after.
├── prompts/           AI BRIEFINGS — per-phase prompts, archived for posterity.
├── reviews/           /review OUTPUT — one subfolder per ref (created by /review).
└── web-acp-vs-standard-acp/  DIVERGENCE REGISTER — one file per divergence snapshot.
```

## Rules

**Steering is durable.** `steering/*.md` files are edited in place when
the goals or architecture genuinely shift. Don't create alternate steering
docs — update the existing ones and note the change in a commit message.

**Specs are source-of-truth.** Files in `specs/web-acp-agent/` and
`specs/web-acp-client/` MUST be updated in the same commit as the matching
source change. The change-procedure rule in
`specs/web-acp-agent/index.md` and `specs/web-acp-client/index.md` is
mandatory, not optional. Reviewer agents flag spec drift as a finding.

**Decisions are append-only.** If a design decision is permanent
(e.g. "we chose agent-owned FS"), it goes in `web-acp-vs-standard-acp/`
or in a `decisions/` entry (shared with web-agent history). Never overwrite
a decision — add a dated follow-up.

**Milestones not completed are previews.** Per-milestone files describe
intent and sequencing, not implementation detail. They are updated when the
milestone ships (converting from "planned" to "shipped history").

**Divergences are documented.** Any place where web-acp consciously departs
from the canonical ACP posture gets an entry in `web-acp-vs-standard-acp/`.
Reviewer agents read this folder before flagging ACP compliance findings.

## What NOT to write here

- Per-session scratch notes → write them in `plans/` or commit messages.
- Running commentary or "here's what I tried" journals → commit messages
  or PR descriptions; they rot in docs.
- Implementation detail that belongs in source comments → keep it in source.
- Duplicate copies of steering content → update the original.
