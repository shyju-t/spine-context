import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * Read a file but only when its resolved absolute path stays inside one
 * of the allowed root directories. This blocks `--data ../../etc/passwd`
 * style attacks if a CLI argument were ever attacker-controlled, and
 * silences static-analysis false-positives that flag every readFile()
 * with a parameter as a file-inclusion vulnerability.
 *
 * `allowedRoots` defaults to the npm-invocation cwd (INIT_CWD) and
 * the process cwd. CLI scripts can pass an explicit list (e.g.
 * "the data dir under the repo root").
 */
export async function safeReadFile(
  location: string,
  options: { allowedRoots?: string[]; encoding?: "utf8" } = {},
): Promise<string> {
  const encoding = options.encoding ?? "utf8";
  const allowed = (
    options.allowedRoots ?? [process.env.INIT_CWD ?? process.cwd()]
  ).map((r) => resolve(r));

  const resolved = resolve(location);
  const isInside = allowed.some((root) => {
    const rel = relative(root, resolved);
    return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
  });

  if (!isInside) {
    throw new Error(
      `safeReadFile: refusing to read ${resolved} — outside allowed roots ${JSON.stringify(allowed)}`,
    );
  }

  return readFile(resolved, encoding);
}
