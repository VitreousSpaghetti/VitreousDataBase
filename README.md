# VitreousDataBase

[![npm version](https://img.shields.io/npm/v/vitreousdatabase.svg)](https://www.npmjs.com/package/vitreousdatabase)
[![npm downloads](https://img.shields.io/npm/dm/vitreousdatabase.svg)](https://www.npmjs.com/package/vitreousdatabase)
[![license](https://img.shields.io/npm/l/vitreousdatabase.svg)](LICENSE)

A lightweight, file-backed non-relational database for Node.js. No external dependencies — data is stored as a JSON file on disk, with schema validation, constraints, and nested object support built in.

---

## Requirements

- Node.js >= 18.0.0

---

## Installation

Copy the module into your project or install it locally:

```bash
# from a local path
npm install vitreousdatabase
```

Then require it:

```js
const { Database } = require('vitreousdatabase');
```

---

## Quick start

```js
const { Database } = require('vitreousdatabase');

async function main() {
  // Opens (or creates) the database file
  const db = await Database.create('./mydata.json');

  // 1. Define the schema for an entity
  await db.entityManager.createEntity('users', {
    type: 'table',
    id: ['id'],
    values: ['id', 'username', 'email'],
    notnullable: ['username'],
    unique: ['email'],
  });

  // 2. Insert a record
  const user = await db.recordManager.insert('users', {
    id: 1,
    username: 'alice',
    email: 'alice@example.com',
  });
  console.log(user); // { id: 1, username: 'alice', email: 'alice@example.com' }

  // 3. Find by id
  const found = await db.recordManager.findByIdSingle('users', 1);
  console.log(found.username); // 'alice'

  // 4. Update
  await db.recordManager.update('users', { id: 1 }, { username: 'alice_b' });

  // 5. Delete
  await db.recordManager.deleteRecord('users', { id: 1 });
}

main();
```

The file `mydata.json` is created automatically if it does not exist.

---

## Concepts

### Database file

All data is stored in a single JSON file:

```json
{
  "entitiesConfiguration": { },
  "entities": { }
}
```

- **`entitiesConfiguration`** — the schema registry: one entry per entity, describing its fields and constraints.
- **`entities`** — the data storage: one array per `table` entity, each element is a record.

### Entity types

| Type | Description |
|------|-------------|
| `"table"` | A standalone collection of records. Supports insert, find, update, delete. |
| `"object"` | A reusable nested structure. Cannot be inserted directly — used only as a field inside a `table` entity. |

### Entity configuration fields

| Field | Required | Description |
|-------|----------|-------------|
| `type` | yes | `"table"` or `"object"` |
| `values` | yes | All field names the entity is allowed to have |
| `id` | yes (for `"table"`) | Field names that identify a record (for lookups). Auto-added to `notnullable`. Uniqueness is enforced as a **composite tuple**, not per-field. At least one required for table entities. |
| `notnullable` | no | Fields that cannot be `null` or `undefined` when saving |
| `unique` | no | Fields whose value must be unique across all records |
| `nested` | no | Fields whose value is a nested object (must match a registered `"object"` entity) |

> **Note:** `id` fields are immutable after insert — they cannot be changed via `update()`.

---

## Schema management

### `createEntity(name, config)`

Registers a new entity. Object-type entities must be created **before** any table that references them in `nested`.

```js
// Register the nested type first
await db.entityManager.createEntity('address', {
  type: 'object',
  values: ['street', 'city', 'zip'],
  notnullable: ['city'],
});

// Then register the table that uses it
await db.entityManager.createEntity('customers', {
  type: 'table',
  id: ['id'],
  values: ['id', 'name', 'email', 'address'],
  notnullable: ['name'],
  unique: ['email'],
  nested: ['address'],     // 'address' must already exist as type "object"
});
```

### `getEntity(name)`

Returns the configuration object for an entity.

```js
const config = await db.entityManager.getEntity('customers');
console.log(config.values); // ['id', 'name', 'email', 'address']
```

### `listEntities(type?)`

Returns an array of entity names, optionally filtered by type.

```js
const tables  = await db.entityManager.listEntities('table');
const objects = await db.entityManager.listEntities('object');
const all     = await db.entityManager.listEntities();
```

### `deleteEntity(name)`

Removes an entity and, for `table` entities, all its records.

```js
await db.entityManager.deleteEntity('customers');
```

> Deleting an `"object"` entity that is still referenced by a `table` throws `EntityInUseError`.

### `addField(entityName, fieldName)`

Adds a new optional field to an entity's schema. Existing records are not modified — the field is implicitly absent (`undefined`) in them.

```js
const config = await db.entityManager.addField('users', 'phone');
// config is the updated entity configuration (deep clone)
// Existing records still work — 'phone' is absent but allowed
```

Returns the updated entity config as a deep clone. Mutating the returned object has no effect on the stored schema.

- Throws `InvalidMigrationError` if the field already exists in `values`.
- Throws `EntityNotFoundError` if the entity does not exist.
- `fieldName` is not type-checked — passing a non-string value produces undefined behavior.

### `removeField(entityName, fieldName)`

Removes a field from an entity's schema and strips it from all existing records. The field is also removed from `notnullable`, `unique`, and `nested` if present.

```js
await db.entityManager.removeField('users', 'legacyFlag');
// 'legacyFlag' is gone from the schema and deleted from every record
```

Returns `undefined`.

- Throws `InvalidIdError` if `fieldName` is one of the entity's `id` fields (id fields are immutable).
- Throws `InvalidMigrationError` if the field is not in `values`.
- Throws `EntityNotFoundError` if the entity does not exist.
- `fieldName` is not type-checked — passing a non-string value produces undefined behavior.

### `addConstraint(entityName, constraint, fields)`

Adds a `'notnullable'` or `'unique'` constraint to one or more fields. Before persisting, a safety check scans existing records and throws if any would violate the new constraint — the schema is never left in an inconsistent state.

```js
// Add notnullable — safe only if no existing record has null for 'email'
await db.entityManager.addConstraint('users', 'notnullable', ['email']);

// Add unique — safe only if all existing 'email' values are already distinct
await db.entityManager.addConstraint('users', 'unique', ['email']);
```

- Throws `NullConstraintError` if adding `'notnullable'` and any existing record has `null`/`undefined` for the constrained field.
- Throws `UniqueConstraintError` if adding `'unique'` and any two existing records have the same non-null value for the constrained field. Records where the field is `null` or `undefined` are **not** considered duplicates — `addConstraint` will succeed even if many records have no value for the field.
- Throws `InvalidMigrationError` if the constraint type is unknown, if a field is not in `values`, or if `'unique'` is requested on an `"object"` entity.
- Throws `EntityNotFoundError` if the entity does not exist.
- Passing an empty `fields` array (`[]`) is a no-op — the method writes the schema unchanged and returns `undefined` without error.

Returns `undefined`.

---

## CRUD operations

### `insert(entityName, record)`

Inserts a new record. All validation rules are applied.

```js
const order = await db.recordManager.insert('orders', {
  orderId: 101,
  customerId: 1,
  total: 59.90,
});
```

### `findById(entityName, idObject)`

Looks up a record using an id object. Works for both single and composite ids. Key order does not matter.

```js
// Single id
const customer = await db.recordManager.findById('customers', { id: 1 });

// Composite id
const line = await db.recordManager.findById('orderLines', { orderId: 101, lineId: 3 });
```

Returns the record, or `null` if not found. Throws `EntityTypeError` if called on an `"object"` entity.

- `idObject` must contain **all** declared `id` fields — throws `InvalidIdError` if any are missing or if it contains a non-id key.

> **Note:** Lookup uses strict `===` comparison. `findById('items', { id: '1' })` will not match a record with `id: 1` (number). The type of the value passed must match the type stored in the record. Note that `NaN === NaN` is `false` in JavaScript, so `findById` with `{ id: NaN }` will never find a record even if one was inserted with `id: NaN`.

### `findByIdSingle(entityName, value)`

Convenience shorthand for entities with exactly one `id` field.

```js
const customer = await db.recordManager.findByIdSingle('customers', 1);
```

Returns `null` if no record matches. Throws `InvalidIdError` if the entity has a composite id. Throws `EntityTypeError` if called on an `"object"` entity.

> **Note:** Same strict `===` comparison as `findById` — `findByIdSingle('users', '1')` will not match a record with `id: 1` (number).

### `findAll(entityName)`

Returns all records for an entity. Throws `EntityTypeError` if called on an `"object"` entity.

```js
const allCustomers = await db.recordManager.findAll('customers');
```

### `findWhere(entityName, predicate)`

Filters records. Accepts either a **function** or a **plain object**.

```js
// Function predicate — full power, supports nested access
const rich = await db.recordManager.findWhere('customers', r => r.total > 1000);
const milaneseByFn = await db.recordManager.findWhere('customers', r => r.address?.city === 'Milano');

// Plain object — deep equality, supports nested fields
const alices = await db.recordManager.findWhere('customers', { name: 'Alice' });
const milanese = await db.recordManager.findWhere('customers', { address: { city: 'Milano' } });
```

Throws `EntityTypeError` if called on an `"object"` entity.


### `update(entityName, idObject, updates)`

Deep-merges `updates` into the existing record. Returns the updated record.

```js
const updated = await db.recordManager.update('customers', { id: 1 }, {
  email: 'alice_new@example.com',
});
```

Nested object fields are merged recursively — only the provided keys are overwritten, the rest are preserved:

```js
// Before: { id: 1, address: { street: 'Via Roma 1', city: 'Milano', zip: '20100' } }
await db.recordManager.update('customers', { id: 1 }, {
  address: { city: 'Torino' },
});
// After: { id: 1, address: { street: 'Via Roma 1', city: 'Torino', zip: '20100' } }
```

- Throws `EntityTypeError` if called on an `"object"` entity.
- `id` fields cannot be updated — throws `InvalidIdError`.
- `idObject` must contain **all** declared `id` fields — throws `InvalidIdError` if any are missing or if it contains a non-id key.
- Throws `RecordNotFoundError` if no record matches `idObject`.
- All validation rules (notnullable, unique, unknown fields) apply to the merged result. Unknown fields in `updates` are caught by the unknown-field check and throw `UnknownFieldError`.
- **Array fields are replaced entirely**, not merged element-by-element. Only plain objects are deep-merged recursively. `[1, 2, 3]` updated with `[4]` becomes `[4]`, not `[4, 2, 3]`.
- **`null` and `undefined` values are exempt from uniqueness checks.** Multiple records may hold `null` for a field declared `unique` — `null` is treated as "absent" rather than a comparable value.
- **`undefined` values in `updates` are dropped silently** after the JSON round-trip. If a field in `updates` is `undefined` and that field is `notnullable`, validation will throw `NullConstraintError`. If it is not `notnullable`, the field will disappear from the stored record. Use `null` to explicitly clear a nullable field.

### `deleteRecord(entityName, idObject)`

Removes a record and returns it.

```js
const removed = await db.recordManager.deleteRecord('customers', { id: 1 });
```

- Throws `EntityTypeError` if called on an `"object"` entity.
- `idObject` must contain **all** declared `id` fields — throws `InvalidIdError` if any are missing or if it contains a non-id key.
- Throws `RecordNotFoundError` if no record matches `idObject`.

---

## Transactions

`db.transaction(fn)` runs multiple operations atomically. All operations share a forked in-memory snapshot. If `fn` resolves, a single atomic write commits everything. If `fn` throws, the snapshot is discarded and nothing is persisted.

```js
await db.transaction(async (tx) => {
  await tx.recordManager.insert('orders',    { orderId: 1, customerId: 42, total: 99 });
  await tx.recordManager.insert('orderLines', { lineId: 1, orderId: 1, productId: 'P01' });
  // if either insert throws (e.g. unique constraint), neither is persisted
});
```

`tx` exposes the same `entityManager` and `recordManager` APIs as `db`:

```js
await db.transaction(async (tx) => {
  // schema changes and data changes can be mixed
  await tx.entityManager.addField('products', 'discount');
  await tx.recordManager.update('products', { id: 1 }, { discount: 10 });
});
```

Reads inside the transaction see the transaction's own uncommitted writes:

```js
await db.transaction(async (tx) => {
  await tx.recordManager.insert('items', { id: 1, qty: 10 });
  const r = await tx.recordManager.findByIdSingle('items', 1);
  console.log(r.qty); // 10 — visible within the transaction
});
```

**Constraints:**
- **Watch callbacks do not fire** for operations inside a transaction (see [Watch API](#watch-api)).
- **Nested transactions are not supported** — calling `db.transaction()` inside `fn` deadlocks.
- Transactions are serialized through the same mutex as all other operations — a transaction blocks subsequent operations until it commits or rolls back.

---

## Watch API

Subscribe to data changes on a table entity. The callback receives an event object every time a record is inserted, updated, or deleted.

```js
const unsubscribe = db.recordManager.watch('orders', (event) => {
  if (event.type === 'insert') {
    console.log('New order:', event.record);
  } else if (event.type === 'update') {
    console.log('Order changed:', event.previous, '→', event.record);
  } else if (event.type === 'delete') {
    console.log('Order removed:', event.record);
  }
});

await db.recordManager.insert('orders', { orderId: 1, total: 50 });
// → fires: { type: 'insert', record: { orderId: 1, total: 50 } }

await db.recordManager.update('orders', { orderId: 1 }, { total: 75 });
// → fires: { type: 'update', record: { orderId: 1, total: 75 }, previous: { orderId: 1, total: 50 } }

await db.recordManager.deleteRecord('orders', { orderId: 1 });
// → fires: { type: 'delete', record: { orderId: 1, total: 75 } }

// Stop listening
unsubscribe();
```

**Event shapes:**

| `type` | Properties |
|--------|------------|
| `'insert'` | `record` — the inserted record |
| `'update'` | `record` — the record after update; `previous` — snapshot before update |
| `'delete'` | `record` — the deleted record |

`record` and `previous` are deep clones — mutating them has no effect on the database.

**Behaviour:**
- `watch()` is **synchronous** — it returns the unsubscribe function immediately (not a Promise).
- Multiple watchers on the same entity are all called in registration order.
- A watcher that **throws** is silently ignored. The write still completes and other watchers still fire.
- Events fire only **after** the write succeeds. A failed operation (e.g. unique constraint violation) fires no event. Watchers can safely assume each event represents a committed change.
- `unsubscribe()` is **idempotent** — calling it more than once is a safe no-op.
- Watch is **intra-process only** — no event fires when another process modifies the file.
- Operations inside `db.transaction()` do **not** fire watch callbacks.
- Calling `watch()` on an `"object"` entity does not throw, but the callback will **never fire** — object entities cannot have records inserted.

---

## Nested objects

Fields declared in `nested` must be plain objects. Their structure is validated against the matching `"object"` entity configuration.

> **Convention:** the field name listed in `nested` must exactly match the name of the registered `"object"` entity. For example, a field named `"location"` must be backed by an entity also called `"location"`.

```js
await db.entityManager.createEntity('location', {
  type: 'object',
  values: ['lat', 'lng'],
  notnullable: ['lat', 'lng'],
});

await db.entityManager.createEntity('stores', {
  type: 'table',
  id: ['storeId'],
  values: ['storeId', 'name', 'location'],
  nested: ['location'],   // field name 'location' → validated against the 'location' object entity
});

await db.recordManager.insert('stores', {
  storeId: 'S01',
  name: 'Central Store',
  location: { lat: 45.46, lng: 9.19 },
});
```

Nested objects:
- Are validated for unknown fields and `notnullable` constraints.
- Are subject to `unique` checks using deep equality (key order does not matter).
- Cannot be used as `id` fields.
- Can themselves contain further nested objects (multi-level nesting is supported).
- Setting a nested field to `null` is valid for non-`notnullable` fields and explicitly clears it.

> **Naming constraint:** because the field name must match the `"object"` entity name, it is not possible to have two fields of the same nested type within the same entity. For example, you cannot have both `billingAddress` and `shippingAddress` backed by a single `"address"` entity — each would require its own separately named `"object"` entity (e.g. `"billingAddress"` and `"shippingAddress"`).

> **Update limitation:** `update()` deep-merges nested objects but cannot remove individual keys from a nested object. Setting a key to `null` leaves it present as `null` (which may violate `notnullable`). To replace a nested object entirely, set the whole field to a new object; to clear it, set the field to `null` (only valid if the field is not `notnullable`).

---

## Composite ids

When an entity has more than one `id` field, use `findById` with an object.

Composite id uniqueness is enforced as a **tuple**: only the full combination of id field values must be unique. Different records may share the value of individual id fields as long as the full combination differs.

```js
await db.entityManager.createEntity('orderLines', {
  type: 'table',
  id: ['orderId', 'lineId'],
  values: ['orderId', 'lineId', 'productId', 'qty'],
});

await db.recordManager.insert('orderLines', { orderId: 1, lineId: 1, productId: 'P01', qty: 2 });
await db.recordManager.insert('orderLines', { orderId: 1, lineId: 2, productId: 'P02', qty: 1 });
// orderId: 1 appears in both records — valid because (orderId, lineId) tuples are distinct

const line = await db.recordManager.findById('orderLines', { orderId: 1, lineId: 2 });
// key order does not matter: { lineId: 2, orderId: 1 } works too
```

> **Two different comparison semantics apply to id fields.** Lookups (`findById`, `update`, `deleteRecord`) use `===` — so `findById` with `{ id: NaN }` never finds anything, and `-0` matches `+0`. Uniqueness at insert time uses `Object.is()` — so two inserts with `id: NaN` collide, and `id: -0` and `id: +0` are accepted as distinct. Avoid `NaN` and `-0` as id values to prevent these inconsistencies.

---

## Eager mode

By default every read operation loads the file from disk and every write saves it immediately. For write-heavy scenarios within a single process, enable **eager mode** to keep everything in memory and flush manually.

```js
const db = await Database.create('./mydata.json', { eager: true });

// All operations hit the in-memory cache — no disk I/O
await db.recordManager.insert('logs', { id: 1, msg: 'start' });
await db.recordManager.insert('logs', { id: 2, msg: 'end' });

// Persist to disk when ready
await db.flush();

// Or close (flushes automatically)
await db.close();

// Calling close() a second time is a safe no-op — it returns immediately without flushing or throwing.
```

> **Warning:** Neither mode is safe when multiple processes share the same file. There is no cross-process file locking. The in-process mutex (`_enqueue`) only serializes operations within a single process. In eager mode data races can cause silent overwrites; in default mode, concurrent read-modify-write cycles between processes can still interleave and lose writes. Use an external coordination mechanism (e.g. a dedicated server process) in multi-process environments.

> **Eager mode data loss:** the emergency sync flush on `process.on('exit')` is not invoked on `SIGKILL` (`kill -9`), OOM termination, or `SIGTERM` without an explicit handler. Call `db.close()` or `db.flush()` before your process exits to guarantee data is written. Alternatively, register your own `SIGTERM`/`SIGINT` handlers that call `db.flush()` before exiting.

---

## Error handling

All errors extend `VitreousError`. Import specific classes to handle them precisely.

```js
const {
  Database,
  VitreousError,
  EntityNotFoundError,
  UniqueConstraintError,
  NullConstraintError,
  FileAccessError,
} = require('vitreousdatabase');

try {
  await db.recordManager.insert('users', { id: 1, username: null });
} catch (e) {
  if (e instanceof NullConstraintError) {
    console.error(`Null value rejected — field: ${e.fieldName}`);
  } else if (e instanceof UniqueConstraintError) {
    console.error(`Duplicate value rejected — field: ${e.fieldName}, value: ${e.value}`);
  } else if (e instanceof VitreousError) {
    console.error(`Database error: ${e.message}`);
  } else {
    throw e;
  }
}
```

### Full error reference

| Class | When thrown | Extra properties |
|-------|-------------|-----------------|
| `FileAccessError` | File path inaccessible, JSON is corrupt, or operation called after `close()` | `filePath`, `reason` |
| `EntityNotFoundError` | Entity name not in `entitiesConfiguration` | `entityName` |
| `EntityAlreadyExistsError` | `createEntity` called with an existing name | `entityName` |
| `EntityTypeError` | Operation requires `"table"` but got `"object"` (or vice versa) | `entityName`, `expected`, `actual` |
| `EntityInUseError` | Deleting an `"object"` entity still referenced by a table | `entityName`, `referencedBy` |
| `UnknownFieldError` | Record contains a field not listed in `values` | `entityName`, `fieldName` |
| `NullConstraintError` | A `notnullable` field is `null` or `undefined` | `entityName`, `fieldName` |
| `UniqueConstraintError` | A `unique` field value already exists in the data | `entityName`, `fieldName`, `value` |
| `NestedTypeError` | A `nested` field received a non-object value | `entityName`, `fieldName` |
| `InvalidIdError` | `id` field is also `nested`; object entity has `id`; `findByIdSingle` on composite id; `idObject` contains a non-id key or is empty; `removeField` attempted on an id field | `entityName`, `reason` |
| `CircularReferenceError` | Nested chain forms a cycle (including self-reference) | `entityName`, `cycle` |
| `RecordNotFoundError` | `update` or `deleteRecord` found no record matching `idObject` | `entityName`, `idObject` |
| `InvalidMigrationError` | `addField`/`removeField`/`addConstraint` called with an invalid argument (field already exists, field not found, unknown constraint type, unique on object entity) | `entityName`, `reason` |

---

## Complete example

Below is a self-contained script that models a small shop with customers, addresses, and orders.

```js
const { Database, UniqueConstraintError } = require('vitreousdatabase');

async function main() {
  const db = await Database.create('./shop.json');

  // --- Schema ---

  await db.entityManager.createEntity('address', {
    type: 'object',
    values: ['street', 'city', 'zip'],
    notnullable: ['city'],
  });

  await db.entityManager.createEntity('customers', {
    type: 'table',
    id: ['id'],
    values: ['id', 'name', 'email', 'address'],
    notnullable: ['name'],
    unique: ['email'],
    nested: ['address'],
  });

  await db.entityManager.createEntity('orders', {
    type: 'table',
    id: ['orderId'],
    values: ['orderId', 'customerId', 'total', 'status'],
    notnullable: ['customerId', 'total'],
  });

  // --- Insert ---

  await db.recordManager.insert('customers', {
    id: 1,
    name: 'Alice',
    email: 'alice@example.com',
    address: { street: 'Via Roma 1', city: 'Milano', zip: '20100' },
  });

  await db.recordManager.insert('customers', {
    id: 2,
    name: 'Bob',
    email: 'bob@example.com',
  });

  await db.recordManager.insert('orders', { orderId: 101, customerId: 1, total: 49.99, status: 'pending' });
  await db.recordManager.insert('orders', { orderId: 102, customerId: 1, total: 19.00, status: 'shipped' });
  await db.recordManager.insert('orders', { orderId: 103, customerId: 2, total: 99.50, status: 'pending' });

  // --- Query ---

  const alice = await db.recordManager.findByIdSingle('customers', 1);
  console.log(`Customer: ${alice.name} — city: ${alice.address?.city}`);

  const aliceOrders = await db.recordManager.findWhere('orders', { customerId: 1 });
  console.log(`Alice has ${aliceOrders.length} orders`);

  const pendingOrders = await db.recordManager.findWhere('orders', o => o.status === 'pending');
  console.log(`Pending orders: ${pendingOrders.length}`);

  // --- Update ---

  await db.recordManager.update('orders', { orderId: 101 }, { status: 'shipped' });

  // --- Unique constraint ---

  try {
    await db.recordManager.insert('customers', { id: 3, name: 'Eve', email: 'alice@example.com' });
  } catch (e) {
    if (e instanceof UniqueConstraintError) {
      console.log(`Rejected: ${e.message}`);
    }
  }

  // --- Delete ---

  await db.recordManager.deleteRecord('orders', { orderId: 103 });
  console.log(`Orders remaining: ${(await db.recordManager.findAll('orders')).length}`);
}

main().catch(console.error);
```

---

## Running the tests

```bash
node --test test/*.test.js
```

Or using the npm script:

```bash
npm test
```

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
- `test/readme.test.js` — verifies README examples work correctly

---

## Known limitations

- **Limited schema migration.** `addField`, `removeField`, and `addConstraint` cover common evolution patterns. Renaming a field, changing its type, or changing `id` composition still requires deleting and recreating the entity (destroying all its records).

- **No referential integrity across table entities.** VitreousDataBase has no concept of foreign keys between table entities. Deleting a `customers` record leaves all `orders` records with a dangling `customerId` intact and undetectable. Cross-table consistency must be maintained by the application.

- **JSON-only values.** All field values must be JSON-serializable. Non-finite numbers (`NaN`, `Infinity`, `-Infinity`) are rejected at validation time with a `TypeError`. Other non-serializable types (`Date`, `RegExp`, `Map`, `Set`, `undefined`) are **not** rejected but are silently corrupted by the `JSON.parse(JSON.stringify(...))` round-trip: `Date` becomes an ISO string, `RegExp`/`Map`/`Set` become `{}`, and `undefined` fields are dropped. Use only plain JSON types: strings, numbers, booleans, `null`, plain objects, and arrays.

- **No composite `unique` constraints.** The `unique` field in the entity config applies per-field only. There is no way to declare that a *combination* of non-id fields must be unique (e.g. `categoryId + slug`). If you need composite uniqueness, include those fields in `id` (which enforces composite tuple uniqueness) or enforce the constraint in application code.

- **`undefined` field values are silently dropped.** A field with value `undefined` that is not in `notnullable` passes validation but disappears after the JSON round-trip. The returned record will have fewer keys than what was passed. Use `null` to explicitly store an absent value.

- **`-0` is only normalized at the top level.** `normalizeMinusZero()` converts `-0` to `0` for top-level record fields before insert and update. Fields inside nested objects are not normalized — they may transiently hold `-0` in memory. JSON serialization always converts `-0` to `0`, so the value on disk is always `0`, but the in-memory representation inside an operation may differ.

- **`findWhere` predicate errors are not wrapped.** If the predicate function throws (e.g. accessing a property of `null`), the raw JavaScript error propagates uncaught — it is not wrapped in a `VitreousError`. Code that catches only `VitreousError` will not handle it.

- **Entity names are not validated.** There is no check on name format. Empty strings and names containing spaces are accepted silently. The name `__proto__` is handled safely (no prototype pollution), but other prototype property names (`constructor`, `hasOwnProperty`, `toString`, etc.) may produce undefined behavior and are not recommended.

- **Full file load on every operation (non-eager mode).** In the default mode, each operation calls `fs.readFile` + `JSON.parse` on the entire database file. There is no pagination or streaming. For large datasets this becomes an O(n) memory allocation per operation. Use eager mode for read-heavy workloads on large files.

- **Circular reference DFS is exponential on deep diamond dependencies.** `detectCircularReference` creates a fresh visited-set copy per branch, allowing shared nodes to be revisited once per path. For schemas with many levels of diamond-shaped nested dependencies (A→B, A→C, B→D, C→D, …), the work grows as O(2^n). In practice, nested schemas are shallow, so this is not a concern for typical usage.
