# CLAUDE.md — VitreousDataBase

This file is for AI agents reading this repository. It describes architecture, conventions, and rules to follow when modifying this codebase.

---

## What this project is

A Node.js module (CommonJS, zero runtime dependencies) that uses a JSON file as a non-relational database. The public API is exposed via `index.js` and consists of two managers accessed through a `Database` instance: `entityManager` (schema) and `recordManager` (data).

---

## File map

```
index.js                    public entry point — re-exports Database + all error classes
src/errors.js               all custom error classes (extend VitreousError)
src/Validator.js            pure validation functions — no side effects, no I/O
src/Database.js             file I/O, eager mode, intra-process mutex, cross-process lock
                            (multiProcess), transaction(), sidecar container files
                            (subdatabase/sharded), shard manifests
src/EntityManager.js        schema CRUD (createEntity, getEntity, listEntities, deleteEntity,
                            addField, removeField, addConstraint)
src/RecordManager.js        data CRUD (insert, findById, findByIdSingle, findAll, findWhere,
                            update, deleteRecord, watch)
test/validator.test.js      unit tests for Validator.js
test/database.test.js       integration tests for Database init and eager mode
test/entity.test.js         integration tests for EntityManager
test/record.test.js         integration tests for RecordManager
test/migration.test.js      integration tests for addField, removeField, addConstraint
test/transaction.test.js    integration tests for db.transaction()
test/watch.test.js          integration tests for recordManager.watch()
test/bugs.test.js           regression tests for known bug fixes
test/edge_cases.test.js     boundary and edge case coverage
test/query_operators.test.js integration tests for findWhere query operators ($eq, $gt, $in, $and, $or, $not, …)
test/persistence.test.js    persistence and error property checks
test/integration.test.js    end-to-end scenarios
test/adversarial.test.js    adversarial inputs (prototype pollution, invalid schemas, etc.)
test/subdatabase.test.js    integration tests for subdatabase containers
test/sharded.test.js        integration tests for sharded containers
test/shard_children.test.js integration tests for subEntities children (dotted paths, scope)
test/id_index.test.js       eager-mode in-memory id index
test/multiprocess.test.js   multiProcess lock (child processes, stale lock, timeout)
test/fixtures/multiprocess_worker.js  child-process script used by multiprocess.test.js
test/readme.test.js         verifies README examples work correctly
```

---

## JSON file schema

```json
{
  "entitiesConfiguration": {
    "entityName": {
      "type": "table | object | subdatabase | sharded",
      "id": ["fieldName"],
      "values": ["fieldName", ...],
      "notnullable": ["fieldName", ...],
      "unique": ["fieldName", ...],
      "nested": ["fieldName", ...],
      "shardKey": ["fieldName", ...],          // sharded only
      "subEntities": { "childName": { ... } } // subdatabase/sharded only
    }
  },
  "entities": {
    "entityName": [ { ...record }, ... ]
  }
}
```

- `"table"` entities store records in `entities[name][]`
- `"subdatabase"` entities store their records in a sidecar file `<dbfile>.vdb/<name>.json`, not in `entities`
- `"sharded"` entities store records in `<dbfile>.vdb/<name>/`, one file per `shardKey` tuple, plus `manifest.json` (`{ version, shards: { jsonKey -> filename } }`). Shard filenames are `<field>=<enc>__...json`, falling back to `sha1-<hex16>.json` when too long/unsafe
- Sidecar container files have the shape `{ "records": [...], "entities": { "<child>": [...] } }`; `subEntities` child records live in the same file as their parent container (or shard). Children are addressed by dotted path (`"parent.child"`)
- `"object"` entities are schema-only; they have no entry in `entities` and cannot be inserted directly
- `nested` field names must each correspond to a registered `"object"` entity; name matching is by convention (field name === entity name). This means two fields of the same type within one entity are not expressible — each field name must match a distinct `"object"` entity name.

**Constraints by entity type:**

| Field | `"table"` | `"object"` | `"subdatabase"` | `"sharded"` |
|-------|-----------|------------|-----------------|-------------|
| `id` | required (≥1 field) | not allowed | required | required, must ⊇ `shardKey` |
| `values` | required | required | required | required |
| `notnullable` | optional | optional | optional | optional (`shardKey` auto-added) |
| `unique` | optional | not allowed | optional | optional, must ⊆ `shardKey` |
| `nested` | optional | optional | optional | optional (not on `shardKey` fields) |
| `shardKey` | not allowed | not allowed | not allowed | required (≥1 field) |
| `subEntities` | not allowed | not allowed | optional | optional |

`subEntities` children must be `"table"` or `"object"` in v1 (no nested containers). A child table's `nested` refs must point at **top-level** `"object"` entities. Uniqueness on sharded entities and sharded children is **shard-local**; cross-shard uniqueness is never enforced.

