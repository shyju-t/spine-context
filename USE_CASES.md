# Spine — Use Cases

Concrete real-life scenarios for the compiled context graph, grounded in the
Inazuma.co dataset. Each use case names: who's asking, what they query, what
Spine returns, and what changes vs the status quo.

---

## 1. Customer Service — disputes and promise audits

**Trigger**: customer ticket says *"Your rep Alice promised me 50% off on Jan 10."*

**Query** (CS Agent role): `query_entity("Acme Corp")` then drill into facts on
`promised_discount` and `approved_by`.

**Returns**:
- Promise fact: `promised_discount = 50%`, source `email/msg_9281` (Alice → CFO)
- Policy fact: `discount_policy = max 30% without CFO approval`, source `Inazuma.co Pricing Policy.pdf`
- Approval fact: `cfo_override = granted`, source `email/msg_9340`

**Today**: 15-minute hunt across Salesforce, Gmail, Slack, policy PDFs.
**With Spine**: 5 seconds, with click-through receipts the agent can paste back to the customer.

---

## 2. Executive briefing — Q2 status with disagreements surfaced

**Trigger**: Wednesday before the board meeting.

**Query** (Exec role): `search_context("Q2 status")`, drill into `topic/q2_launch`,
`project/phoenix_migration`, etc.

**Returns**:
- Trajectory facts: status changes over time
- **Conflicts surfaced as conflicts**: Engineering says Phoenix `status = shipped`
  (Apr 18 chat); Sales says `status = blocked on SSO` (Apr 22 email). Both shown side-by-side.

**Today**: 6 emails to 6 VPs, 6 incompatible narratives, hours reconciling.
**With Spine**: one screen, *with* the disagreement preserved (not flattened
into a single false answer). Exec knows exactly which 1:1 to schedule.

---

## 3. New-hire onboarding — "how do we do X here?"

**Trigger**: day-3 engineer asks *"how does auth work in the user service?"*

**Query** (Engineer role): `search_context("auth user service")` → routes to KB + Slack chat.

**Returns**:
- Procedural facts from `Inazuma_Overflow` Q&A posts
- `last_verified` date on each (catches stale knowledge)
- Author of each contribution (find the expert if you need one)

**Today**: ask 3 different seniors, get 3 different answers, 2 of them outdated.
**With Spine**: grounded answer with provenance + freshness signal. Stale
facts flagged.

---

## 4. HR / policy lookup with region & time scoping

**Trigger**: new parent-to-be: *"What's the parental leave policy for part-timers?"*

**Query** (Employee role): `query_entity("Inazuma.co Leave Policy")` or free-form search.

**Returns**:
- Exact clause from the policy PDF, with the source span highlighted
- Effective-date metadata so they know it's current

**Today**: email HR, wait, hope.
**With Spine**: definitive answer with the policy doc cited.

---

## 5. Compliance & audit — "what does our AI know about employee X?"

**Trigger**: GDPR data-subject access request, or audit by legal.

**Query** (Compliance role): `query_entity("person/emp_0431")` with full role privileges.

**Returns**:
- Every fact about that person — public, restricted, sensitive
- Audit log of every previous access (who saw what when)
- ACL chips on each fact show the privacy boundary

**Today**: pulling logs from 4 systems, manually compiling, hoping nothing was missed.
**With Spine**: single-pane view, exportable, defensible in a deposition.

---

## 6. Sales account hygiene

**Trigger**: account exec preparing for a Castillo Inc renewal call.

**Query** (Sales role): `query_entity("Castillo Inc")`.

**Returns**:
- Contract metadata (industry, monthly_revenue, contact)
- 90 days of email/chat mentions
- Open commitments: who promised what, by when
- Current sentiment signals
- Any unresolved conflicts (e.g., two reps committed different things)

**Today**: scattered across CRM notes, Slack, calendar comments.
**With Spine**: one view, source-linked.

