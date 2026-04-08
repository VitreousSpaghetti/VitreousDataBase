# VitreousDataBase — Roadmap

This document tracks the feature roadmap — both what has been built and what is planned next.
Implemented items include the design decisions made during implementation. Planned items include open questions that must be resolved before building.

---

## Implemented

### 3. Reactive / observable records

**Implemented** — `src/RecordManager.js`, `test/watch.test.js`

**Why**
`node:sqlite` has no built-in change notification. Polling is the only alternative. A `watch` API lets consumers react to data changes without coupling the writer and the reader — useful for live UIs (Electron), background sync, or audit logging.

**API**
```js
const unsubscribe = db.recordManager.watch('users', (event) => {
  // event: { type: 'insert' | 'update' | 'delete', record, previous? }
});

unsubscribe(); // stop watching — idempotent
```

**Implementation decisions**
- **Storage:** `Set<callback>` per entity name, held on the `RecordManager` instance.
- **Location:** `RecordManager` — it is the only layer that performs writes on records.
- **Emission:** `_emit()` is called **after** `_write()` succeeds. Failed operations (validation errors, not-found) fire no events.
- **Debounce:** none — fires immediately and synchronously after every successful write.
- **Change definition:** deep clone of the record before and after the operation. `update` events carry both `record` (after) and `previous` (before).
- **Error isolation:** callbacks that throw are silently swallowed; the write is never aborted.
- **Transactions:** operations inside `db.transaction()` do **not** fire watch callbacks — `tx.recordManager` is a separate instance with an empty watcher map.
- **Intra-process only:** watchers do not fire when another process modifies the file.

---

### 6. `updateEntity()` MVP

**Implemented** — `src/EntityManager.js`, `test/migration.test.js`

Three methods added to `EntityManager`:

- **`addField(entityName, fieldName)`** — adds an optional field to `values`. No data migration needed; existing records are unaffected. Returns the updated config (deep clone).
- **`removeField(entityName, fieldName)`** — removes a field from `values`, `notnullable`, `unique`, and `nested`, and deletes it from all existing records. Throws `InvalidIdError` if the field is an id field. Returns `undefined`.
- **`addConstraint(entityName, constraint, fields)`** — adds `'notnullable'` or `'unique'` after a safety check that scans existing records and throws (`NullConstraintError` / `UniqueConstraintError`) if any would violate the new constraint. Returns `undefined`.

A new error class `InvalidMigrationError` (`entityName`, `reason`) was added for migration-specific failures (field already exists, field not found, unknown constraint type, unique on object entity).

Full rename/type-change/id-field migrations are still not supported — see feature 4.

---

### 7. Multi-operation transactions

**Implemented** — `src/Database.js`, `test/transaction.test.js`

**API**
```js
await db.transaction(async (tx) => {
  await tx.recordManager.insert('orders', { orderId: 1, customerId: 1 });
  await tx.recordManager.insert('orderLines', { orderId: 1, lineId: 1 });
  // if either throws, neither is persisted
});
```

**Implementation decisions**
- `transaction()` enqueues a single outer operation through `_enqueue`. Inside it, the current snapshot is deep-cloned into a fork. A lightweight `txDb` proxy (`_read` → fork, `_write` → update fork, `_enqueue` → direct call) is passed to fresh `EntityManager` and `RecordManager` instances. If `fn` resolves, the fork is committed with a single `_write`. If `fn` throws, the fork is discarded.
- **`tx` exposes the full API** — both `tx.entityManager` and `tx.recordManager` with all methods.
- **Nested transactions:** not supported. Calling `db.transaction()` inside `fn` deadlocks the outer `_enqueue` queue. Documented as a known limitation.
- **Watch callbacks:** do not fire for operations inside a transaction. `tx.recordManager` is a separate instance with no registered watchers.
- Works in both default and eager modes.

---

## Planned

### 1. TypeScript-first schema with automatic type inference

**Why**
`node:sqlite` and most lightweight alternatives return untyped rows (`any`). Without a layer on top, consumers get no autocomplete, no type safety, no compile-time errors. The goal is for the schema definition to be the single source of truth for both runtime validation and static types — no code generation step, no separate `.d.ts` file to maintain.

**Design sketch**
```ts
const users = db.defineEntity('users', {
  type: 'table',
  id: ['id'],
  values: {
    id:       { type: 'number' },
    username: { type: 'string', notnullable: true },
    email:    { type: 'string', unique: true },
    address:  { type: 'nested', entity: 'address' },
  },
});

const user = await users.findById({ id: 1 });
//    ^? { id: number; username: string; email: string; address: Address | undefined }
```

The schema values field changes from `string[]` to a typed map. TypeScript infers the record shape from the map at the call site — no generics passed manually by the consumer.

**Open questions**
- Backward compatibility with the current string-array schema format — support both or break?
- How to represent `notnullable` in the inferred type (`string` vs `string | undefined`)?
- How to handle `nested` fields that reference other entities — circular type references?
- CommonJS vs ESM — type inference via `satisfies` requires TS 4.9+, sets a new minimum.

