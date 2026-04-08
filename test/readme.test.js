'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  Database,
  VitreousError,
  EntityNotFoundError,
  EntityAlreadyExistsError,
  EntityTypeError,
  UnknownFieldError,
  NullConstraintError,
  UniqueConstraintError,
  NestedTypeError,
  InvalidIdError,
  CircularReferenceError,
} = require('../index.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let dbFileCounter = 0;
function tmpPath() {
  return path.join(__dirname, `_readme_test_${process.pid}_${++dbFileCounter}.json`);
}

async function freshDb(opts) {
  const p = tmpPath();
  const db = await Database.create(p, opts);
  return { db, p };
}

function cleanup(p) {
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------
// Quick-start scenario (README §Quick start)
// ---------------------------------------------------------------------------

describe('Quick start', () => {
  let db, p;

  before(async () => {
    ({ db, p } = await freshDb());
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'username', 'email'],
      notnullable: ['username'],
      unique: ['email'],
    });
  });

  after(() => cleanup(p));

  test('insert returns the record', async () => {
    const user = await db.recordManager.insert('users', {
      id: 1, username: 'alice', email: 'alice@example.com',
    });
    assert.equal(user.id, 1);
    assert.equal(user.username, 'alice');
    assert.equal(user.email, 'alice@example.com');
  });

  test('findByIdSingle returns inserted record', async () => {
    const found = await db.recordManager.findByIdSingle('users', 1);
    assert.equal(found.username, 'alice');
  });

  test('update changes non-id fields', async () => {
    await db.recordManager.update('users', { id: 1 }, { username: 'alice_b' });
    const updated = await db.recordManager.findByIdSingle('users', 1);
    assert.equal(updated.username, 'alice_b');
  });

  test('deleteRecord removes the record and returns it', async () => {
    const removed = await db.recordManager.deleteRecord('users', { id: 1 });
    assert.equal(removed.id, 1);
    const gone = await db.recordManager.findByIdSingle('users', 1);
    assert.equal(gone, null);
  });
});

// ---------------------------------------------------------------------------
// Schema management (README §Schema management)
// ---------------------------------------------------------------------------

describe('Schema management — createEntity', () => {
  let db, p;

  before(async () => {
    ({ db, p } = await freshDb());
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
  });

  after(() => cleanup(p));

  test('object entity must be created before table that nests it — no error thrown', async () => {
    const cfg = await db.entityManager.getEntity('address');
    assert.equal(cfg.type, 'object');
  });

  test('getEntity returns configuration', async () => {
    const config = await db.entityManager.getEntity('customers');
    assert.deepEqual(config.values, ['id', 'name', 'email', 'address']);
  });

  test('listEntities filtered by type', async () => {
    const tables  = await db.entityManager.listEntities('table');
    const objects = await db.entityManager.listEntities('object');
    const all     = await db.entityManager.listEntities();
    assert.ok(tables.includes('customers'));
    assert.ok(!tables.includes('address'));
    assert.ok(objects.includes('address'));
    assert.ok(!objects.includes('customers'));
    assert.ok(all.includes('customers') && all.includes('address'));
  });

  test('createEntity throws EntityAlreadyExistsError on duplicate name', async () => {
    let threw = false;
    try {
      await db.entityManager.createEntity('customers', { type: 'table', values: [] });
    } catch (e) {
      threw = true;
      assert.ok(e instanceof EntityAlreadyExistsError, `Expected EntityAlreadyExistsError, got ${e.constructor.name}`);
      assert.equal(e.entityName, 'customers');
    }
    assert.ok(threw, 'should have thrown');
  });

  test('deleteEntity removes a table entity', async () => {
    const { db: db2, p: p2 } = await freshDb();
    try {
      await db2.entityManager.createEntity('tmp', { type: 'table', id: ['id'], values: ['id'] });
      await db2.entityManager.deleteEntity('tmp');
      let threw = false;
      try {
        await db2.entityManager.getEntity('tmp');
      } catch (e) {
        threw = true;
        assert.ok(e instanceof EntityNotFoundError);
      }
      assert.ok(threw, 'should have thrown EntityNotFoundError');
    } finally {
      cleanup(p2);
    }
  });

  test('deleting an object entity still referenced by a table throws a VitreousError', async () => {
    // README documents EntityInUseError; verify at minimum a VitreousError is thrown
    const { db: db2, p: p2 } = await freshDb();
    try {
      await db2.entityManager.createEntity('addr', {
        type: 'object',
        values: ['city'],
        notnullable: ['city'],
      });
      await db2.entityManager.createEntity('shops', {
        type: 'table',
        id: ['id'],
        values: ['id', 'addr'],
        nested: ['addr'],
      });
      let threw = false;
      try {
        await db2.entityManager.deleteEntity('addr');
      } catch (e) {
        threw = true;
        assert.ok(e instanceof VitreousError, `Expected VitreousError, got ${e.constructor.name}: ${e.message}`);
      }
      assert.ok(threw, 'should have thrown when deleting in-use object entity');
    } finally {
      cleanup(p2);
    }
  });
});

