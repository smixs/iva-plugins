/**
 * The check a pull request to this list has to pass: `node scripts/check.ts`.
 *
 * It reads the two files of the list and the plugin folders that live here, and prints every
 * problem it finds. No dependencies, no network: a plugin that lives in somebody else's
 * repository is checked by its entry alone, and its code is read by the reviewer at the pinned
 * commit.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const problems: string[] = [];
const problem = (where: string, what: string) => problems.push(`${where}: ${what}`);

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function readJson(path: string): Json {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, path), "utf8"));
    if (isRecord(parsed)) return parsed;
    problem(path, "must be a JSON object");
  } catch (error) {
    problem(path, error instanceof Error ? error.message : String(error));
  }
  return {};
}

const NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const SHA = /^[a-f0-9]{40}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ENV = /^[A-Z][A-Z0-9_]*$/u;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u;
const REPOSITORY = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\/tree\/[\w./-]+)?$/u;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const DESCRIPTION_MAX = 140;
const SKILL_DESCRIPTION_MAX = 120;

/** No symlinks anywhere in a plugin folder: Iva refuses such a folder at install. */
function noSymlinks(folder: string, where: string): void {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (lstatSync(path).isSymbolicLink()) problem(where, `symlink ${path.slice(root.length + 1)}`);
    else if (entry.isDirectory()) noSymlinks(path, where);
  }
}

/** A plugin folder of this repository: the manifest names it, its skills fit the prompt index. */
function checkLocal(name: string, path: string): void {
  const where = `plugin ${name}`;
  const folder = join(root, path);
  if (!existsSync(join(folder, "plugin.json"))) return problem(where, `no ${path}/plugin.json`);
  const manifest = readJson(join(path, "plugin.json"));
  if (text(manifest.name) !== name)
    problem(where, `plugin.json names it ${JSON.stringify(manifest.name)}`);
  if (!text(manifest.version)) problem(where, "plugin.json has no version");
  if (!existsSync(join(folder, "README.md"))) problem(where, "no README.md");
  noSymlinks(folder, where);
  const skills = join(folder, "skills");
  if (!existsSync(skills)) return;
  for (const skill of readdirSync(skills, { withFileTypes: true })) {
    if (!skill.isDirectory()) continue;
    const file = join(skills, skill.name, "SKILL.md");
    if (!existsSync(file)) {
      problem(where, `skills/${skill.name} has no SKILL.md`);
      continue;
    }
    const declared = /^description:\s*(.*)$/mu.exec(readFileSync(file, "utf8"))?.[1] ?? "";
    const description = declared.trim().replace(/^(["'])(.*)\1$/u, "$2");
    if (!description) problem(where, `skill ${skill.name} has no description`);
    else if (description.length > SKILL_DESCRIPTION_MAX)
      problem(
        where,
        `skill ${skill.name} description is ${description.length} UTF-16 units, the prompt index keeps ${SKILL_DESCRIPTION_MAX}`,
      );
  }
}

const market = readJson(".agents/plugins/marketplace.json");
const file = readJson("cards.json");
const names = new Set<string>();

if (text(market.name) !== "iva-plugins") problem("marketplace.json", "name must be iva-plugins");
for (const raw of Array.isArray(market.plugins) ? market.plugins : []) {
  if (!isRecord(raw)) {
    problem("marketplace.json", "an entry is not an object");
    continue;
  }
  const name = text(raw.name);
  const where = `entry ${name || "?"}`;
  if (!NAME.test(name)) problem(where, "name is lowercase letters, digits and hyphens");
  if (names.has(name)) problem(where, "listed twice");
  names.add(name);
  const description = text(raw.description);
  if (!description) problem(where, "no description");
  if (description.length > DESCRIPTION_MAX || description.includes("\n"))
    problem(where, `description is one line of at most ${DESCRIPTION_MAX} characters`);
  for (const key of Object.keys(raw))
    if (!["name", "source", "description"].includes(key))
      problem(where, `field ${JSON.stringify(key)} belongs in cards.json: an installed Iva reads this file`);

  const source = raw.source;
  if (typeof source === "string") checkLocal(name, source.replace(/^\.\//u, ""));
  else if (isRecord(source)) {
    // Somebody else's repository is listed at the commit that was read, and at no other.
    if (!["url", "git-subdir"].includes(text(source.source)))
      problem(where, "source.source is url or git-subdir");
    if (!text(source.url).startsWith("https://github.com/"))
      problem(where, "source.url is an https://github.com/ repository");
    if (!SHA.test(text(source.sha))) problem(where, "source.sha is the full 40-character commit");
    if (source.ref !== undefined) problem(where, "no source.ref: the entry is pinned by sha alone");
    if (text(source.source) === "git-subdir" && !text(source.path))
      problem(where, "git-subdir needs source.path");
  } else problem(where, "source is a folder of this repository or an object");
}

const categories = new Set<string>();
for (const raw of Array.isArray(file.categories) ? file.categories : []) {
  if (!isRecord(raw) || !NAME.test(text(raw.id)) || !text(raw.en) || !text(raw.ru))
    problem("cards.json", "a category is { id, en, ru }");
  else categories.add(text(raw.id));
}

const cards = isRecord(file.plugins) ? file.plugins : {};
for (const name of names) if (!isRecord(cards[name])) problem(`entry ${name}`, "no card in cards.json");
for (const [name, raw] of Object.entries(cards)) {
  const where = `card ${name}`;
  if (!names.has(name)) problem(where, "no entry in marketplace.json");
  if (!isRecord(raw)) continue;
  if (!text(raw.title)) problem(where, "no title");
  if (!categories.has(text(raw.category))) problem(where, `category is one of ${[...categories].join(", ")}`);
  const author = isRecord(raw.author) ? raw.author : {};
  if (!text(author.name) || !LOGIN.test(text(author.github)))
    problem(where, "author is { name, github }, github being the login");
  if (!REPOSITORY.test(text(raw.repository))) problem(where, "repository is an https://github.com/ address");
  if (!DATE.test(text(raw.added))) problem(where, "added is YYYY-MM-DD");
  // The line under the name on a card: one short phrase, no full stop.
  const tagline = isRecord(raw.tagline) ? raw.tagline : {};
  for (const language of ["en", "ru"]) {
    const line = tagline[language];
    if (!text(line) || (line as string).length > 48 || /[.!]$/.test(line as string))
      problem(where, `tagline.${language}: one phrase of at most 48 characters, no full stop`);
  }
  for (const field of ["summary", "runs"]) {
    const value = isRecord(raw[field]) ? raw[field] : {};
    if (!text(value.en) || !text(value.ru)) problem(where, `${field} is { en, ru }`);
  }
  const list = (field: string, pattern: RegExp, what: string) => {
    const value = raw[field];
    if (!Array.isArray(value)) return problem(where, `${field} is a list, empty when there is nothing`);
    for (const item of value)
      if (typeof item !== "string" || !pattern.test(item)) problem(where, `${field}: ${JSON.stringify(item)} is not ${what}`);
  };
  list("keys", ENV, "a variable name");
  list("network", HOST, "a host name");
}

if (problems.length) {
  for (const line of problems) console.error(line);
  console.error(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`ok: ${names.size} plugins, ${categories.size} categories`);
