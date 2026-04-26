interface HeaderProps {
  roles: string[];
  onRoleChange: (roles: string[]) => void;
  onHome: () => void;
  onConflicts: () => void;
}

const ROLE_PROFILES: { id: string; label: string; roles: string[] }[] = [
  {
    id: "employee",
    label: "Employee",
    roles: ["employee:all"],
  },
  {
    id: "engineer",
    label: "Engineer",
    roles: ["employee:all", "role:engineering"],
  },
  {
    id: "cs",
    label: "CS Agent",
    roles: ["employee:all", "role:cs"],
  },
  {
    id: "sales",
    label: "Sales",
    roles: ["employee:all", "role:sales", "role:cs"],
  },
  {
    id: "hr",
    label: "HR",
    roles: ["employee:all", "role:hr"],
  },
  {
    id: "exec",
    label: "Executive",
    roles: [
      "employee:all",
      "role:hr",
      "role:exec",
      "role:cs",
      "role:sales",
      "role:engineering",
    ],
  },
];

function profileMatches(roles: string[], profileRoles: string[]): boolean {
  if (roles.length !== profileRoles.length) return false;
  return profileRoles.every((r) => roles.includes(r));
}

export function Header({
  roles,
  onRoleChange,
  onHome,
  onConflicts,
}: HeaderProps) {
  const current =
    ROLE_PROFILES.find((p) => profileMatches(roles, p.roles))?.id ?? "employee";

  return (
    <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <button
          onClick={onHome}
          className="flex items-center gap-2 text-left transition-opacity hover:opacity-80"
        >
          <div className="rounded bg-slate-900 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-white">
            spine
          </div>
          <span className="text-sm text-slate-500">Inspector</span>
        </button>

        <div className="flex items-center gap-4">
          <button
            onClick={onConflicts}
            className="text-sm font-medium text-slate-700 transition-colors hover:text-slate-900"
          >
            Conflicts
          </button>
          <span className="h-4 w-px bg-slate-300" />
          <label className="text-xs uppercase tracking-wider text-slate-500">
            Viewing as
          </label>
          <select
            value={current}
            onChange={(e) => {
              const profile = ROLE_PROFILES.find((p) => p.id === e.target.value);
              if (profile) onRoleChange(profile.roles);
            }}
            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium shadow-sm focus:border-slate-500 focus:outline-none"
          >
            {ROLE_PROFILES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-6 pb-2">
        <div className="text-xs text-slate-400">
          roles:{" "}
          <span className="mono text-slate-600">[{roles.join(", ")}]</span>
        </div>
      </div>
    </header>
  );
}

export { ROLE_PROFILES };