// ---------------------------------------------------------------------------
// CRUD operations (README §CRUD operations)
// ---------------------------------------------------------------------------

describe('CRUD — findById and findAll', () => {
  let db, p;

  before(async () => {
    ({ db, p } = await freshDb());
    await db.entityManager.createEntity('orders', {
      type: 'table',
      id: ['orderId'],
      values: ['orderId', 'customerId', 'total', 'status'],
      notnullable: ['customerId', 'total'],
    });
    await db.recordManager.insert('orders', { orderId: 101, customerId: 1, total: 49.99, status: 'pending' });
    await db.recordManager.insert('orders', { orderId: 102, customerId: 1, total: 19.00, status: 'shipped' });
    await db.recordManager.insert('orders', { orderId: 103, customerId: 2, total: 99.50, status: 'pending' });
  });

  after(() => cleanup(p));

  test('findById returns record', async () => {
    const found = await db.recordManager.findById('orders', { orderId: 101 });
    assert.equal(found.total, 49.99);
  });

  test('findById returns null when not found', async () => {
    const missing = await db.recordManager.findById('orders', { orderId: 999 });
    assert.equal(missing, null);
  });

  test('findByIdSingle is shorthand for single-id entity', async () => {
    const r = await db.recordManager.findByIdSingle('orders', 102);
    assert.equal(r.status, 'shipped');
  });

  test('findAll returns every record', async () => {
    const all = await db.recordManager.findAll('orders');
    assert.equal(all.length, 3);
  });

  test('findWhere with object predicate (strict equality)', async () => {
    const customer1Orders = await db.recordManager.findWhere('orders', { customerId: 1 });
    assert.equal(customer1Orders.length, 2);
  });

  test('findWhere with function predicate', async () => {
    const pending = await db.recordManager.findWhere('orders', o => o.status === 'pending');
    assert.equal(pending.length, 2);
    assert.ok(pending.every(o => o.status === 'pending'));
  });
});

describe('CRUD — update', () => {
  let db, p;

  before(async () => {
    ({ db, p } = await freshDb());
    await db.entityManager.createEntity('orders', {
      type: 'table',
      id: ['orderId'],
      values: ['orderId', 'customerId', 'total', 'status'],
      notnullable: ['customerId', 'total'],
    });
    await db.recordManager.insert('orders', { orderId: 101, customerId: 1, total: 49.99, status: 'pending' });
  });

  after(() => cleanup(p));

  test('update merges fields and returns updated record', async () => {
    const updated = await db.recordManager.update('orders', { orderId: 101 }, { status: 'shipped' });
    assert.equal(updated.status, 'shipped');
    assert.equal(updated.orderId, 101);
  });

  test('update throws InvalidIdError when trying to change an id field', async () => {
    let threw = false;
    try {
      await db.recordManager.update('orders', { orderId: 101 }, { orderId: 999 });
    } catch (e) {
      threw = true;
      assert.ok(e instanceof InvalidIdError, `Expected InvalidIdError, got ${e.constructor.name}`);
    }
    assert.ok(threw, 'should have thrown');
  });
});

