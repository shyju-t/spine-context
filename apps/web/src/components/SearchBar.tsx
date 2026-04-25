import { useState } from "react";

interface SearchBarProps {
  initial?: string;
  onSearch: (q: string) => void;
}

export function SearchBar({ initial, onSearch }: SearchBarProps) {
  const [q, setQ] = useState(initial ?? "");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = q.trim();
        if (trimmed) onSearch(trimmed);
      }}
      className="flex w-full items-center gap-2"
    >
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search a person, customer, topic, or just type something..."
        className="flex-1 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-base shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-300"
      />
      <button
        type="submit"
        className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-800"
      >
        Search
      </button>
    </form>
  );
}
