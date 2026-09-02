import fs from "node:fs";
import path from "node:path";
import type { HostPaths } from "./paths";
import { nestedWorkTree } from "./relocate";
import type { Manifest } from "./types";

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function prefixGlobsInRuleFile(file: string, prefix: string): void {
  if (!file.endsWith(".mdc") && !file.endsWith(".md")) return;
  let text = fs.readFileSync(file, "utf8");
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontmatter) {
    const body = `---\nglobs: ${prefix}/**\n---\n${text}`;
    fs.writeFileSync(file, body);
    return;
  }
  let meta = frontmatter[1];
  if (/globs:\s*/.test(meta)) {
    meta = meta.replace(/globs:\s*([^\n]+)/, (_all, value: string) => {
      const trimmed = String(value).trim();
      if (trimmed.startsWith("[")) return `globs: ${trimmed}`;
      const items = trimmed
        .split(",")
        .map((item) => item.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean)
        .map((item) => `${prefix}/${item.replace(/^\//, "")}`);
      return `globs: ${items.join(", ")}`;
    });
  } else {
    meta = `${meta.trimEnd()}\nglobs: ${prefix}/**\n`;
  }
  text = `---\n${meta.trim()}\n---\n${text.slice(frontmatter[0].length)}`;
  fs.writeFileSync(file, text);
}

export async function applyRules(paths: HostPaths, manifest: Manifest): Promise<void> {
  const parentRules = path.join(paths.root, ".cursor", "rules");
  for (const entry of manifest.nested) {
    const nestedRoot = nestedWorkTree(paths.root, entry.path);
    const inherited = path.join(nestedRoot, ".cursor", "rules", "inherited");
    if (fs.existsSync(parentRules)) {
      if (fs.existsSync(inherited)) fs.rmSync(inherited, { recursive: true, force: true });
      copyDir(parentRules, inherited);
    }
    const nestedRules = path.join(nestedRoot, ".cursor", "rules");
    if (!fs.existsSync(nestedRules)) continue;
    for (const name of fs.readdirSync(nestedRules, { withFileTypes: true })) {
      if (name.name === "inherited") continue;
      const target = path.join(nestedRules, name.name);
      if (name.isFile()) prefixGlobsInRuleFile(target, entry.path);
    }
  }
}