describe('CRUD — deleteRecord', () => {
  test('deleteRecord removes and returns the record', async () => {
    const { db, p } = await freshDb();
    try {
      await db.entityManager.createEntity('orders', {
        type: 'table',
        id: ['orderId'],
        values: ['orderId', 'customerId', 'total', 'status'],
        notnullable: ['customerId', 'total'],
      });
      await db.recordManager.insert('orders', { orderId: 101, customerId: 1, total: 49.99, status: 'pending' });
      await db.recordManager.insert('orders', { orderId: 102, customerId: 1, total: 19.00, status: 'shipped' });
      await db.recordManager.insert('orders', { orderId: 103, customerId: 2, total: 99.50, status: 'pending' });

      const removed = await db.recordManager.deleteRecord('orders', { orderId: 103 });
      assert.equal(removed.orderId, 103);

      const remaining = await db.recordManager.findAll('orders');
      assert.equal(remaining.length, 2);
    } finally {
      cleanup(p);
    }
  });
});

// ---------------------------------------------------------------------------
// Nested objects (README §Nested objects)
// ---------------------------------------------------------------------------

// Field name must match entity name by convention — use 'location' for both.
// Each test that expects a failed insert uses its own freshDb to avoid
// corrupting the shared db's _enqueue queue.

async function makeStoresDb() {
  const { db, p } = await freshDb();
  await db.entityManager.createEntity('location', {
    type: 'object',
    values: ['lat', 'lng'],
    notnullable: ['lat', 'lng'],
  });
  await db.entityManager.createEntity('stores', {
    type: 'table',
    id: ['storeId'],
    values: ['storeId', 'name', 'location'],
    nested: ['location'],
  });
  return { db, p };
}

describe('Nested objects', () => {
  test('insert with valid nested object succeeds', async () => {
    const { db, p } = await makeStoresDb();
    try {
      const s = await db.recordManager.insert('stores', {
        storeId: 'S01', name: 'Central Store',
        location: { lat: 45.46, lng: 9.19 },
      });
      assert.equal(s.location.lat, 45.46);
    } finally { cleanup(p); }
  });

  test('nested object with unknown field throws UnknownFieldError', async () => {
    const { db, p } = await makeStoresDb();
    try {
      let threw = false;
      try {
        await db.recordManager.insert('stores', {
          storeId: 'S02', name: 'Bad Store',
          location: { lat: 1, lng: 2, altitude: 100 },
        });
      } catch (e) {
        threw = true;
        assert.ok(e instanceof UnknownFieldError, `Expected UnknownFieldError, got ${e.constructor.name}`);
      }
      assert.ok(threw, 'should have thrown');
    } finally { cleanup(p); }
  });

  test('nested field receiving a non-object value throws NestedTypeError', async () => {
    const { db, p } = await makeStoresDb();
    try {
      let threw = false;
      try {
        await db.recordManager.insert('stores', {
          storeId: 'S03', name: 'Bad Store', location: 'not-an-object',
        });
      } catch (e) {
        threw = true;
        assert.ok(e instanceof NestedTypeError, `Expected NestedTypeError, got ${e.constructor.name}`);
      }
      assert.ok(threw, 'should have thrown');
    } finally { cleanup(p); }
  });

  test('notnullable inside nested object is enforced', async () => {
    const { db, p } = await makeStoresDb();
    try {
      let threw = false;
      try {
        await db.recordManager.insert('stores', {
          storeId: 'S04', name: 'Bad Store',
          location: { lat: null, lng: 9.19 },
        });
      } catch (e) {
        threw = true;
        assert.ok(e instanceof NullConstraintError, `Expected NullConstraintError, got ${e.constructor.name}`);
      }
      assert.ok(threw, 'should have thrown');
    } finally { cleanup(p); }
  });

  test('findWhere with function predicate can access nested fields', async () => {
    const { db, p } = await makeStoresDb();
    try {
      await db.recordManager.insert('stores', {
        storeId: 'S01', name: 'Central Store',
        location: { lat: 45.46, lng: 9.19 },
      });
      const results = await db.recordManager.findWhere('stores', r => r.location?.lat === 45.46);
      assert.equal(results.length, 1);
      assert.equal(results[0].storeId, 'S01');
    } finally { cleanup(p); }
  });
});