`"object"` entities without `id` or `unique` are validated only for structure (unknown fields, notnullable, nested type). Passing `id` or `unique` to an `"object"` entity throws at `createEntity` time.

---

## Invariants — never break these

1. **`id` fields are immutable.** `RecordManager.update()` rejects any patch containing an id field. `EntityManager.removeField()` also rejects removal of id fields. Do not relax this in either place.
2. **`id` fields auto-normalize.** `EntityManager.createEntity()` adds all `id` fields to `values` (if absent) and `notnullable` before persisting. Uniqueness is enforced in `validateRecord` as a **composite tuple** (all id field values together), not per-field. Composite uniqueness uses `Object.is()` per field — this means `NaN === NaN` (two NaN ids would collide) and `-0 !== +0`. Any code path that modifies `id` must ensure composite uniqueness is rechecked. Two records may share the value of an individual id field as long as the full combination differs.
3. **`id` fields cannot be `nested`.** Validated at `createEntity` time. An id field must be a primitive-comparable value.
4. **`object` entities have no `id` and no `unique`.** Both are enforced at `createEntity` time. `unique` constraints are meaningless on object entities because `validateNestedObject` never applies them.
5. **`table` entities must declare at least one `id` field.** Enforced at `createEntity` time. A table without `id` has no stable identity for `update`/`deleteRecord`.
6. **Unique constraint for `nested` fields uses deep equality.** Two nested objects are equal if they have the same keys and values recursively; key order does not matter.
7. **All writes go through `Database._write()` (main file) or `Database._writeContainer()` (sidecar files).** Never write to the file directly from EntityManager or RecordManager. This ensures the eager-mode cache and the mutex stay consistent.
8. **All reads go through `Database._read()` (main file) or `Database._loadContainer()` (sidecar files).** Same reason as above.
9. **All operations are wrapped in `Database._enqueue()`.** This is the intra-process concurrency mutex. Every public method in EntityManager and RecordManager must call `this._db._enqueue(async () => { ... })` as its outermost wrapper.
10. **Writes are atomic.** `Database._atomicWrite()` uses a temp file + `fs.rename`. Never replace this with a direct `fs.writeFile` to the target path.
11. **Circular reference detection runs before persisting.** In `createEntity`, the new config is added to a snapshot first; `detectCircularReference` runs on the snapshot; only then is `_write` called.
12. **`idObject` passed to `findById`, `update`, and `deleteRecord` must contain ALL declared `id` fields, and every key must be a declared `id` field.** Throws `InvalidIdError` if any id field is missing or if a non-id key is present. Partial idObjects on composite-id entities are rejected to prevent silent wrong-record mutations.

---

## Validator.js — rules

`Validator.js` exports four functions. They receive the full `data` snapshot and throw on violation. They never write anything.

### `validateRecord(entityName, record, data, { isUpdate, existingRecord })`

Order of checks (as implemented):
0. No field has a non-JSON-serializable number value (`NaN`, `Infinity`, `-Infinity`) or a `BigInt` — throws `TypeError` **before any other check**
1. Entity exists and is `type: 'table'`
2. No unknown fields (not in `values`)
3. All `notnullable` fields are non-null and non-undefined
4. All `unique` fields have no duplicate in existing records; nested fields use `deepEqual` (which uses `===` internally, so `NaN !== NaN`), primitives use `Object.is` (so `NaN === NaN` and `-0 !== +0`); in update mode, `existingRecord` is excluded from the comparison. **`null` and `undefined` values are exempt from uniqueness checks — multiple records may share `null` on a unique field without conflict.**
5. All `nested` fields present in the record are plain objects; each is recursively validated via `validateNestedObject`

> **Check order note:** The NaN/Infinity check (step 0) runs before the unknown-field check (step 2). A record with an unknown field whose value is `NaN` will receive `TypeError`, not `UnknownFieldError`.

### `validateNestedObject(nestedEntityName, value, data, _visited = new Set())`

Validates a nested plain object against its `"object"` entity config. Checks: unknown fields, non-JSON-serializable numbers (NaN/Infinity/-Infinity) and `BigInt`, notnullable. No unique check. Recurses into further nested fields. `_visited` is an internal parameter used to detect circular references **at validation time** — including during `insert` and `update`, not only at `createEntity`. Do not pass it from outside the function.

### `detectCircularReference(entityName, data, visited = new Set())`

DFS. Passes `new Set(visited)` per branch — this allows diamond dependencies (A→B, A→C, B→D, C→D) without false positives, while catching true cycles. A cycle is when `entityName` appears in its own transitive `nested` closure.

