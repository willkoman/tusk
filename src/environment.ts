// Environment tags on saved connections.
//
// A saved profile may be marked `dev`, `staging` or `prod`. The tag is metadata
// only — it never reaches the driver — but it drives the one piece of visual
// design in Tusk that changes outcomes rather than impressions: a production
// connection carries a red rail and a PROD badge on its chip, its tabs, the
// status bar and the title of every confirmation dialog.
//
// Pure and side-effect free: the parsing rules live here so both the connect
// form and the workbench read the same value out of `connections.json`, where
// the field is optional and older files simply have none.

export const ENVIRONMENTS = ["none", "dev", "staging", "prod"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Human label for the picker. `none` is the absence of a tag, not a tag. */
export const ENVIRONMENT_LABELS: Record<Environment, string> = {
  none: "None",
  dev: "Development",
  staging: "Staging",
  prod: "Production",
};

/** Short badge text. Empty for `none`, which renders no badge at all. */
export const ENVIRONMENT_BADGES: Record<Environment, string> = {
  none: "",
  dev: "Dev",
  staging: "Staging",
  prod: "Prod",
};

/**
 * Read a tag off stored metadata. Anything unrecognised — a null from an older
 * profile, a value from a newer Tusk, whitespace, a wrong type — degrades to
 * `none`, so a bad field can never make a connection *look* safer or louder
 * than it is; it just loses the tag.
 */
export function parseEnvironment(raw: unknown): Environment {
  if (typeof raw !== "string") return "none";
  const v = raw.trim().toLowerCase();
  return (ENVIRONMENTS as readonly string[]).includes(v) ? (v as Environment) : "none";
}

/** What goes back into `connections.json`. `none` is stored as null, not "none". */
export function serializeEnvironment(env: Environment): string | null {
  return env === "none" ? null : env;
}

export const isProduction = (env: Environment): boolean => env === "prod";

/** CSS class that pins `--conn-color` and `--env-color` to the environment hue. */
export const environmentClass = (env: Environment): string =>
  env === "none" ? "" : `env-${env}`;

/**
 * The name a connection is known by. The server-reported database name is the
 * truth; `origin` (host, or the file's directory) only appears when it is what
 * separates two otherwise identical labels — three sessions all called
 * `postgres` are the failure this exists to prevent.
 */
export function connectionDisplayName(database: string, origin: string, qualify: boolean): string {
  const base = database.trim();
  const host = origin.trim();
  if (!qualify || !host) return base || host;
  if (!base) return host;
  return `${host}/${base}`;
}