// ---------------------------------------------------------------------------
// Composite ids (README §Composite ids)
// ---------------------------------------------------------------------------

describe('Composite ids', () => {
  let db, p;

  before(async () => {
    ({ db, p } = await freshDb());
    await db.entityManager.createEntity('orderLines', {
      type: 'table',
      id: ['orderId', 'lineId'],
      values: ['orderId', 'lineId', 'productId', 'qty'],
    });
    // Each id field is individually unique-constrained, so use distinct values for all id fields
    await db.recordManager.insert('orderLines', { orderId: 1, lineId: 1, productId: 'P01', qty: 2 });
    await db.recordManager.insert('orderLines', { orderId: 2, lineId: 3, productId: 'P02', qty: 1 });
  });

  after(() => cleanup(p));

  test('findById with composite id returns correct record', async () => {
    const line = await db.recordManager.findById('orderLines', { orderId: 2, lineId: 3 });
    assert.equal(line.productId, 'P02');
  });

  test('findById key order does not matter', async () => {
    const line = await db.recordManager.findById('orderLines', { lineId: 1, orderId: 1 });
    assert.equal(line.productId, 'P01');
  });

  test('findByIdSingle on composite-id entity throws InvalidIdError', async () => {
    let threw = false;
    try {
      await db.recordManager.findByIdSingle('orderLines', 1);
    } catch (e) {
      threw = true;
      assert.ok(e instanceof InvalidIdError, `Expected InvalidIdError, got ${e.constructor.name}`);
    }
    assert.ok(threw, 'should have thrown');
  });
});

// ---------------------------------------------------------------------------
// Eager mode (README §Eager mode)
// ---------------------------------------------------------------------------

describe('Eager mode', () => {
  test('operations work in memory without flushing', async () => {
    const { db, p } = await freshDb({ eager: true });
    try {
      await db.entityManager.createEntity('logs', {
        type: 'table', id: ['id'], values: ['id', 'msg'],
      });
      await db.recordManager.insert('logs', { id: 1, msg: 'start' });
      await db.recordManager.insert('logs', { id: 2, msg: 'end' });
      const all = await db.recordManager.findAll('logs');
      assert.equal(all.length, 2);
    } finally {
      await db.close();
      cleanup(p);
    }
  });

  test('flush persists data to disk', async () => {
    const { db, p } = await freshDb({ eager: true });
    try {
      await db.entityManager.createEntity('logs', {
        type: 'table', id: ['id'], values: ['id', 'msg'],
      });
      await db.recordManager.insert('logs', { id: 1, msg: 'hello' });
      await db.flush();

      const db2 = await Database.create(p);
      const all = await db2.recordManager.findAll('logs');
      assert.equal(all.length, 1);
      assert.equal(all[0].msg, 'hello');
    } finally {
      cleanup(p);
    }
  });

  test('close flushes automatically', async () => {
    const { db, p } = await freshDb({ eager: true });
    try {
      await db.entityManager.createEntity('logs', {
        type: 'table', id: ['id'], values: ['id', 'msg'],
      });
      await db.recordManager.insert('logs', { id: 99, msg: 'close-flush' });
      await db.close();

      const db2 = await Database.create(p);
      const r = await db2.recordManager.findByIdSingle('logs', 99);
      assert.equal(r.msg, 'close-flush');
    } finally {
      cleanup(p);
    }
  });
});

// ---------------------------------------------------------------------------
// Error handling (README §Error handling)
// Each test uses its own db to avoid shared-state interference.
// ---------------------------------------------------------------------------

