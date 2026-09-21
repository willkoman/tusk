/**
 * The workbench's open surfaces (menus, dialogs, confirmations, docked tools) and
 * what tears each one down.
 *
 * Three events used to be three hand-maintained lists in App that already disagreed
 * with each other: a connection switch, a disconnect, and a manual transaction opening
 * on the focused connection. A surface now declares its SCOPE once, and one rule
 * decides. Adding a dialog is one registry entry, not three checklist edits.
 *
 * Scopes:
 * - `focused`: about the focused tab or connection (a context menu, a cell viewer, a
 *   run prompt). Closes when focus moves and when any connection goes away.
 * - `lifecycle`: a workbench-level question about a connection's life (close this
 *   tab? disconnect? resolve the transaction?). Survives a switch, since the user may
 *   look elsewhere while deciding; closes on a disconnect, since the answer is moot.
 * - `global`: independent of connections (delete a profile, confirm a picked path).
 *   Never torn down here.
 * - `bound`: pinned to one connection by its own state (an export source, the import
 *   binding, a DDL graph). Closes when THAT connection loses focus or disconnects,
 *   never for another one; a surface that is `busy` (a run in flight that owns its
 *   progress and Cancel) survives a switch and a transaction, but not a disconnect.
 *
 * `session` marks a surface that acts on the database session (Explorer DDL, metadata
 * reads, whole-connection operations): a manual transaction opening on its connection
 * takes the session from under it, so it closes; a surface that merely shows data
 * stays.
 */
export type SurfaceScope =
  | { kind: "focused" }
  | { kind: "lifecycle" }
  | { kind: "global" }
  | { kind: "bound"; connectionId: string | null; busy?: boolean };

export type Surface = {
  name: string;
  /** The surface's scope while open; null when it is not open. */
  scope: () => SurfaceScope | null;
  /** Acts on the database session, so a manual transaction opening takes it down. */
  session?: boolean;
  close: () => void;
};

export type SurfaceEvent =
  | { kind: "switch"; from: string }
  | { kind: "disconnect"; connectionId: string }
  | { kind: "transaction"; connectionId: string };

/** Whether a surface with this scope closes on this event. */
export function shouldClose(scope: SurfaceScope, session: boolean, event: SurfaceEvent): boolean {
  switch (event.kind) {
    case "switch":
      if (scope.kind === "focused") return true;
      if (scope.kind === "bound") return scope.connectionId === event.from && !scope.busy;
      return false;
    case "disconnect":
      if (scope.kind === "focused" || scope.kind === "lifecycle") return true;
      if (scope.kind === "bound") return scope.connectionId === event.connectionId;
      return false;
    case "transaction":
      if (!session) return false;
      if (scope.kind === "focused") return true;
      if (scope.kind === "bound") return scope.connectionId === event.connectionId && !scope.busy;
      return false;
  }
}

/** Close every open surface the event reaches; returns the names closed, in registry order. */
export function closeSurfaces(surfaces: readonly Surface[], event: SurfaceEvent): string[] {
  const closed: string[] = [];
  for (const surface of surfaces) {
    const scope = surface.scope();
    if (!scope) continue;
    if (shouldClose(scope, surface.session ?? false, event)) {
      surface.close();
      closed.push(surface.name);
    }
  }
  return closed;
}
