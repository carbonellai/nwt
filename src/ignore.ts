import fs from "node:fs";
import path from "node:path";

function scopePattern(pattern: string, prefix: string): string | null {
  const trimmed = pattern.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const neg = trimmed.startsWith("!");
  let body = neg ? trimmed.slice(1) : trimmed;
  if (!body) return null;
  if (body.startsWith("/")) {
    body = `${prefix}${body}`;
  } else if (body.includes("/")) {
    body = `${prefix}/${body}`;
  } else {
    body = `${prefix}/**/${body}`;
  }
  return (neg ? "!" : "") + body;
}

export function scopeGitignore(source: string, prefix: string): string[] {
  const out: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const scoped = scopePattern(line, prefix);
    if (scoped) out.push(scoped);
  }
  return out;
}

export function readIgnoreFiles(workTree: string): string {
  const chunks: string[] = [];
  const gitignore = path.join(workTree, ".gitignore");
  if (fs.existsSync(gitignore)) chunks.push(fs.readFileSync(gitignore, "utf8"));
  const exclude = path.join(workTree, ".git", "info", "exclude");
  if (fs.existsSync(exclude)) chunks.push(fs.readFileSync(exclude, "utf8"));
  return chunks.join("\n");
}

const MARK_START = "# >>> nwt-generated";
const MARK_END = "# <<< nwt-generated";

export function upsertIgnoreBlock(gitignoreText: string, blockBody: string): string {
  const block = `${MARK_START}\n${blockBody.trimEnd()}\n${MARK_END}\n`;
  if (gitignoreText.includes(MARK_START) && gitignoreText.includes(MARK_END)) {
    return gitignoreText.replace(
      new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}\\n?`),
      block,
    );
  }
  const trimmed = gitignoreText.trimEnd();
  return `${trimmed}${trimmed ? "\n\n" : ""}${block}`;
}

export function buildGeneratedIgnore(entries: { path: string; workTree: string }[]): string {
  const lines = [
    ".nwt/git/",
    ".nwt/manifest.json",
  ];
  for (const entry of entries) {
    lines.push(...scopeGitignore(readIgnoreFiles(entry.workTree), entry.path));
  }
  return `${lines.join("\n")}\n`;
}