> **Runtime circular detection:** `validateNestedObject` also detects cycles at insert/update time via its `_visited` set. `detectCircularReference` is a schema-time guard (at `createEntity`). Both are necessary: `detectCircularReference` prevents persisting a bad schema; `validateNestedObject` guards against records that somehow contain circular object graphs (which JSON serialization would corrupt anyway).

### `deepEqual(a, b)`

Recursive strict equality for plain objects and arrays. Used by `validateRecord` for unique-constraint checks on nested fields, and exported for use in `EntityManager.addConstraint`. Key order does not matter for objects; array element order does matter.

> **`NaN` handling:** `deepEqual` uses `===` for leaf values, so `deepEqual(NaN, NaN)` returns `false`. Two nested objects containing `NaN` fields are never considered equal by `deepEqual`. This differs from the primitive unique-check path, which uses `Object.is()` and would treat two `NaN` primitives as a collision. The asymmetry means: `NaN` in a primitive `unique` field blocks a second insert; `NaN` inside a `nested` unique field does not.

---

## Database.js — I/O and lifecycle

### Modes

| Mode | `_read()` | `_write()` |
|------|-----------|------------|
| Default | `fs.readFile` + JSON.parse | `_atomicWrite` (temp + rename) |
| `{ eager: true }` | returns `this._cache` | updates `this._cache`, sets `_dirty = true` |
| `{ multiProcess: true }` | same as Default, under `<dbfile>.lock` | same as Default, under `<dbfile>.lock` |

`eager` + `multiProcess` together → `TypeError('multiProcess is not compatible with eager mode')` in the constructor (before any I/O). Reason: the eager cache is the source of truth until `flush()`, invisible to other processes; a flush would overwrite their writes.

### Mutex

```js
this._queue = Promise.resolve();
_enqueue(fn) {
  const next = this._queue.then(fn);
  this._queue = next.catch(() => {});
  return next;
}
```

All public operations are serialized through `_enqueue`. This prevents read-modify-write races within a single process.

Each operation's failure is isolated: if an enqueued `fn` rejects, the rejection propagates to the caller via `next`, but `this._queue` is reset to a resolved promise via `.catch(() => {})`. Subsequent operations are therefore unaffected by a previous failure.

> **Multi-process safety:** the mutex only covers a single process. Without `multiProcess: true`, two processes can interleave read-modify-write cycles and lose writes.

### Cross-process lock (`multiProcess: true`)

Options: `multiProcess` (default `false`), `lockTimeout` (ms, default `10000`, must be a positive finite number → `TypeError` otherwise).

