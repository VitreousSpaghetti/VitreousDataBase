# VitreousDataBase — Roadmap

This document captures planned features and improvements for future implementation.
Each item includes a rationale, a rough design sketch, and open questions to resolve before building.

---

## Differentiating features

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

### 3. Reactive / observable records

**Why**
`node:sqlite` has no built-in change notification. Polling is the only alternative. A `watch` API would let consumers react to data changes without coupling the writer and the reader — useful for live UIs (Electron), background sync, or audit logging.

**Design sketch**
```js
const unsubscribe = db.recordManager.watch('users', (event) => {
  // event: { type: 'insert' | 'update' | 'delete', record, previous? }
});

unsubscribe(); // stop watching
```

Implementation: hook into `_write()` — before persisting, diff the old and new snapshots for the watched entity and emit events synchronously to registered callbacks.

**Constraints**
- Intra-process only — watchers do not fire when another process modifies the file.
- In eager mode, events fire on every in-memory write. In default mode, events fire after the atomic rename completes.
- Callbacks must not throw — uncaught errors in a watcher should not abort the write.

**Open questions**
- EventEmitter vs callback array vs async iterator API?
- Should `watch` be on `Database`, `EntityManager`, or `RecordManager`?
- Debounce / batching for high-frequency writes in eager mode?
- What constitutes a "change" for nested objects — deep diff or shallow?

---

### 4. Schema migrations

**Why**
Currently `createEntity` is the only schema operation. There is no `updateEntity`. Changing a field name, adding a constraint, or adding a new field requires deleting the entity (and all its records) and recreating it. This is the single most painful limitation for projects that evolve over time.

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

## Core improvements

### 6. `updateEntity()`

Minimum viable version before full migrations (feature 4):
- `addField(name, entityName, fieldConfig)` — add a new optional field to `values`.
- `addConstraint(entityName, constraint, fields)` — add `notnullable`/`unique` if safe.
- `removeField(entityName, fieldName)` — remove a field and strip it from all records.

These are simpler than full rename/type-change migrations and cover the most common evolution patterns.

---

### 7. Multi-operation transactions

**Why**
Currently every method is its own atomic unit. There is no way to insert two records and guarantee either both succeed or neither persists.

**Design sketch**
```js
await db.transaction(async (tx) => {
  await tx.recordManager.insert('orders', { orderId: 1, customerId: 1 });
  await tx.recordManager.insert('orderLines', { orderId: 1, lineId: 1 });
  // if either throws, neither is persisted
});
```

Implementation: `transaction` creates a forked in-memory snapshot, runs all operations against it, then does a single `_write` at the end. If any operation throws, the snapshot is discarded.

**Open questions**
- How to handle nested transactions?
- Should the transaction context (`tx`) expose the full API or a subset?

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