---

## 7. Project timeline reconstruction

**Trigger**: engineer left, successor needs context.

**Query** (Engineer role): `query_entity("project/phoenix")`.

**Returns**:
- Timeline view: every status, owner change, blocker, decision in chronological order
- Each event clickable → opens the source email/chat with span highlighted
- Current state card: latest status + owner + blocker

**Today**: dig through Slack for the previous owner's messages, hope they archived their thinking.
**With Spine**: full project history is the entity page itself.

---

## 8. AI-agent power use — Claude / Cursor / custom apps via MCP

**Trigger**: anyone in the company asks Claude *"what's our refund policy for enterprise customers?"*

**Behind the scenes**: Claude calls `spine.search_context` over MCP. Spine
returns the policy fact with source. Claude paraphrases with the citation.

**Today**: Claude either hallucinates from training data or RAG-stuffs irrelevant chunks.
**With Spine**: every AI-given answer in the company is grounded in the same
compiled fact graph, with receipts. *AI tools across the company stop
disagreeing about basic company facts.*

---

## 9. Conflict resolution — data hygiene as a workflow

**Trigger**: Topic `team_restructure_strategy` has 3 different `owner` values
across 3 emails (real conflict in our current Inazuma graph).

**Query** (HR role): open the **Conflict Queue** in the Inspector.

**Returns**: 146 open conflicts. Pick the right value per conflict; the
override fact is now authoritative; history preserved.

**Today**: nobody resolves these. They live as confusion in everyone's head.
**With Spine**: a queue. A human-in-the-loop workflow. Resolved → audited → done.

---

## 10. Vendor & supplier intelligence

**Trigger**: procurement reviewing a vendor before contract renewal.

**Query** (Sales / Ops role): `query_entity("vendor/CLNT-0001")` (Castillo Inc).

**Returns**:
- Onboarding date, industry, business representative
- Every email + chat mentioning them across 12 months
- Open commitments and disputes
- Sentiment trajectory

**Today**: scattered across email, contract folder, vendor portal.
**With Spine**: one entity page.

---

## 11. Cross-team incident response

**Trigger**: a customer escalates *"my data is leaking somewhere"*.

**Query** (Engineering + Compliance roles): `search_context("<customer name>")`,
narrow to error/breach/leak attributes in the last 30 days.

**Returns**: every source touching that customer, with timestamps; any
commitments/decisions made; relevant policy facts.

**Today**: war-room scramble across 5 tools.
**With Spine**: structured incident timeline, instantly.

---

## 12. Internal Slack bot / onboarding agent

**Use case**: an internal Slack bot answers routine questions ("where do I file
an expense report?", "who's our security contact?") by calling Spine MCP.

**Today**: every team builds their own Q&A bot, indexes their own docs, gets out of sync.
**With Spine**: one MCP endpoint. Every internal bot asks Spine. The bot
maintains *no* knowledge — Spine is the brain, the bot is the interface.

---

## 13. M&A / due diligence

**Use case** (lower priority for the hackathon demo, real for buyers): an
acquirer asks *"who are our key people, what are our active commitments, what's
our customer sentiment?"*

**With Spine**: the buyer queries the seller's Spine (with negotiated ACL).
Months of due diligence become days.

---

## Demo Loom mapping

For the 2-minute Loom, the four highest-leverage use cases:

| Beat | Use case | Why it lands |
|---|---|---|
| 1 | **CS dispute** (#1) | Visceral, sub-10-second resolution with receipts |
| 2 | **Exec disagreement surfacing** (#2) | Counter to RAG: same prompt → fewer false single answers |
| 3 | **Conflict Queue** (#9) | Live human-in-the-loop, override stamps history |
| 4 | **MCP via Claude** (#8) | Architectural pitch: every AI tool plugs in via one endpoint |

ACL gating threads through all four — switching the role dropdown shows the
boundary on every screen.
