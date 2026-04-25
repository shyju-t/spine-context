/**
 * Curate a small set of demo-ready entities. For each top-ranked
 * candidate, we compute:
 *   - per-role fact counts (employee/cs/engineer/hr/exec)
 *   - author mix (gemini vs pioneer)
 *   - source-type spread
 *   - conflict-prone attributes present
 *
 * Output is a markdown table the user can scan during the Loom and
 * pick a different entity per beat (timeline beat, ACL beat, conflict
 * beat, multi-silo beat).
 *
 * Hits the live API so we don't need to bounce the server.
 */

const BASE = "http://localhost:3001";

// Top 30 from rank-demo-entities — re-pasted so this is self-contained.
// Pulled from our last ranker run; all are scored above 60.
const candidates = [
  "project/product_launch",
  "project/project_timelines_milestones",
  "topic/vendor_management_challenges",
  "topic/hr_policies_streamlining_proposal",
  "project/current_project_timelines",
  "topic/cross_departmental_collaboration",
  "topic/agile_methodologies",
  "topic/CI_CD_pipeline",
  "topic/testing_qa_process",
  "topic/product_launches_updates",
  "topic/performance_review_outcomes_informing_engagement_programs",
  "topic/continuous_integration_pipeline",
  "topic/employee_engagement",
  "topic/digital_transformation",
  "topic/customer_satisfaction",
  "topic/operational_efficiency",
  "topic/budget_allocation",
  "topic/training_programs",
];

const ROLES = {
  employee: ["employee:all"],
  engineer: ["role:engineer", "employee:all"],
  cs: ["role:cs", "employee:all"],
  hr: ["role:hr", "employee:all"],
  exec: ["role:exec"],
  all: ["role:exec", "role:hr", "role:cs", "role:engineer", "employee:all"],
};

const ALL_ROLES_PARAM = ROLES.all.join(",");

async function fetchEntity(entityId, asRole) {
  const url = `${BASE}/api/entity?q=${encodeURIComponent(entityId)}&as_role=${encodeURIComponent(asRole.join(","))}`;
  const res = await fetch(url);
  return res.ok ? res.json() : null;
}

function authorOf(f) {
  const a = f.author || "";
  if (a.includes("pioneer")) return "pioneer";
  if (a.includes("gemini")) return "gemini";
  if (a.includes("hr-adapter")) return "hr-adapter";
  return "other";
}

function summariseAuthors(facts) {
  const out = { gemini: 0, pioneer: 0, "hr-adapter": 0, other: 0 };
  for (const f of facts) out[authorOf(f)]++;
  return out;
}

function summariseSources(facts) {
  const out = new Map();
  for (const f of facts) {
    const t = f.source_type || (f.source_id?.split("/")[0] ?? "?");
    out.set(t, (out.get(t) ?? 0) + 1);
  }
  return out;
}

const CONFLICT_ATTRS = new Set([
  "status",
  "state",
  "current_state",
  "current_status",
  "owner",
  "current_owner",
  "due_date",
  "deadline",
  "blocker",
  "blocked_by",
]);

function summariseConflicts(facts) {
  const byAttr = new Map();
  for (const f of facts) {
    const a = (f.attribute || "").toLowerCase();
    if (!CONFLICT_ATTRS.has(a)) continue;
    if (!byAttr.has(a)) byAttr.set(a, new Set());
    byAttr.get(a).add(f.value);
  }
  const conflicting = [];
  for (const [a, vs] of byAttr) {
    if (vs.size >= 2) conflicting.push(a);
  }
  return conflicting;
}

console.log("Computing per-role and per-author breakdowns for", candidates.length, "candidates...\n");

const rows = [];
for (const id of candidates) {
  // Use the all-roles call for the canonical entity + full fact set.
  const fullData = await fetchEntity(id, ROLES.all);
  if (!fullData?.facts) {
    console.log(`  skipped ${id} — no entity match`);
    continue;
  }
  const total = fullData.facts.length;
  if (total === 0) continue;

  // Per-role counts.
  const perRole = {};
  for (const [name, roleList] of Object.entries(ROLES)) {
    if (name === "all") continue;
    const d = await fetchEntity(id, roleList);
    perRole[name] = d?.facts?.length ?? 0;
  }

  rows.push({
    id,
    total,
    perRole,
    authors: summariseAuthors(fullData.facts),
    sources: summariseSources(fullData.facts),
    conflicts: summariseConflicts(fullData.facts),
  });
}

// Score for "demo-ready":
//   - more facts is good (saturate at 200)
//   - smooth role gradient is great (penalise binary 0/N profiles)
//   - both extractors visible is great
//   - multi-silo (chat AND email) is great
//   - conflict attributes present
function gradientScore(perRole) {
  const vals = Object.values(perRole).filter((v) => v > 0);
  if (vals.length <= 1) return 0; // binary
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  // Smoother gradient = min/max closer to 1; reward variety
  return Math.round(20 * (vals.length / 5) * (1 - min / max + 0.5));
}

for (const r of rows) {
  let score = 0;
  score += Math.min(r.total, 200) / 4; // saturate
  score += gradientScore(r.perRole);
  score += r.authors.pioneer >= 3 && r.authors.gemini >= 5 ? 25 : 0;
  score += r.sources.size >= 2 ? 20 : 0;
  score += r.conflicts.length * 8;
  r.score = Math.round(score);
}

rows.sort((a, b) => b.score - a.score);

// Render markdown table.
console.log("# Demo-ready entities\n");
console.log("| Score | Entity | Total | emp | eng | cs | hr | exec | Authors | Sources | Conflicts |");
console.log("|-------|--------|-------|-----|-----|----|----|------|---------|---------|-----------|");
for (const r of rows) {
  const auth = `g${r.authors.gemini}/p${r.authors.pioneer}` + (r.authors["hr-adapter"] ? `/hr${r.authors["hr-adapter"]}` : "");
  const srcs = [...r.sources].map(([t, c]) => `${t}:${c}`).join(",");
  const confs = r.conflicts.length ? r.conflicts.join(",") : "—";
  console.log(
    `| ${r.score} | \`${r.id}\` | ${r.total} | ${r.perRole.employee} | ${r.perRole.engineer} | ${r.perRole.cs} | ${r.perRole.hr} | ${r.perRole.exec} | ${auth} | ${srcs} | ${confs} |`,
  );
}

console.log("\n## Suggested demo lineup\n");

const withGradient = rows.filter((r) => {
  const vs = Object.values(r.perRole).filter((v) => v > 0);
  return vs.length >= 3;
});
const binary = rows.filter((r) => r.perRole.exec > 100 && r.perRole.employee === 0);
const dualExtractor = rows.filter(
  (r) => r.authors.gemini >= 5 && r.authors.pioneer >= 3,
);
const multiSilo = rows.filter((r) => r.sources.size >= 2);
const richConflict = rows.filter((r) => r.conflicts.length >= 3);

const pick = (label, list) => {
  if (list.length === 0) return null;
  console.log(`- **${label}**: \`${list[0].id}\` (${list[0].total} facts)`);
  return list[0].id;
};

pick("Hero — depth + multi-silo + conflicts", multiSilo.length ? multiSilo.filter(r => r.conflicts.length >= 3) : richConflict);
pick("ACL gradient (smooth, all roles see different counts)", withGradient);
pick("ACL punchline (binary — exec sees, employee blocked)", binary);
pick("Both extractors visible", dualExtractor);
pick("Conflict-rich (queue beat)", richConflict);
