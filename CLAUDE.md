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
- `nested` field names must each correspond to a registered `"object"` entity; name matching is by convention (field name === entity name)

---

## Invariants — never break these

1. **`id` fields are immutable.** `RecordManager.update()` rejects any patch containing an id field. Do not relax this.
2. **`id` fields auto-normalize.** `EntityManager.createEntity()` adds all `id` fields to both `notnullable` and `unique` before persisting. Any code path that modifies `id` must re-run this normalization.
3. **`id` fields cannot be `nested`.** Validated at `createEntity` time. An id field must be a primitive-comparable value.
4. **`object` entities have no `id`.** Enforced at `createEntity` time.
5. **Unique constraint for `nested` fields uses deep equality.** Two nested objects are equal if they have the same keys and values recursively; key order does not matter.
6. **All writes go through `Database._write()`.** Never write to the file directly from EntityManager or RecordManager. This ensures the eager-mode cache and the mutex stay consistent.
7. **All reads go through `Database._read()`.** Same reason as above.
8. **All operations are wrapped in `Database._enqueue()`.** This is the intra-process concurrency mutex. Every public method in EntityManager and RecordManager must call `this._db._enqueue(async () => { ... })` as its outermost wrapper.
9. **Writes are atomic.** `Database._atomicWrite()` uses a temp file + `fs.rename`. Never replace this with a direct `fs.writeFile` to the target path.
10. **Circular reference detection runs before persisting.** In `createEntity`, the new config is added to a snapshot first; `detectCircularReference` runs on the snapshot; only then is `_write` called.

---

## Validator.js — rules

`Validator.js` contains three pure functions. They receive the full `data` snapshot and throw on violation. They never write anything.

### `validateRecord(entityName, record, data, { isUpdate, existingRecord })`

Order of checks:
1. Entity exists and is `type: 'table'`
2. No unknown fields (not in `values`)
3. All `notnullable` fields are non-null and non-undefined
4. All `unique` fields have no duplicate in existing records; nested fields use deep equality, primitives use `===`; in update mode, `existingRecord` is excluded from the comparison
5. All `nested` fields present in the record are plain objects; each is recursively validated via `validateNestedObject`

### `validateNestedObject(nestedEntityName, value, data)`

Validates a nested plain object against its `"object"` entity config. Checks: unknown fields, notnullable. No unique check. Recurses into further nested fields.

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
_enqueue(fn) { return (this._queue = this._queue.then(fn)); }
```

All public operations are serialized through `_enqueue`. This prevents read-modify-write races within a single process.

### Eager mode flush

- `flush()` — writes cache to disk; no-op in non-eager mode
- `close()` — calls `flush()` then sets `_closed = true`
- `process.on('exit')` — emergency sync flush via `fs.writeFileSync` if `_dirty` is true

### Atomic write

```js
const tempPath = filePath + '.' + randomHex + '.tmp';
await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
await fs.rename(tempPath, filePath);
// finally: unlink tempPath if rename throws
```

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

When adding a new error, extend `VitreousError`, export it from `errors.js`, and re-export it from `index.js`.

---

## Conventions

- **All public methods are `async`** and return Promises, even when the underlying operation is synchronous.
- **Records are always cloned** (via `JSON.parse(JSON.stringify(...))`) before being returned. Callers must not mutate returned objects and expect the change to persist.
- **`data` snapshots are mutated in-place** inside `_enqueue` callbacks before being passed to `_write`. This is safe because the mutex prevents concurrent access.
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
node --test test/validator.test.js test/database.test.js test/entity.test.js test/record.test.js
```

Expected: **63 tests, 0 failures**.
