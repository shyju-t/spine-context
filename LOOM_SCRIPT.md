# Spine — 2-minute Loom script

Target: 2:00 ± 5s. Word budget ~290 (150 wpm conversational).
Structure: 5 beats — problem (10s), framing (20s), hero (30s), ACL
punchline (25s), MCP (25s), close (10s).

The cuts between beats should be hard — no transitional fluff.
Treat each beat as if it's a tweet you're showing the camera.

---

## Beat 1 — Problem (0:00–0:10)

**On screen:** plain title card or just the Inspector landing page
loading.

> Every company's data lives in seven places at once — emails,
> chats, tickets, sales records, reviews. AI agents see fragments.
> They can't operate on the company's actual state.

---

## Beat 2 — What it is (0:10–0:30)

**On screen:** Inspector landing page. Camera focuses on the
StatsStrip and SourceBreakdown row.

> Spine is the compiled state of your company. We pulled thirty-three
> thousand sources from EnterpriseBench — emails, chats, KB articles,
> sales, reviews, tickets — and turned them into one hundred thousand
> typed facts in a graph. Every fact links back to the exact sentence
> that produced it.

**Visual cue:** hover over a couple of source-type chips so the count
tooltips are readable (Sales 13.5k, Reviews 13.5k, Emails 1k, etc.).

---

## Beat 3 — The hero (0:30–1:00)

**On screen:** search bar → type `product launch` → land on the
entity page.

> Watch. I search for the product launch project. Spine shows me the
> current state — owner, status, blocker, due date — synthesized
> from 600+ facts across chats and emails.

**Visual cue:** point cursor at the CurrentState card. Click any
status value; the source viewer opens with the span highlighted.

> Each value links back to the exact source span. Timeline view —
> this project went from "on track" to "encountering hurdles" to
> "resolved". Two sources disagreed on the launch date.

**Visual cue:** open Conflict Queue tab. The product_launch entry is
visible. Click "this one is correct" on one fact.

> Spine flagged it. I resolve it. The override is itself a fact with
> audit trail.

---

## Beat 4 — ACL punchline (1:00–1:25)

**On screen:** still on the product_launch page. Camera on the role
switcher in the header.

> Now the differentiator. I switch role from Executive to Employee.

**Visual cue:** click the role dropdown, pick "Employee". The page
goes from 610 facts to 0. The redaction banner appears.

> The page goes from six hundred and ten facts to zero. This entire
> project is invisible to non-execs by design. AI agents acting in
> any role see exactly what that role should see — same compiled
> state, role-shaped views.

**Visual cue:** flip role to HR briefly — a different shape appears
(or stays empty here; if you want a smoother gradient beat, search
`hr policies` instead and walk Employee → HR → Exec).

---

## Beat 5 — MCP (1:25–1:50)

**On screen:** alt-tab to Claude Desktop. Fresh chat.

> Same data, exposed to AI agents over MCP. Here's Claude Desktop
> calling Spine.

**Visual cue:** type the prompt:

```
Use the Spine MCP to give me a status briefing on product_launch — 
status, owner, blocker, due date. Acting as role:exec.
```

> Compiled answer with citations. Switch the role tag —

**Visual cue:** type a follow-up:

```
Same question, but as employee:all only.
```

> — different answer. Two surfaces, identical ACL.

---

## Beat 6 — Close (1:50–2:00)

**On screen:** back to the Spine Inspector landing page, OR title
card with the Cloud Run URL.

> Spine. Turn fragmented company data into a context base AI can
> operate on. Built solo for Big Berlin Hack — Qontext track.

---

## Pre-record checklist

- [ ] Spine API + Inspector are running (`curl /api/health` is 200)
- [ ] Browser tabs: Inspector at `/`, Conflict Queue ready in second tab
- [ ] Claude Desktop is running with `spine` MCP server visible in
      bottom-right (the small wrench icon)
- [ ] Role switcher defaults to Executive — flips down cleanly
- [ ] Cursor highlight enabled in Loom (so the audience can follow)
- [ ] Audio: external mic if possible; quiet room
- [ ] Webcam off (the demo is the demo, not your face)
- [ ] One dry run before the real take — find the rhythm

## Common slip-ups to avoid

- Don't read the script verbatim. Use it as a rail; talk to the
  audience.
- Don't drift into architecture ("we used Kuzu and Hono and...").
  Architecture is in the README. The Loom is the user-visible story.
- Don't apologise for missing pieces. Skip them.
- If a click misfires, just keep going — Loom edits are easy.
- 2 minutes is **shorter than you think**. Practice once with a
  stopwatch before recording.
