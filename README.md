# VitreousDataBase

A lightweight, file-backed non-relational database for Node.js. No external dependencies — data is stored as a JSON file on disk, with schema validation, constraints, and nested object support built in.

---

## Requirements

- Node.js >= 18.0.0

---

## Installation

Copy the module into your project or install it locally:

```bash
# from a local path
npm install ./path/to/VitreousDataBase
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
| `id` | no | Field names that identify a record (for lookups). Auto-added to `notnullable` and `unique`. |
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

Returns the record, or `null` if not found.

> **Note:** Comparison is strict (`===`). `findById('items', { id: '1' })` will not match a record with `id: 1` (number). The type of the value passed must match the type stored in the record.

### `findByIdSingle(entityName, value)`

Convenience shorthand for entities with exactly one `id` field.

```js
const customer = await db.recordManager.findByIdSingle('customers', 1);
```

Throws `InvalidIdError` if the entity has a composite id.

### `findAll(entityName)`

Returns all records for an entity.

```js
const allCustomers = await db.recordManager.findAll('customers');
```

### `findWhere(entityName, predicate)`

Filters records. Accepts either a **function** or a **plain object**.

```js
// Function predicate — full power, supports nested access
const rich = await db.recordManager.findWhere('customers', r => r.total > 1000);
const milanese = await db.recordManager.findWhere('customers', r => r.address.city === 'Milano');

// Plain object — top-level strict equality only
const alices = await db.recordManager.findWhere('customers', { name: 'Alice' });
```

> Nested field matching (e.g. `{ address: { city: 'Milano' } }`) is not supported via plain object — use a function predicate instead.

### `update(entityName, idObject, updates)`

Merges `updates` into the existing record. Returns the updated record.

```js
const updated = await db.recordManager.update('customers', { id: 1 }, {
  email: 'alice_new@example.com',
});
```

- `id` fields cannot be updated — throws `InvalidIdError`.
- All validation rules (notnullable, unique, unknown fields) apply to the merged result.

### `deleteRecord(entityName, idObject)`

Removes a record and returns it.

```js
const removed = await db.recordManager.deleteRecord('customers', { id: 1 });
```

---

## Nested objects

Fields declared in `nested` must be plain objects. Their structure is validated against the matching `"object"` entity configuration.

```js
await db.entityManager.createEntity('geo', {
  type: 'object',
  values: ['lat', 'lng'],
  notnullable: ['lat', 'lng'],
});

await db.entityManager.createEntity('stores', {
  type: 'table',
  id: ['storeId'],
  values: ['storeId', 'name', 'location'],
  nested: ['location'],   // validated against the 'geo' object entity
});

await db.recordManager.insert('stores', {
  storeId: 'S01',
  name: 'Central Store',
  location: { lat: 45.46, lng: 9.19 },
});
```

Nested objects:
- Are validated for unknown fields and `notnullable` constraints.
- Are **not** subject to `unique` checks (deep equality is not supported).
- Cannot be used as `id` fields.
- Can themselves contain further nested objects (multi-level nesting is supported).

---

## Composite ids

When an entity has more than one `id` field, use `findById` with an object.

```js
await db.entityManager.createEntity('orderLines', {
  type: 'table',
  id: ['orderId', 'lineId'],
  values: ['orderId', 'lineId', 'productId', 'qty'],
});

await db.recordManager.insert('orderLines', { orderId: 1, lineId: 1, productId: 'P01', qty: 2 });
await db.recordManager.insert('orderLines', { orderId: 1, lineId: 2, productId: 'P02', qty: 1 });

const line = await db.recordManager.findById('orderLines', { orderId: 1, lineId: 2 });
// key order does not matter: { lineId: 2, orderId: 1 } works too
```

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
```

> **Warning:** Eager mode is not safe when multiple processes share the same file. Use the default mode in multi-process environments.

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
| `FileAccessError` | File path inaccessible, or JSON is corrupt | `filePath`, `reason` |
| `EntityNotFoundError` | Entity name not in `entitiesConfiguration` | `entityName` |
| `EntityAlreadyExistsError` | `createEntity` called with an existing name | `entityName` |
| `EntityTypeError` | Operation requires `"table"` but got `"object"` (or vice versa) | `entityName`, `expected`, `actual` |
| `EntityInUseError` | Deleting an `"object"` entity still referenced by a table | `entityName`, `referencedBy` |
| `UnknownFieldError` | Record contains a field not listed in `values` | `entityName`, `fieldName` |
| `NullConstraintError` | A `notnullable` field is `null` or `undefined` | `entityName`, `fieldName` |
| `UniqueConstraintError` | A `unique` field value already exists in the data | `entityName`, `fieldName`, `value` |
| `NestedTypeError` | A `nested` field received a non-object value | `entityName`, `fieldName` |
| `InvalidIdError` | `id` field is also `nested`, object entity has `id`, or `findByIdSingle` on composite id | `entityName`, `reason` |
| `CircularReferenceError` | Nested chain forms a cycle | `entityName`, `cycle` |

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
node --test test/validator.test.js test/database.test.js test/entity.test.js test/record.test.js
```

Or using the npm script:

```bash
npm test
```
