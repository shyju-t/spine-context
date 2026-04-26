/**
 * For each candidate hero entity, show fact-counts at three roles
 * so we can pick the entity with the smoothest ACL gradient (best
 * for the role-switch demo beat).
 */
const candidates = [
  "project/product_launch",
  "project/project_timelines_milestones",
  "topic/vendor_management_challenges",
  "topic/hr_policies_streamlining_proposal",
  "project/current_project_timelines",
  "topic/cross_departmental_collaboration",
  "topic/agile_methodologies",
];

const roles = ["employee:all", "role:exec", "role:hr", "role:exec,role:hr,employee:all"];

for (const entityId of candidates) {
  console.log(`\n${entityId}`);
  for (const role of roles) {
    const url = `http://localhost:3001/api/entity?q=${encodeURIComponent(entityId)}&as_role=${encodeURIComponent(role)}`;
    const res = await fetch(url);
    const data = await res.json();
    const n = data?.facts?.length ?? 0;
    console.log(`  ${role.padEnd(40)} → ${n} facts`);
  }
}