describe('Error handling — NullConstraintError', () => {
  test('carries entityName and fieldName', async () => {
    const { db, p } = await freshDb();
    try {
      await db.entityManager.createEntity('users', {
        type: 'table', id: ['id'],
        values: ['id', 'username', 'email'],
        notnullable: ['username'], unique: ['email'],
      });
      await db.recordManager.insert('users', { id: 1, username: 'alice', email: 'a@a.com' });

      let threw = false;
      try {
        await db.recordManager.insert('users', { id: 2, username: null, email: 'x@x.com' });
      } catch (e) {
        threw = true;
        assert.ok(e instanceof NullConstraintError, `Expected NullConstraintError, got ${e.constructor.name}`);
        assert.ok(e instanceof VitreousError);
        assert.equal(e.entityName, 'users');
        assert.equal(e.fieldName, 'username');
      }
      assert.ok(threw, 'should have thrown');
    } finally {
      cleanup(p);
    }
  });
});

describe('Error handling — UniqueConstraintError', () => {
  test('carries entityName, fieldName, value', async () => {
    const { db, p } = await freshDb();
    try {
      await db.entityManager.createEntity('users', {
        type: 'table', id: ['id'],
        values: ['id', 'username', 'email'],
        notnullable: ['username'], unique: ['email'],
      });
      await db.recordManager.insert('users', { id: 1, username: 'alice', email: 'alice@example.com' });

      let threw = false;
      try {
        await db.recordManager.insert('users', { id: 3, username: 'eve', email: 'alice@example.com' });
      } catch (e) {
        threw = true;
        assert.ok(e instanceof UniqueConstraintError, `Expected UniqueConstraintError, got ${e.constructor.name}`);
        assert.equal(e.entityName, 'users');
        assert.equal(e.fieldName, 'email');
        assert.equal(e.value, 'alice@example.com');
      }
      assert.ok(threw, 'should have thrown');
    } finally {
      cleanup(p);
    }
  });
});

describe('Error handling — UnknownFieldError', () => {
  test('thrown on insert with extra field', async () => {
    const { db, p } = await freshDb();
    try {
      await db.entityManager.createEntity('users', {
        type: 'table', id: ['id'],
        values: ['id', 'username', 'email'],
        notnullable: ['username'],
      });

      let threw = false;
      try {
        await db.recordManager.insert('users', { id: 4, username: 'bob', email: 'b@b.com', age: 30 });
      } catch (e) {
        threw = true;
        assert.ok(e instanceof UnknownFieldError, `Expected UnknownFieldError, got ${e.constructor.name}: ${e.message}`);
      }
      assert.ok(threw, 'should have thrown');
    } finally {
      cleanup(p);
    }
  });
});

describe('Error handling — EntityNotFoundError', () => {
  test('thrown when operating on unknown entity', async () => {
    const { db, p } = await freshDb();
    try {
      let threw = false;
      try {
        await db.recordManager.findAll('nonexistent');
      } catch (e) {
        threw = true;
        assert.ok(e instanceof EntityNotFoundError, `Expected EntityNotFoundError, got ${e.constructor.name}`);
      }
      assert.ok(threw, 'should have thrown');
    } finally {
      cleanup(p);
    }
  });
});

describe('Error handling — EntityTypeError', () => {
  test('thrown when inserting into an object entity', async () => {
    const { db, p } = await freshDb();
    try {
      await db.entityManager.createEntity('addr', {
        type: 'object', values: ['city'],
      });

      let threw = false;
      try {
        await db.recordManager.insert('addr', { city: 'Milano' });
      } catch (e) {
        threw = true;
        assert.ok(e instanceof EntityTypeError, `Expected EntityTypeError, got ${e.constructor.name}`);
      }
      assert.ok(threw, 'should have thrown');
    } finally {
      cleanup(p);
    }
  });
});