- `_enqueue` wraps every `fn` as: `_acquireLock()` → `_shardManifests.clear()` → `fn()` → `_releaseLock()` (in `finally`). One global lock per db covers main file + all sidecars + manifests. Reads take it too.
- `_shardManifests.clear()` is required: in non-eager mode manifests are otherwise cached across operations and would miss shards created by other processes. `_idIndex` is eager-only, so it needs nothing.
- `_init()` takes the lock around `_initFile()` so concurrent opens of a missing file write `EMPTY_DB` only once.
- `_acquireLock()`: `fs.open(lockPath, 'wx')` (O_CREAT|O_EXCL, atomic on Linux/macOS/BSD/Windows), writes `process.pid`. On `EEXIST`: `_isLockStale` → pid dead (`process.kill(pid, 0)` throws `ESRCH`; `EPERM` = alive) or empty/unparsable lock older than `lockTimeout`. Stale locks are removed by `_breakStaleLock` under a `<lock>.break` breaker file (re-checks staleness before unlinking, so two breakers cannot delete each other's fresh lock). Otherwise backoff 5→50 ms; past `lockTimeout` → `FileAccessError(lockPath, 'timed out waiting for lock')`.
- `transaction()` and `close()` go through `_enqueue` → one lock per call. Never call `_acquireLock` from inside an `_enqueue` callback (the lock is not re-entrant → self-timeout).
- Limits: same machine only (pids, O_EXCL unreliable on NFS/SMB); global lock serializes unrelated entities; `watch()` sees only its own process's writes.

### `transaction(fn)`

Runs multiple EntityManager/RecordManager operations atomically. If `fn` throws, no changes are persisted; if `fn` resolves, a single atomic write is performed. `transaction()` returns the value returned by `fn`.

Implementation: `transaction` enqueues a single outer operation. Inside it, a deep-clone of the current snapshot is forked. A fake `txDb` proxy (`_read` → returns fork, `_write` → updates fork, `_enqueue` → calls `fn()` directly) is passed to fresh `EntityManager` and `RecordManager` instances. The `fn` callback receives `{ entityManager, recordManager }` bound to this fake db.

```js
// txDb: no I/O; a local queue (txQueue) serializes ops issued concurrently inside fn
const txDb = {
  _closed: false,
  _read:    async ()        => snapshot,
  _write:   async (newData) => { snapshot = newData; },
  _enqueue: (txFn)          => { const next = txQueue.then(txFn); txQueue = next.catch(() => {}); return next; },
};
```

**Key constraints:**
- **Watch callbacks do NOT fire** for operations inside a transaction. The `tx.recordManager` is a separate instance with its own (empty) `_watchers` map. Watchers on the real `db.recordManager` are not notified.
- **Nested transactions are not supported.** Calling `db.transaction()` inside a `tx` callback will deadlock the outer `_enqueue` queue.
- **Ops inside `fn` are serialized** by a local `txQueue`, so `Promise.all` over `tx.*` calls cannot bypass uniqueness checks.
- Works in both default and eager modes.
- **Main file only.** Any subdatabase/sharded record operation inside a transaction throws `ShardKeyError`.

### Sidecar containers

- `_sidecarDir = filePath + '.vdb'`, created lazily on first container write. Legacy DBs with only `table`/`object` entities never get one.
- `_loadContainer(absPath)` / `_writeContainer(absPath, payload)` are the sidecar equivalents of `_read`/`_write`. Both throw `FileAccessError` when closed. A missing container file reads as `{ records: [], entities: {} }`.
- Non-eager: `_writeContainer` writes through via `_atomicWriteToPath` (same temp + rename scheme). Eager: payloads are cached in `_shardCache` (key = sidecar-relative path) and marked dirty; `flush()`/`close()`/exit handler persist them.
- Shard manifests are cached in `_shardManifests`. `_resolveShardFile` maps a shardKey tuple to a filename and registers it in the manifest.
- `deleteEntity` on a container removes its sidecar path (`_removeSidecarPath`, refuses paths outside `_sidecarDir`) and purges its id-index entries.
- Sharded top-level ops resolve the shard from the record/idObject (id ⊇ shardKey). Sharded-child insert/update/delete/findById require `options.scope` with the parent shardKey values (`ShardKeyError` otherwise); findAll/findWhere fan out across shards without scope. findWhere on a top-level sharded entity prunes to one shard when a plain-object predicate pins every shardKey field.

### Eager-mode id index

`Database._idIndex` is a `Map<scopeKey, Map<idKey, rowIndex>>` used by `RecordManager._findIndexById` in eager mode only. Scope keys: `table/<name>`, `subdatabase/<name>[/<child>]`, `sharded/<name>/<shardfile>[/<child>]`. Built lazily on first lookup; insert appends; update needs nothing (ids are immutable); delete invalidates the whole scope; `deleteEntity` calls `_purgeIdIndexForEntity`. Any new code path that reorders or replaces a records array in eager mode **must** invalidate the matching scope.

### Eager mode cache initialization

`this._cache` is initialized to `null` in the constructor. `Database.create()` calls `_init()` before returning, which:
- For **existing files**: reads the file, sets `this._cache = parsed`, and calls `_registerExitHandler()`.
- For **new files**: writes `EMPTY_DB` atomically, sets `this._cache = emptyData`, and calls `_registerExitHandler()`.

After `create()` returns, `this._cache` is always non-null in eager mode. `_registerExitHandler` is always registered in eager mode regardless of whether the file was new or pre-existing.

### Eager mode flush

- `flush()` — writes cache to disk; no-op in non-eager mode
- `close()` — enqueued via `_enqueue`, so it waits for all pending operations before flushing and setting `_closed = true`. Any subsequent `_read()` or `_write()` call throws `FileAccessError('database is closed')`. Calling `close()` a second time is a safe no-op: the enqueued callback returns immediately when `_closed` is already `true`. `flush()` called directly after `close()` throws `FileAccessError('database is closed')`. `close()` also removes the `process.on('exit')` listener registered by `_registerExitHandler`, preventing listener accumulation when multiple instances are created and closed in the same process.
- `process.on('exit')` — emergency sync flush via `fs.writeFileSync` if `_dirty` is true. **Not triggered by `SIGKILL`, OOM, or unhandled `SIGTERM`** — callers should register their own signal handlers if they need guaranteed flush on unexpected shutdown. If the sync write itself fails (disk full, permission denied, file lock on Windows), the error is **silently discarded** (`catch {}`) — the data loss is not observable by the application. Always prefer `db.close()` or `db.flush()` before intentional process exit to guarantee data is persisted.

### Atomic write

```js
const tempPath = filePath + '.' + randomHex + '.tmp';
await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
await fs.rename(tempPath, filePath);
// finally: unlink tempPath if rename throws
```

> **Temp file orphans:** if the process crashes between `writeFile` and `rename`, the `.tmp` file is left on disk. The `finally` unlink only covers the case where `rename` throws — not a process crash. In environments with frequent crashes, `.tmp` files may accumulate in the database directory.

---

## Error classes

All in `src/errors.js`. All extend `VitreousError`. Each carries machine-readable properties alongside the human-readable message.

| Class | Key properties |
|-------|---------------|
| `FileAccessError` | `filePath`, `reason` |
| `EntityNotFoundError` | `entityName` |
| `EntityAlreadyExistsError` | `entityName` |
| `EntityTypeError` | `entityName`, `expected`, `actual` |
| `EntityInUseError` | `entityName`, `referencedBy` (array) |
| `UnknownFieldError` | `entityName`, `fieldName` |
| `NullConstraintError` | `entityName`, `fieldName` |
| `UniqueConstraintError` | `entityName`, `fieldName`, `value` |
| `NestedTypeError` | `entityName`, `fieldName` |
| `InvalidIdError` | `entityName`, `reason` |
| `CircularReferenceError` | `entityName`, `cycle` (array) |
| `RecordNotFoundError` | `entityName`, `idObject` |
| `InvalidMigrationError` | `entityName`, `reason` |
| `ShardKeyError` | `entityName`, `reason` |

When adding a new error, extend `VitreousError`, export it from `errors.js`, and re-export it from `index.js`.

---

## Known design limitations

- **`multiProcess` is incompatible with `eager`.** Combining them throws `TypeError` at `Database.create()`. Multi-process safety exists only in default (non-eager) mode, on a local filesystem.
- **One nested type per field name.** Because a nested field name must equal the `"object"` entity name, you cannot have two fields referencing the same structural type within one entity (e.g. `billingAddress` and `shippingAddress` both backed by `"address"`). Each must map to a separately named `"object"` entity.
- **`update()` cannot remove keys from a nested object.** `deepMerge` can add or overwrite keys but not delete them. Setting a key to `null` leaves it present as `null`. The only workaround is to replace the entire nested field with a new object, or set the field itself to `null` (valid only if the field is not `notnullable`).
- **`deepMerge()` replaces array fields entirely.** Arrays are not merged element-by-element — the incoming value overwrites the stored array completely. Only plain objects are deep-merged recursively.
- **`normalizeMinusZero()` is not recursive, and runs on the full merged record at update time.** `-0` is normalized to `0` for top-level record fields only. Nested object fields containing `-0` are not normalized. This means a nested field can store `-0`, which survives the JSON round-trip as `0` (JSON silently converts it), but the in-memory representation inside an _enqueue callback may transiently hold `-0` in nested objects. Additionally, `update()` applies `normalizeMinusZero(deepMerge(existingRecord, updates))` to the **entire merged record** — including fields that were not part of `updates`. A `-0` stored in a pre-existing top-level field that was not touched by the patch will be silently converted to `0` by the update operation.
- **Entity name format is not validated.** `createEntity` requires the name to be a non-empty string — passing `''`, `null`, `undefined`, or a non-string throws `TypeError('Entity name must be a non-empty string')`. However, beyond this basic check, the format is unconstrained: names containing spaces and prototype property names such as `constructor`, `hasOwnProperty`, and `toString` are accepted silently. `__proto__` is handled safely (no prototype pollution via `defineProperty`), but other prototype names may produce undefined behavior. Avoid names that collide with `Object.prototype` properties.
- **Non-JSON types are silently corrupted by the round-trip.** All returned records pass through `JSON.parse(JSON.stringify(...))`. Non-finite numbers (`NaN`, `Infinity`, `-Infinity`) are rejected at validation time. Other non-serializable types are **not** rejected but are corrupted: `Date` → ISO string, `RegExp`/`Map`/`Set` → `{}`, `undefined` fields → dropped entirely. Use only plain JSON types: strings, numbers, booleans, `null`, plain objects, arrays.
- **`findWhere` predicate errors are not wrapped.** If the predicate function throws (e.g. accessing a property of `null`), the raw JavaScript error propagates uncaught — it is not wrapped in a `VitreousError`. Code that catches only `VitreousError` will not handle it.
- **`detectCircularReference` DFS is exponential on deep diamond schemas.** It creates a fresh visited-set copy per branch, allowing shared nodes to be revisited once per path. For schemas with many levels of diamond-shaped nested dependencies (A→B, A→C, B→D, C→D, …), work grows as O(2^n). In practice nested schemas are shallow; this is not a concern for typical usage.
- **Full file load on every operation (non-eager mode).** Each operation calls `fs.readFile` + `JSON.parse` on the entire database file. There is no pagination or streaming. For large datasets this is O(n) memory per operation. Use eager mode for workloads on large files.
- **`addField` and `removeField` only check that `fieldName` is a non-empty string.** Anything else throws `TypeError('fieldName must be a non-empty string')` (not a `VitreousError`). The format of the name is otherwise unconstrained.
- **`addConstraint` accepts an empty `fields` array.** Calling `addConstraint(entity, 'notnullable', [])` succeeds as a no-op write. No error is thrown for an empty array.
- **`addConstraint` with a non-array `fields` throws `TypeError`, not a `VitreousError`.** Elements of the array are checked against `config.values` and throw `InvalidMigrationError` if unknown.
- **`watch()` on an `"object"` entity registers silently but fires no events.** `watch()` does not validate the entity type — it registers the callback regardless. Since object entities cannot have records inserted, the callback will never be invoked. No error is thrown.
- **`watch()` on a non-existent entity also registers silently and never fires.** `watch()` does not check whether the entity exists at registration time. The callback is stored in `_watchers` keyed by entity name, but `_emit` is only reached via `_getTableConfig` which would throw `EntityNotFoundError` during any actual write — so the callback is never invoked. No error is thrown at `watch()` time.
- **`watch()` callbacks survive entity deletion.** Calling `deleteEntity('foo')` does not clear entries from `_watchers`. If `'foo'` is later recreated with `createEntity` and records are inserted/updated/deleted, the old callbacks will fire again. Callers must call their unsubscribe function before deleting an entity if they want to avoid stale callback invocations.
- **`listEntities(type)` accepts any value without error.** Passing an unknown type string (e.g. `'tavola'`) or a non-string (e.g. `42`) returns `[]` silently rather than throwing. Only `'table'`, `'object'`, and `undefined` (meaning "all") produce non-empty results in a normal database.
- **`findWhere` with a plain-object predicate never matches `NaN` field values.** `deepMatch` uses `rVal !== pVal` for leaf comparison. Since `NaN !== NaN` is `true` in JavaScript, `findWhere('items', { qty: NaN })` returns `[]` even if records with `qty: NaN` exist. This is the opposite of the uniqueness check, which uses `Object.is()` and treats `NaN` as equal to itself. Use a function predicate and `Number.isNaN()` to match `NaN` values: `findWhere('items', r => Number.isNaN(r.qty))`. The same `===` semantics apply to query operators: `{ qty: { $eq: NaN } }` also never matches, and `{ qty: { $in: [NaN] } }` never matches either.
- **`findWhere` query operators use `===` for equality, not `Object.is()`.** This means `$eq: NaN` never matches (NaN !== NaN), and `-0` and `+0` are treated as equal by `$eq`/`$ne`/`$in`/`$nin`. This differs from the insert-time uniqueness check, which uses `Object.is()`. Avoid `NaN` and `-0` as compared values in operator predicates.
- **`addField` returns the updated config; `removeField` and `deleteEntity` return `undefined`.** Asymmetric API: `addField` and `createEntity` return a deep clone of the entity config; `removeField`, `addConstraint`, and `deleteEntity` have no return value.
- **Watch callbacks do not fire inside transactions.** Operations on `tx.recordManager` inside `db.transaction()` use a separate RecordManager instance with no registered watchers. The real `db.recordManager` watchers are never notified during or after a transaction. This is intentional.
- **Watch callbacks do not fire on failed operations.** If `insert`/`update`/`deleteRecord` throws (e.g. unique constraint, record not found), `_write` is never called and `_emit` is never reached. Watchers only receive events for operations that successfully persisted.
- **Nested transactions are not supported.** Calling `db.transaction()` inside a `tx` callback deadlocks the queue. This is also true for any other `db.*` call that routes through `_enqueue` (e.g. `db.entityManager.*` or `db.recordManager.*` calls on the real db from inside `fn`).
- **`update()` with an empty `{}` patch triggers a write and fires a watch event.** `deepMerge(existingRecord, {})` produces an identical copy; validation passes; `_write` is called; `_emit` fires. Use this only when an intentional no-op write is desired; otherwise guard with `Object.keys(updates).length > 0`.
- **`$and: []` matches every record; `$or: []` matches no record.** Empty array semantics follow JavaScript: `[].every(...)` is `true`, `[].some(...)` is `false`. Avoid passing empty arrays as operands unless this behaviour is intentional.
- **`$not: {}` never matches any record.** `deepMatch(record, {})` is always `true` (no keys to fail on), so `$not: {}` negates to `false` for every record.
- **`$exists: false` is unreliable after JSON round-trip.** Fields storing `undefined` are dropped by `JSON.stringify`. After a round-trip, a field that was set to `undefined` is indistinguishable from a field that was never inserted. Use `$exists: true` reliably; treat `$exists: false` as "field key was never written".
- **Unknown query operators throw `TypeError`, not `VitreousError`.** The `default` case in `applyOperators` throws `new TypeError('Unknown query operator: ...')`. Code that catches only `VitreousError` will not intercept this.
- **`$and`, `$or`, and `$not` are root-level operators only; using them as field-level operators throws `TypeError`.** `deepMatch` handles `$and`, `$or`, `$not` as special top-level keys. If they appear as field values (e.g. `{ qty: { $and: [...] } }`), they fall through to `applyOperators`, which has no case for them and throws `TypeError('Unknown query operator: $and')`.
- **Mixing operator keys (`$...`) and plain field keys in a predicate throws `TypeError`.** `isOperatorObject` detects mixed predicates like `{ $gt: 5, name: 'foo' }` and throws `TypeError('Query predicate cannot mix operator keys ($...) with plain field keys')`. Code that catches only `VitreousError` will not intercept this.
- **`findWhere` with an array as the predicate throws `TypeError`.** Arrays pass the `typeof === 'object'` check but fail `!Array.isArray(predicate)`, causing `findWhere` to throw `TypeError('predicate must be a function or a plain object')`. Code that catches only `VitreousError` will not intercept this.
- **`$not` only accepts a plain object as its operand.** `deepMatch` checks `!isPlainObject(predicate.$not)` and throws `TypeError('$not operand must be a plain object')`. Passing a function (`{ $not: r => r.active }`) or a nested operator object (`{ $not: { $gt: 5 } }`) both throw. To negate a comparison, use `$ne`, `$nin`, or a function predicate instead.
- **`addConstraint` silently accepts duplicate entries in `fields`.** Passing `['x', 'x']` runs validation twice for `'x'` but adds it to the constraint array only once (guarded by `includes`). No error is thrown.
- **`removeField` silently removes the field from `notnullable`, `unique`, and `nested`.** If the removed field was also a nested reference to an object entity, that reference is dropped without warning.
- **`_init()` does not validate the structure of an existing file.** If the JSON file exists but lacks `entitiesConfiguration` or `entities` keys, no error is thrown at open time — errors surface only on the first operation.
- **ID lookup uses `===`, not `Object.is()`.** `findById`, `findByIdSingle`, `update`, and `deleteRecord` all find records with `r[k] === idObject[k]`. This means `-0` and `+0` are treated as equal in lookups (because `-0 === +0` is `true` in JavaScript), even though insert-time uniqueness uses `Object.is()` which treats them as distinct. In practice: if two records with id `-0` and `+0` were somehow stored (which the insert guard prevents), both would be matched and the first one returned/modified.
- **`createEntity` silently deduplicates `id`, `notnullable`, `unique`, and `nested` arrays.** Duplicate entries in `values` throw a `TypeError`; duplicates in the other arrays are removed with `[...new Set(...)]` without warning. For example, `{ id: ['x', 'x'], values: ['x'] }` succeeds and stores `id: ['x']`.
- **`findByIdSingle` throws `InvalidIdError` for entities with a composite id.** If the entity has more than one id field, `findByIdSingle` throws `InvalidIdError` with a message explaining the entity's actual id fields. Use `findById` with a full idObject for composite-id entities.
- **`addField` cannot add a field to the `nested` array.** `addField` only appends to `values`. There is no API to retroactively declare an existing field as a nested reference to an `"object"` entity without deleting and recreating the entity from scratch.
- **`watch()` on a closed database registers silently without error.** `watch()` is synchronous and does not go through `_enqueue`, so it does not check `_closed`. After `db.close()`, calling `watch()` succeeds and stores the callback in `_watchers`, but the callback will never fire — all subsequent writes fail with `FileAccessError`. No error is thrown at registration time.
- **`addConstraint('unique')` on an `id` field creates redundant and conflicting uniqueness checks.** There is no guard preventing `addConstraint(entity, 'unique', ['idField'])` on a field already declared in `id`. The `id` array already enforces composite-tuple uniqueness, but adding `unique` on an individual id field introduces a stricter per-field check. For entities with a composite id, two records that share the same individual id field value (but differ on other id fields, making the full tuple unique) would be rejected by the per-field `unique` check even though their composite id is valid.
- **`flush()` is not enqueued.** It writes the current cache immediately without waiting for pending operations; prefer `db.close()` for a guaranteed final flush. After `close()`, `flush()` throws `FileAccessError('database is closed')`.
- **`createEntity` does not validate that elements of `values` are strings.** The `values` array is verified as non-empty and duplicate-free, but individual elements are not type-checked. Passing `values: [1, null, {}]` is accepted silently. Subsequent operations may behave unpredictably because field-name comparisons use string equality — non-string entries will never match any real field name.
- **`$exists` operator accepts any truthy/falsy value, not only booleans.** `applyOperators` evaluates `operand ?` without checking `typeof operand === 'boolean'`. As a result, `{ $exists: 1 }` behaves identically to `{ $exists: true }` and `{ $exists: 0 }` behaves identically to `{ $exists: false }`. No error is thrown for non-boolean operands.
- **`update()` with `{ field: undefined }` silently removes a top-level non-notnullable field.** `Object.keys({ field: undefined })` returns `['field']`, so `deepMerge` includes the key with value `undefined` in the merged result. Validation passes (NaN/Infinity check skips non-numbers; unique check skips `undefined`; notnullable check only throws if the field is declared notnullable). The subsequent `JSON.parse(JSON.stringify(...))` call then drops the key, because `JSON.stringify` omits `undefined` values. This provides an undocumented way to delete a top-level field by passing `undefined` as its value in `updates`. CLAUDE.md documents that `update()` cannot remove keys from *nested* objects, but this top-level side-effect is separate and distinct.

---

## Conventions

- **All public methods are `async`** and return Promises, even when the underlying operation is synchronous. **Exception:** `RecordManager.watch()` is synchronous — it returns an unsubscribe function immediately, not a Promise. This matches the EventEmitter registration pattern. `watch()` throws `TypeError` synchronously if `callback` is not a function.
- **Records are always cloned** (via `JSON.parse(JSON.stringify(...))`) before being returned, and before being passed to a `findWhere` function predicate. Callers must not mutate returned objects and expect the change to persist.
- **Entity configs returned by `getEntity`, `createEntity`, and `addField` are cloned.** Mutating the returned object has no effect on the stored schema. `removeField` and `addConstraint` return `undefined`.
- **`data` snapshots are mutated in-place** inside `_enqueue` callbacks before being passed to `_write`. This is safe because the mutex prevents concurrent access. **Critical:** all validation must run before any in-place mutation; in eager mode `_read()` returns `this._cache` directly, so a mutation before a failed validation would corrupt the cache with no rollback.
- **No logging.** The module throws errors — it never logs to stdout or stderr.
- **No optional chaining on `config` fields** unless the field is genuinely optional. All fields set by `createEntity` normalization (`id`, `notnullable`, `unique`, `nested`) are always arrays, never undefined.
- **Watch callbacks must not throw or reject.** `_emit` wraps each callback in `try/catch` and, if the callback returns a thenable (i.e. is `async`), swallows the rejected promise via `.then(undefined, () => {})`. Neither a synchronous throw nor an async rejection aborts the write or affects other callbacks. Callers are responsible for handling errors inside their own watchers.
- **Watch events carry deep-cloned records.** The `record` and `previous` properties in watch events are independent snapshots — mutating them has no effect on the database.
- **Watch events fire only after a successful write.** `_emit` is called after `_write` returns. A failed operation (validation error, not-found, etc.) fires no event. Code building compensatory logic on watchers can safely assume each event represents a committed change.
- **`unsubscribe()` is idempotent.** Calling it more than once is a safe no-op — the second call is silently ignored.

---

## Adding a new feature — checklist

- [ ] New validation logic belongs in `Validator.js` as a pure function
- [ ] New error types go in `errors.js` and must be re-exported from `index.js`
- [ ] All new EntityManager/RecordManager methods wrap their body in `this._db._enqueue(async () => { ... })`
- [ ] All writes use `this._db._write(data)` — never `_atomicWrite` directly from outside `Database.js`
- [ ] Tests cover: happy path, each validation error, and edge cases
- [ ] Invariants listed above are not broken
- [ ] If the method emits watch events, call `this._emit(entityName, event)` **after** `_write` succeeds, with a deep-cloned record
- [ ] Both README.md and CLAUDE.md are updated in the same task

---

## Running tests

```bash
node --test test/*.test.js
```

Expected: **461 tests, 0 failures**.

The test suite includes:
- `test/validator.test.js` — unit tests for Validator.js
- `test/database.test.js` — Database init and eager mode
- `test/entity.test.js` — EntityManager integration
- `test/record.test.js` — RecordManager integration
- `test/migration.test.js` — addField, removeField, addConstraint
- `test/transaction.test.js` — db.transaction() atomicity and rollback
- `test/watch.test.js` — recordManager.watch() events and unsubscribe
- `test/bugs.test.js` — regression tests for known bug fixes
- `test/edge_cases.test.js` — boundary and edge case coverage
- `test/query_operators.test.js` — findWhere query operators ($eq, $gt, $in, $and, $or, $not, …)
- `test/persistence.test.js` — persistence and error property checks
- `test/integration.test.js` — end-to-end scenarios
- `test/adversarial.test.js` — adversarial inputs and invariant enforcement
- `test/subdatabase.test.js` — subdatabase containers
- `test/sharded.test.js` — sharded containers
- `test/shard_children.test.js` — subEntities children
- `test/id_index.test.js` — eager-mode id index
- `test/multiprocess.test.js` — multiProcess cross-process lock
- `test/readme.test.js` — verifies README examples work correctly

