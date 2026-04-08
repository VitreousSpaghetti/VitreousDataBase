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
src/Database.js             file I/O, eager mode, intra-process mutex, transaction()
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
test/persistence.test.js    persistence and error property checks
test/integration.test.js    end-to-end scenarios
test/adversarial.test.js    adversarial inputs (prototype pollution, invalid schemas, etc.)
test/readme.test.js         verifies README examples work correctly
```

---

## JSON file schema

```json
{
  "entitiesConfiguration": {
    "entityName": {
      "type": "table | object",
      "id": ["fieldName"],
      "values": ["fieldName", ...],
      "notnullable": ["fieldName", ...],
      "unique": ["fieldName", ...],
      "nested": ["fieldName", ...]
    }
  },
  "entities": {
    "entityName": [ { ...record }, ... ]
  }
}
```

- `"table"` entities store records in `entities[name][]`
- `"object"` entities are schema-only; they have no entry in `entities` and cannot be inserted directly
- `nested` field names must each correspond to a registered `"object"` entity; name matching is by convention (field name === entity name). This means two fields of the same type within one entity are not expressible — each field name must match a distinct `"object"` entity name.

**Constraints by entity type:**

| Field | `"table"` | `"object"` |
|-------|-----------|------------|
| `id` | required (≥1 field) | not allowed |
| `values` | required | required |
| `notnullable` | optional | optional |
| `unique` | optional | not allowed |
| `nested` | optional | optional |

`"object"` entities without `id` or `unique` are validated only for structure (unknown fields, notnullable, nested type). Passing `id` or `unique` to an `"object"` entity throws at `createEntity` time.

---

## Invariants — never break these

1. **`id` fields are immutable.** `RecordManager.update()` rejects any patch containing an id field. `EntityManager.removeField()` also rejects removal of id fields. Do not relax this in either place.
2. **`id` fields auto-normalize.** `EntityManager.createEntity()` adds all `id` fields to `values` (if absent) and `notnullable` before persisting. Uniqueness is enforced in `validateRecord` as a **composite tuple** (all id field values together), not per-field. Composite uniqueness uses `Object.is()` per field — this means `NaN === NaN` (two NaN ids would collide) and `-0 !== +0`. Any code path that modifies `id` must ensure composite uniqueness is rechecked. Two records may share the value of an individual id field as long as the full combination differs.
3. **`id` fields cannot be `nested`.** Validated at `createEntity` time. An id field must be a primitive-comparable value.
4. **`object` entities have no `id` and no `unique`.** Both are enforced at `createEntity` time. `unique` constraints are meaningless on object entities because `validateNestedObject` never applies them.
5. **`table` entities must declare at least one `id` field.** Enforced at `createEntity` time. A table without `id` has no stable identity for `update`/`deleteRecord`.
6. **Unique constraint for `nested` fields uses deep equality.** Two nested objects are equal if they have the same keys and values recursively; key order does not matter.
7. **All writes go through `Database._write()`.** Never write to the file directly from EntityManager or RecordManager. This ensures the eager-mode cache and the mutex stay consistent.
8. **All reads go through `Database._read()`.** Same reason as above.
9. **All operations are wrapped in `Database._enqueue()`.** This is the intra-process concurrency mutex. Every public method in EntityManager and RecordManager must call `this._db._enqueue(async () => { ... })` as its outermost wrapper.
10. **Writes are atomic.** `Database._atomicWrite()` uses a temp file + `fs.rename`. Never replace this with a direct `fs.writeFile` to the target path.
11. **Circular reference detection runs before persisting.** In `createEntity`, the new config is added to a snapshot first; `detectCircularReference` runs on the snapshot; only then is `_write` called.
12. **`idObject` passed to `findById`, `update`, and `deleteRecord` must contain ALL declared `id` fields, and every key must be a declared `id` field.** Throws `InvalidIdError` if any id field is missing or if a non-id key is present. Partial idObjects on composite-id entities are rejected to prevent silent wrong-record mutations.

---

## Validator.js — rules

`Validator.js` exports four functions. They receive the full `data` snapshot and throw on violation. They never write anything.

### `validateRecord(entityName, record, data, { isUpdate, existingRecord })`

Order of checks (as implemented):
0. No field has a non-JSON-serializable number value (`NaN`, `Infinity`, `-Infinity`) — throws `TypeError` **before any other check**
1. Entity exists and is `type: 'table'`
2. No unknown fields (not in `values`)
3. All `notnullable` fields are non-null and non-undefined
4. All `unique` fields have no duplicate in existing records; nested fields use `deepEqual` (which uses `===` internally, so `NaN !== NaN`), primitives use `Object.is` (so `NaN === NaN` and `-0 !== +0`); in update mode, `existingRecord` is excluded from the comparison. **`null` and `undefined` values are exempt from uniqueness checks — multiple records may share `null` on a unique field without conflict.**
5. All `nested` fields present in the record are plain objects; each is recursively validated via `validateNestedObject`

> **Check order note:** The NaN/Infinity check (step 0) runs before the unknown-field check (step 2). A record with an unknown field whose value is `NaN` will receive `TypeError`, not `UnknownFieldError`.

### `validateNestedObject(nestedEntityName, value, data, _visited = new Set())`

Validates a nested plain object against its `"object"` entity config. Checks: unknown fields, non-JSON-serializable numbers (NaN/Infinity/-Infinity), notnullable. No unique check. Recurses into further nested fields. `_visited` is an internal parameter used to detect circular references **at validation time** — including during `insert` and `update`, not only at `createEntity`. Do not pass it from outside the function.

### `detectCircularReference(entityName, data, visited = new Set())`

DFS. Passes `new Set(visited)` per branch — this allows diamond dependencies (A→B, A→C, B→D, C→D) without false positives, while catching true cycles. A cycle is when `entityName` appears in its own transitive `nested` closure.

> **Runtime circular detection:** `validateNestedObject` also detects cycles at insert/update time via its `_visited` set. `detectCircularReference` is a schema-time guard (at `createEntity`). Both are necessary: `detectCircularReference` prevents persisting a bad schema; `validateNestedObject` guards against records that somehow contain circular object graphs (which JSON serialization would corrupt anyway).

### `deepEqual(a, b)`

Recursive strict equality for plain objects. Used by `validateRecord` for unique-constraint checks on nested fields, and exported for use in `EntityManager.addConstraint`. Key order does not matter.

> **`NaN` handling:** `deepEqual` uses `===` for leaf values, so `deepEqual(NaN, NaN)` returns `false`. Two nested objects containing `NaN` fields are never considered equal by `deepEqual`. This differs from the primitive unique-check path, which uses `Object.is()` and would treat two `NaN` primitives as a collision. The asymmetry means: `NaN` in a primitive `unique` field blocks a second insert; `NaN` inside a `nested` unique field does not.

---

## Database.js — I/O and lifecycle

### Modes

| Mode | `_read()` | `_write()` |
|------|-----------|------------|
| Default | `fs.readFile` + JSON.parse | `_atomicWrite` (temp + rename) |
| `{ eager: true }` | returns `this._cache` | updates `this._cache`, sets `_dirty = true` |

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

> **Multi-process safety:** the mutex only covers a single process. Two concurrent processes can interleave their read-modify-write cycles regardless of mode. There is no cross-process file locking. Do not share a database file across processes without external coordination.

### `transaction(fn)`

Runs multiple EntityManager/RecordManager operations atomically. If `fn` throws, no changes are persisted; if `fn` resolves, a single atomic write is performed.

Implementation: `transaction` enqueues a single outer operation. Inside it, a deep-clone of the current snapshot is forked. A fake `txDb` proxy (`_read` → returns fork, `_write` → updates fork, `_enqueue` → calls `fn()` directly) is passed to fresh `EntityManager` and `RecordManager` instances. The `fn` callback receives `{ entityManager, recordManager }` bound to this fake db.

```js
// txDb: no I/O, no queue — already inside outer _enqueue
const txDb = {
  _closed: false,
  _read:    async ()        => snapshot,
  _write:   async (newData) => { snapshot = newData; },
  _enqueue: (txFn)          => txFn(),
};
```

**Key constraints:**
- **Watch callbacks do NOT fire** for operations inside a transaction. The `tx.recordManager` is a separate instance with its own (empty) `_watchers` map. Watchers on the real `db.recordManager` are not notified.
- **Nested transactions are not supported.** Calling `db.transaction()` inside a `tx` callback will deadlock the outer `_enqueue` queue.
- Works in both default and eager modes.

### Eager mode cache initialization

`this._cache` is initialized to `null` in the constructor. `Database.create()` calls `_init()` before returning, which:
- For **existing files**: reads the file, sets `this._cache = parsed`, and calls `_registerExitHandler()`.
- For **new files**: writes `EMPTY_DB` atomically, sets `this._cache = emptyData`, and calls `_registerExitHandler()`.

After `create()` returns, `this._cache` is always non-null in eager mode. `_registerExitHandler` is always registered in eager mode regardless of whether the file was new or pre-existing.

### Eager mode flush

- `flush()` — writes cache to disk; no-op in non-eager mode
- `close()` — enqueued via `_enqueue`, so it waits for all pending operations before flushing and setting `_closed = true`. Any subsequent `_read()` or `_write()` call throws `FileAccessError('database is closed')`. Calling `close()` a second time is a safe no-op: the second call enqueues normally, but `flush()` exits early because `this._cache === null` (set to `null` by the first `close()`), so no write occurs and `_closed` is set again harmlessly.
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

When adding a new error, extend `VitreousError`, export it from `errors.js`, and re-export it from `index.js`.

---

## Known design limitations

- **One nested type per field name.** Because a nested field name must equal the `"object"` entity name, you cannot have two fields referencing the same structural type within one entity (e.g. `billingAddress` and `shippingAddress` both backed by `"address"`). Each must map to a separately named `"object"` entity.
- **`update()` cannot remove keys from a nested object.** `deepMerge` can add or overwrite keys but not delete them. Setting a key to `null` leaves it present as `null`. The only workaround is to replace the entire nested field with a new object, or set the field itself to `null` (valid only if the field is not `notnullable`).
- **`deepMerge()` replaces array fields entirely.** Arrays are not merged element-by-element — the incoming value overwrites the stored array completely. Only plain objects are deep-merged recursively.
- **`normalizeMinusZero()` is not recursive.** `-0` is normalized to `0` for top-level record fields only. Nested object fields containing `-0` are not normalized. This means a nested field can store `-0`, which survives the JSON round-trip as `0` (JSON silently converts it), but the in-memory representation inside an _enqueue callback may transiently hold `-0` in nested objects.
- **Entity names are not validated.** There is no check on the format of the name passed to `createEntity`. Empty strings, names containing spaces, and prototype property names such as `constructor`, `hasOwnProperty`, and `toString` are accepted silently. `__proto__` is handled safely (no prototype pollution via `defineProperty`), but other prototype names may produce undefined behavior. Avoid names that collide with `Object.prototype` properties.
- **Non-JSON types are silently corrupted by the round-trip.** All returned records pass through `JSON.parse(JSON.stringify(...))`. Non-finite numbers (`NaN`, `Infinity`, `-Infinity`) are rejected at validation time. Other non-serializable types are **not** rejected but are corrupted: `Date` → ISO string, `RegExp`/`Map`/`Set` → `{}`, `undefined` fields → dropped entirely. Use only plain JSON types: strings, numbers, booleans, `null`, plain objects, arrays.
- **`findWhere` predicate errors are not wrapped.** If the predicate function throws (e.g. accessing a property of `null`), the raw JavaScript error propagates uncaught — it is not wrapped in a `VitreousError`. Code that catches only `VitreousError` will not handle it.
- **`detectCircularReference` DFS is exponential on deep diamond schemas.** It creates a fresh visited-set copy per branch, allowing shared nodes to be revisited once per path. For schemas with many levels of diamond-shaped nested dependencies (A→B, A→C, B→D, C→D, …), work grows as O(2^n). In practice nested schemas are shallow; this is not a concern for typical usage.
- **Full file load on every operation (non-eager mode).** Each operation calls `fs.readFile` + `JSON.parse` on the entire database file. There is no pagination or streaming. For large datasets this is O(n) memory per operation. Use eager mode for workloads on large files.
- **`addField` and `removeField` do not validate `fieldName` type.** Unlike `createEntity`, which validates the entity name is a non-empty string, these methods do not check that `fieldName` is a valid string. Callers are responsible for passing valid field names.
- **`addConstraint` accepts an empty `fields` array.** Calling `addConstraint(entity, 'notnullable', [])` succeeds as a no-op write. No error is thrown for an empty array.
- **`watch()` on an `"object"` entity registers silently but fires no events.** `watch()` does not validate the entity type — it registers the callback regardless. Since object entities cannot have records inserted, the callback will never be invoked. No error is thrown.
- **`listEntities(type)` accepts any value without error.** Passing an unknown type string (e.g. `'tavola'`) or a non-string (e.g. `42`) returns `[]` silently rather than throwing. Only `'table'`, `'object'`, and `undefined` (meaning "all") produce non-empty results in a normal database.
- **`findWhere` with a plain-object predicate never matches `NaN` field values.** `deepMatch` uses `rVal !== pVal` for leaf comparison. Since `NaN !== NaN` is `true` in JavaScript, `findWhere('items', { qty: NaN })` returns `[]` even if records with `qty: NaN` exist. This is the opposite of the uniqueness check, which uses `Object.is()` and treats `NaN` as equal to itself. Use a function predicate and `Number.isNaN()` to match `NaN` values: `findWhere('items', r => Number.isNaN(r.qty))`.
- **`addField` returns the updated config; `removeField` returns `undefined`.** Asymmetric API: `addField` returns a deep clone of the entity config after the migration, `removeField` has no return value.
- **Watch callbacks do not fire inside transactions.** Operations on `tx.recordManager` inside `db.transaction()` use a separate RecordManager instance with no registered watchers. The real `db.recordManager` watchers are never notified during or after a transaction. This is intentional.
- **Watch callbacks do not fire on failed operations.** If `insert`/`update`/`deleteRecord` throws (e.g. unique constraint, record not found), `_write` is never called and `_emit` is never reached. Watchers only receive events for operations that successfully persisted.
- **Nested transactions are not supported.** Calling `db.transaction()` inside a `tx` callback deadlocks the queue. This is also true for any other `db.*` call that routes through `_enqueue` (e.g. `db.entityManager.*` or `db.recordManager.*` calls on the real db from inside `fn`).

---

## Conventions

- **All public methods are `async`** and return Promises, even when the underlying operation is synchronous. **Exception:** `RecordManager.watch()` is synchronous — it returns an unsubscribe function immediately, not a Promise. This matches the EventEmitter registration pattern.
- **Records are always cloned** (via `JSON.parse(JSON.stringify(...))`) before being returned. Callers must not mutate returned objects and expect the change to persist.
- **Entity configs returned by `getEntity`, `createEntity`, and `addField` are cloned.** Mutating the returned object has no effect on the stored schema. `removeField` and `addConstraint` return `undefined`.
- **`data` snapshots are mutated in-place** inside `_enqueue` callbacks before being passed to `_write`. This is safe because the mutex prevents concurrent access. **Critical:** all validation must run before any in-place mutation; in eager mode `_read()` returns `this._cache` directly, so a mutation before a failed validation would corrupt the cache with no rollback.
- **No logging.** The module throws errors — it never logs to stdout or stderr.
- **No optional chaining on `config` fields** unless the field is genuinely optional. All fields set by `createEntity` normalization (`id`, `notnullable`, `unique`, `nested`) are always arrays, never undefined.
- **Watch callbacks must not throw.** `_emit` wraps each callback in `try/catch` and discards errors. A throwing callback does not abort the write and does not affect other callbacks. Callers are responsible for handling errors inside their own watchers.
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

Expected: **365 tests, 0 failures**.

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
- `test/persistence.test.js` — persistence and error property checks
- `test/integration.test.js` — end-to-end scenarios
- `test/adversarial.test.js` — adversarial inputs and invariant enforcement
- `test/readme.test.js` — verifies README examples work correctly