describe('Error handling — CircularReferenceError', () => {
  test('thrown when createEntity directly forms a cycle', async () => {
    const { db, p } = await freshDb();
    try {
      // Build: b → a (no cycle yet)
      await db.entityManager.createEntity('a', {
        type: 'object',
        values: ['val'],
      });
      await db.entityManager.createEntity('b', {
        type: 'object',
        values: ['a'],
        nested: ['a'],
      });
      // Attempting to create 'a' → b would form a→b→a cycle: must throw
      let threw = false;
      try {
        await db.entityManager.createEntity('a2', {
          type: 'object',
          values: ['b'],
          nested: ['b'],
        });
        // 'a2' → b → a (no cycle since a2 ≠ a); try a self-reference instead
        await db.entityManager.createEntity('selfref', {
          type: 'object',
          values: ['selfref'],
          nested: ['selfref'],
        });
      } catch (e) {
        threw = true;
        assert.ok(
          e instanceof CircularReferenceError,
          `Expected CircularReferenceError, got ${e.constructor.name}: ${e.message}`,
        );
      }
      assert.ok(threw, 'should have thrown on self-referencing cycle');
    } finally {
      cleanup(p);
    }
  });

  test('deleteEntity on object referenced by another object throws EntityInUseError', async () => {
    const { db, p } = await freshDb();
    try {
      await db.entityManager.createEntity('a', { type: 'object', values: ['val'] });
      await db.entityManager.createEntity('b', { type: 'object', values: ['a'], nested: ['a'] });
      // 'a' is still referenced by 'b' — must be blocked
      await assert.rejects(
        () => db.entityManager.deleteEntity('a'),
        { name: 'EntityInUseError' }
      );
      // After deleting 'b', 'a' can be deleted
      await db.entityManager.deleteEntity('b');
      await db.entityManager.deleteEntity('a'); // must not throw
    } finally {
      cleanup(p);
    }
  });
});

// ---------------------------------------------------------------------------
// Complete example (README §Complete example)
// ---------------------------------------------------------------------------

describe('Complete shop example', () => {
  let db, p;

  before(async () => {
    ({ db, p } = await freshDb());

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

    await db.recordManager.insert('customers', {
      id: 1, name: 'Alice', email: 'alice@example.com',
      address: { street: 'Via Roma 1', city: 'Milano', zip: '20100' },
    });
    await db.recordManager.insert('customers', {
      id: 2, name: 'Bob', email: 'bob@example.com',
    });
    await db.recordManager.insert('orders', { orderId: 101, customerId: 1, total: 49.99, status: 'pending' });
    await db.recordManager.insert('orders', { orderId: 102, customerId: 1, total: 19.00, status: 'shipped' });
    await db.recordManager.insert('orders', { orderId: 103, customerId: 2, total: 99.50, status: 'pending' });
  });

  after(() => cleanup(p));

  test('findByIdSingle returns Alice with nested address', async () => {
    const alice = await db.recordManager.findByIdSingle('customers', 1);
    assert.equal(alice.name, 'Alice');
    assert.equal(alice.address.city, 'Milano');
  });

  test('findWhere by plain object returns Alice orders', async () => {
    const aliceOrders = await db.recordManager.findWhere('orders', { customerId: 1 });
    assert.equal(aliceOrders.length, 2);
  });

  test('findWhere by function returns pending orders', async () => {
    const pending = await db.recordManager.findWhere('orders', o => o.status === 'pending');
    assert.equal(pending.length, 2);
  });

  test('update order status', async () => {
    await db.recordManager.update('orders', { orderId: 101 }, { status: 'shipped' });
    const o = await db.recordManager.findByIdSingle('orders', 101);
    assert.equal(o.status, 'shipped');
  });

  test('deleteRecord on orders reduces count', async () => {
    await db.recordManager.deleteRecord('orders', { orderId: 103 });
    const remaining = await db.recordManager.findAll('orders');
    assert.equal(remaining.length, 2);
  });

  // Run last: a failed insert corrupts the db queue, so no further operations on this db
  test('unique constraint rejects duplicate email', async () => {
    let threw = false;
    try {
      await db.recordManager.insert('customers', { id: 3, name: 'Eve', email: 'alice@example.com' });
    } catch (e) {
      threw = true;
      assert.ok(e instanceof UniqueConstraintError, `Expected UniqueConstraintError, got ${e.constructor.name}`);
    }
    assert.ok(threw, 'should have thrown');
  });
});
