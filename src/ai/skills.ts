// User-authored AI skills: reusable instruction bundles fed to the assistant as working
// context. Mirrors `src-tauri/src/skills.rs` (serde camelCase). Storage, import, and
// export all live in Rust — this file owns the selection + prompt-rendering rules, which
// are pure and unit-tested, and are the PARITY PAIR of `slack/context.rs`'s skill block.

export type SkillScope = "workspace" | "database";

export type Skill = {
  id: string;
  name: string;
  description: string;
  scope: SkillScope;
  /** Database name this applies to. Empty for workspace scope. */
  database: string;
  enabled: boolean;
  /** The instructions themselves (Markdown). This is what reaches the model. */
  body: string;
};

export const emptySkill = (): Skill => ({
  id: "",
  name: "",
  description: "",
  scope: "workspace",
  database: "",
  enabled: true,
  body: "",
});

/** Chars of skill text allowed into the prompt. Skills are user-authored instructions —
 *  they get a bigger slice than sample rows, but not an unbounded one. */
export const SKILLS_BUDGET = 8000;

/** Skills that apply to a connection on `database`, most specific first: a database-scoped
 *  skill outranks a workspace one, so the specific instruction is the one that survives a
 *  budget cutoff. Disabled skills never apply. */
export function activeSkills(all: Skill[], database: string): Skill[] {
  const applies = (s: Skill) =>
    s.enabled && (s.scope === "database" ? !!s.database && s.database === database : true);
  const rank = (s: Skill) => (s.scope === "database" ? 0 : 1);
  return all
    .filter(applies)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
    .map((x) => x.s);
}

/** Render the skills block. Budgeted, and a dropped skill is NAMED rather than silently
 *  cut — a user who wrote an instruction must be able to tell it didn't reach the model. */
export function formatSkills(skills: Skill[], budget = SKILLS_BUDGET): string {
  let out = "";
  const dropped: string[] = [];
  for (const s of skills) {
    const body = s.body.trim();
    if (!body) continue;
    const head = s.description.trim() ? `${s.name} — ${s.description.trim()}` : s.name;
    const scope = s.scope === "database" ? ` (database: ${s.database})` : "";
    const block = `\n## ${head}${scope}\n${body}\n`;
    if (out.length + block.length > budget) dropped.push(s.name);
    else out += block;
  }
  if (dropped.length) out += `\n(Not included, over the context budget: ${dropped.join(", ")})\n`;
  return out;
}
