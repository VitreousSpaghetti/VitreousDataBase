# CLAUDE.md — VitreousDataBase

This file is for AI agents reading this repository. It describes architecture, conventions, and rules to follow when modifying this codebase.

---

## What this project is

A Node.js module (CommonJS, zero runtime dependencies) that uses a JSON file as a non-relational database. The public API is exposed via `index.js` and consists of two managers accessed through a `Database` instance: `entityManager` (schema) and `recordManager` (data).

---

## File map

```
index.js                  public entry point — re-exports Database + all error classes
src/errors.js             all custom error classes (extend VitreousError)
src/Validator.js          pure validation functions — no side effects, no I/O
src/Database.js           file I/O, eager mode, intra-process mutex
src/EntityManager.js      schema CRUD (createEntity, getEntity, listEntities, deleteEntity)
src/RecordManager.js      data CRUD (insert, findById, findByIdSingle, findAll, findWhere, update, deleteRecord)
test/validator.test.js    unit tests for Validator.js
test/database.test.js     integration tests for Database init and eager mode
test/entity.test.js       integration tests for EntityManager
test/record.test.js       integration tests for RecordManager
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

---

## Invariants — never break these

1. **`id` fields are immutable.** `RecordManager.update()` rejects any patch containing an id field. Do not relax this.
2. **`id` fields auto-normalize.** `EntityManager.createEntity()` adds all `id` fields to `values` (if absent) and `notnullable` before persisting. Uniqueness is enforced in `validateRecord` as a **composite tuple** (all id field values together), not per-field. Any code path that modifies `id` must ensure composite uniqueness is rechecked. Two records may share the value of an individual id field as long as the full combination differs.
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

`Validator.js` contains three pure functions. They receive the full `data` snapshot and throw on violation. They never write anything.

### `validateRecord(entityName, record, data, { isUpdate, existingRecord })`

Order of checks:
1. Entity exists and is `type: 'table'`
2. No unknown fields (not in `values`)
3. All `notnullable` fields are non-null and non-undefined
4. No field has a non-JSON-serializable number value (`NaN`, `Infinity`, `-Infinity`) — throws `TypeError`
5. All `unique` fields have no duplicate in existing records; nested fields use deep equality (`deepEqual`), primitives use `Object.is`; in update mode, `existingRecord` is excluded from the comparison
6. All `nested` fields present in the record are plain objects; each is recursively validated via `validateNestedObject`

### `validateNestedObject(nestedEntityName, value, data)`

Validates a nested plain object against its `"object"` entity config. Checks: unknown fields, non-JSON-serializable numbers (NaN/Infinity/-Infinity), notnullable. No unique check. Recurses into further nested fields.

### `detectCircularReference(entityName, data, visited = new Set())`

DFS. Passes `new Set(visited)` per branch — this allows diamond dependencies (A→B, A→C, B→D, C→D) without false positives, while catching true cycles. A cycle is when `entityName` appears in its own transitive `nested` closure.

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

### Eager mode flush

- `flush()` — writes cache to disk; no-op in non-eager mode
- `close()` — enqueued via `_enqueue`, so it waits for all pending operations before flushing and setting `_closed = true`. Any subsequent `_read()` or `_write()` call throws `FileAccessError('database is closed')`. Calling `close()` a second time is a safe no-op — the `_closed` check returns early before flush.
- `process.on('exit')` — emergency sync flush via `fs.writeFileSync` if `_dirty` is true. **Not triggered by `SIGKILL`, OOM, or unhandled `SIGTERM`** — callers should register their own signal handlers if they need guaranteed flush on unexpected shutdown.

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

When adding a new error, extend `VitreousError`, export it from `errors.js`, and re-export it from `index.js`.

---

## Known design limitations

- **One nested type per field name.** Because a nested field name must equal the `"object"` entity name, you cannot have two fields referencing the same structural type within one entity (e.g. `billingAddress` and `shippingAddress` both backed by `"address"`). Each must map to a separately named `"object"` entity.
- **`update()` cannot remove keys from a nested object.** `deepMerge` can add or overwrite keys but not delete them. Setting a key to `null` leaves it present as `null`. The only workaround is to replace the entire nested field with a new object, or set the field itself to `null` (valid only if the field is not `notnullable`).

---

## Conventions

- **All public methods are `async`** and return Promises, even when the underlying operation is synchronous.
- **Records are always cloned** (via `JSON.parse(JSON.stringify(...))`) before being returned. Callers must not mutate returned objects and expect the change to persist.
- **Entity configs returned by `getEntity` are also cloned.** Mutating the returned object has no effect on the stored schema.
- **`data` snapshots are mutated in-place** inside `_enqueue` callbacks before being passed to `_write`. This is safe because the mutex prevents concurrent access. **Critical:** all validation must run before any in-place mutation; in eager mode `_read()` returns `this._cache` directly, so a mutation before a failed validation would corrupt the cache with no rollback.
- **No logging.** The module throws errors — it never logs to stdout or stderr.
- **No optional chaining on `config` fields** unless the field is genuinely optional. All fields set by `createEntity` normalization (`id`, `notnullable`, `unique`, `nested`) are always arrays, never undefined.

---

## Adding a new feature — checklist

- [ ] New validation logic belongs in `Validator.js` as a pure function
- [ ] New error types go in `errors.js` and must be re-exported from `index.js`
- [ ] All new EntityManager/RecordManager methods wrap their body in `this._db._enqueue(async () => { ... })`
- [ ] All writes use `this._db._write(data)` — never `_atomicWrite` directly from outside `Database.js`
- [ ] Tests cover: happy path, each validation error, and edge cases
- [ ] Invariants listed above are not broken

---

## Running tests

```bash
node --test test/*.test.js
```

Expected: **262 tests, 0 failures**.

The test suite includes:
- `test/validator.test.js` — unit tests for Validator.js
- `test/database.test.js` — Database init and eager mode
- `test/entity.test.js` — EntityManager integration
- `test/record.test.js` — RecordManager integration
- `test/bugs.test.js` — regression tests for all BUGS.md fixes
- `test/edge_cases.test.js` — boundary and edge case coverage
- `test/persistence.test.js` — persistence and error property checks
- `test/integration.test.js` — end-to-end scenarios
- `test/readme.test.js` — verifies README examples work correctly
