# Tusk workbench

The desktop database client: several open connections, each with its own tabs, one result stream and at most one manual transaction, driven from an editor, an Explorer sidebar and a set of dialogs.

## Language

**Connection**:
One live session to one database, identified by an id and a generation (a reconnect is a new generation of the same destination). Up to sixteen are open at once; exactly one is focused.
_Avoid_: session, backend, conn (in prose)

**Profile**:
A saved connection: its destination and settings, with the password kept in the OS keychain.
_Avoid_: saved connection, bookmark

**Tab**:
One editor buffer with its own result, grid view, search path and pending edits. A tab belongs to exactly one connection; the active tab always belongs to the focused connection.

**Result stream**:
A connection's single server-side cursor, owned by at most one tab at a time. Any other work on that connection releases it, which leaves the owning tab's result marked incomplete.
_Avoid_: cursor (in prose), live query

**Operation**:
Anything that executes against a connection: an editor run, paging, Explorer DDL, a grid Apply, an export, backup, restore, import or DDL read. Every operation follows one protocol: freeze check, release the result stream, run, apply the transaction status, record history once.
_Avoid_: action, command (that word is the IPC call underneath), request

**Manual transaction**:
A transaction the user opened with explicit control (`BEGIN`, `START TRANSACTION`, autocommit off) from one tab, which then owns the connection's session until it is committed, rolled back or lost.
_Avoid_: explicit transaction, user transaction

**Transaction owner**:
The tab that opened the manual transaction. Only the owner may run against the session; metadata and whole-connection operations are frozen until it ends.

**Result snapshot**:
The immutable rows and columns a tab last loaded, with the transaction identity they were produced under. Pending grid edits overlay it; a commit, rollback or loss marks it stale rather than discarding it.

**Explorer**:
The sidebar tree of schemas, tables, views, sequences and functions, with the context menus that generate DDL and scaffolds.
_Avoid_: sidebar (the panel), tree (the widget)

**History**:
The per-destination log of every operation that reached a server, keyed by the connection's destination rather than by which connection is focused when it finishes.

**Recovery slot**:
The per-session localStorage record of a connection's tabs (buffers, paths, dirty bits) that restores them on the next connect to the same destination.