---

### 2. Nested objects as first-class citizens

**Why**
Already partially implemented — `validateNestedObject`, `deepMatch`, and `deepEqual` exist. The remaining gap is ergonomics: nested entities currently require a separate `createEntity('address', ...)` call whose name must match the field name exactly. This naming convention is a hidden constraint that breaks for multi-field same-type scenarios (e.g. `billingAddress` and `shippingAddress`).

**Design sketch**
Inline nested schema definition, decoupled from entity name:
```js
await db.entityManager.createEntity('customers', {
  type: 'table',
  id: ['id'],
  values: {
    id:              { type: 'number' },
    billingAddress:  { type: 'nested', schema: addressSchema },
    shippingAddress: { type: 'nested', schema: addressSchema },
  },
});
```

Inline schemas are anonymous — they live inside the parent entity config, not as top-level entries in `entitiesConfiguration`. This removes the field-name === entity-name constraint entirely.

**Open questions**
- Should named `object` entities still be supported for sharing schemas across tables?
- How to serialize inline schemas in the JSON file without breaking `getEntity`?
- Migration path for existing databases using the convention-based approach.

---

### 4. Schema migrations (full)

**Why**
`addField`, `removeField`, and `addConstraint` (feature 6) cover the most common evolution patterns, but renaming a field, changing its type, or restructuring `id` composition still requires deleting and recreating the entity (destroying all records).

**Design sketch**
```js
await db.entityManager.updateEntity('users', {
  add:    { phone: { type: 'string' } },
  remove: ['legacyField'],
  rename: { oldName: 'newName' },
  constraints: {
    add:    { notnullable: ['phone'] },
    remove: { unique: ['legacyField'] },
  },
});
```

`updateEntity` runs as a single enqueued operation:
1. Validates the migration is safe (e.g. adding `notnullable` on a field that has nulls in existing records → error).
2. Rewrites all existing records to conform to the new schema (filling defaults, dropping removed fields).
3. Persists the new config and the rewritten records atomically.

**Open questions**
- What is the default fill value for a newly added `notnullable` field? Require explicit `default`?
- Should unsafe migrations (data loss) require an explicit `force: true` flag?
- How to handle `rename` when the old name is also in `id`?
- Version stamping the schema in the JSON file for external tooling?

---

### 5. Lifecycle hooks (beforeInsert, afterUpdate, etc.)

**Why**
Validation rules currently cover structural constraints (notnullable, unique, unknown fields). Business logic — e.g. "set `updatedAt` automatically", "hash a password before insert", "reject a record if a related entity is in a certain state" — has to live outside the database layer, scattered across the application.

**Design sketch**
```js
await db.entityManager.createEntity('users', {
  type: 'table',
  id: ['id'],
  values: ['id', 'username', 'passwordHash', 'createdAt'],
  hooks: {
    beforeInsert: (record) => ({
      ...record,
      createdAt: Date.now(),
    }),
    beforeUpdate: (updates, existing) => updates,
    afterDelete:  (record) => { /* audit log */ },
  },
});
```

Hooks are pure functions registered at schema creation time. `before*` hooks receive the record/updates and return the (possibly modified) version to persist. `after*` hooks are fire-and-forget.

**Constraints**
- Hooks are in-memory only — they are not serialized to the JSON file.
- This means hooks must be re-registered every time `Database.create()` is called.
- Async hooks should be supported but must resolve before the write proceeds.

**Open questions**
- Where are hooks stored — on the entity config object in memory, or in a separate registry on `EntityManager`?
- Should hook errors abort the operation or be swallowed?
- Should `afterInsert`/`afterUpdate`/`afterDelete` receive the final persisted record (post JSON round-trip) or the in-memory version?

---

### 8. `findWhere` query operators

**Why**
Plain JS predicates are powerful but not composable or serializable. Query operators allow building queries programmatically and open the door to future query optimization.

**Design sketch**
```js
// current
const result = await db.recordManager.findWhere('orders', r => r.total > 100 && r.status !== 'cancelled');

// with operators
const result = await db.recordManager.findWhere('orders', {
  total:  { $gt: 100 },
  status: { $ne: 'cancelled' },
});
```

Supported operators (first pass): `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`.
Logical operators: `$and`, `$or`, `$not`.

Function predicates remain fully supported — operators are additive.

**Open questions**
- Should operators work on nested fields? `{ 'address.city': { $in: ['Milano', 'Roma'] } }` dot-notation?
- Error handling for malformed operator objects?

---

## Positioning note

The combination of features 1 (TypeScript inference) + 2 (inline nested schemas) + 5 (lifecycle hooks) defines a niche that neither `node:sqlite` nor lightweight ORMs currently fill well: a **zero-dependency, document-oriented, fully typed embedded database for Node.js**, where the schema is code and the types flow automatically to the consumer.

That is the identity worth building toward.
