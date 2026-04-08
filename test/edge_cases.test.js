'use strict';

/**
 * Edge cases not covered by the primary test suite:
 *
 * Validator:
 *   - Empty record passes when no notnullable fields are present
 *   - Falsy-but-not-null values (0, false, "") satisfy notnullable
 *   - null nested field → NestedTypeError (not just wrong type, but null)
 *   - Multi-level nested validation (object inside object)
 *   - validateNestedObject: nested entity missing from config → EntityNotFoundError
 *   - unique check skipped when the field is absent from the record (undefined)
 *
 * EntityManager:
 *   - createEntity: duplicate entries in the values array → TypeError
 *   - createEntity: notnullable field not in values → TypeError
 *   - createEntity: unique field not in values → TypeError
 *   - createEntity: id dedup (id field already in notnullable/unique → no duplicate in normalized arrays)
 *   - createEntity: multiple nested fields pointing to different object entities
 *   - listEntities on empty DB → []
 *   - deleteEntity on table that never had records inserted (no entities key) → no crash
 *
 * RecordManager:
 *   - insert returns a clone (mutation of the result does not affect the DB)
 *   - findAll returns clones (mutation of results does not affect the DB)
 *   - findByIdSingle returns null when no match
 *   - findWhere returns empty array when no record matches
 *   - findWhere with null predicate → TypeError
 *   - findById with a non-id field in idObject → InvalidIdError
 *   - update on a nested field
 *   - deleteRecord with composite id
 *   - insert on entity with no id configured (id = [])
 *
 * Database:
 *   - flush() in non-eager mode is a no-op (does not throw)
 *   - close() in non-eager mode disables further operations
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { validateRecord, validateNestedObject, detectCircularReference } = require('../src/Validator');
const {
  EntityNotFoundError,
  NullConstraintError,
  NestedTypeError,
  FileAccessError,
  InvalidIdError,
} = require('../src/errors');
const { Database } = require('../index');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;
let db;

async function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitreousdb-edge-'));
  db = await Database.create(path.join(tmpDir, 'db.json'));
}

async function cleanup() {
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Validator — edge cases
// ---------------------------------------------------------------------------

describe('Validator — falsy values and empty records', () => {
  function data() {
    return {
      entitiesConfiguration: {
        items: {
          type: 'table',
          id: ['id'],
          values: ['id', 'count', 'active', 'label'],
          notnullable: ['id'],
          unique: ['id'],
          nested: [],
        },
      },
      entities: { items: [] },
    };
  }

  test('empty record passes when only id is notnullable and id is provided', () => {
    const d = data();
    assert.doesNotThrow(() => validateRecord('items', { id: 1 }, d));
  });

  test('value 0 satisfies notnullable', () => {
    const d = data();
    d.entitiesConfiguration.items.notnullable.push('count');
    assert.doesNotThrow(() => validateRecord('items', { id: 1, count: 0 }, d));
  });

  test('value false satisfies notnullable', () => {
    const d = data();
    d.entitiesConfiguration.items.notnullable.push('active');
    assert.doesNotThrow(() => validateRecord('items', { id: 1, active: false }, d));
  });

  test('empty string satisfies notnullable', () => {
    const d = data();
    d.entitiesConfiguration.items.notnullable.push('label');
    assert.doesNotThrow(() => validateRecord('items', { id: 1, label: '' }, d));
  });

  test('unique check is skipped when the field is absent from the record', () => {
    const d = data();
    d.entities.items = [{ id: 1, label: 'hello' }];
    // label is in unique; new record omits it entirely — should not throw
    d.entitiesConfiguration.items.unique.push('label');
    assert.doesNotThrow(() => validateRecord('items', { id: 2 }, d));
  });
});

describe('Validator — null nested field', () => {
  function data() {
    return {
      entitiesConfiguration: {
        users: {
          type: 'table',
          id: ['id'],
          values: ['id', 'address'],
          notnullable: ['id'],
          unique: ['id'],
          nested: ['address'],
        },
        address: {
          type: 'object',
          values: ['city'],
          notnullable: ['city'],
          unique: [],
          nested: [],
        },
      },
      entities: { users: [] },
    };
  }

  test('null on an optional nested field is valid (explicitly clears the field)', () => {
    const d = data();
    // null is allowed for non-notnullable nested fields (BUG-06 fix)
    assert.doesNotThrow(
      () => validateRecord('users', { id: 1, address: null }, d)
    );
  });
});

describe('Validator — multi-level nested', () => {
  function data() {
    return {
      entitiesConfiguration: {
        orders: {
          type: 'table',
          id: ['id'],
          values: ['id', 'shipping'],
          notnullable: ['id'],
          unique: ['id'],
          nested: ['shipping'],
        },
        shipping: {
          type: 'object',
          values: ['address'],
          notnullable: [],
          unique: [],
          nested: ['address'],
        },
        address: {
          type: 'object',
          values: ['city'],
          notnullable: ['city'],
          unique: [],
          nested: [],
        },
      },
      entities: { orders: [] },
    };
  }

  test('valid multi-level nested object passes', () => {
    const d = data();
    assert.doesNotThrow(() =>
      validateRecord('orders', { id: 1, shipping: { address: { city: 'Milano' } } }, d)
    );
  });

  test('nested constraint violation at depth-2 throws NullConstraintError', () => {
    const d = data();
    assert.throws(
      () => validateRecord('orders', { id: 1, shipping: { address: { city: null } } }, d),
      NullConstraintError
    );
  });
});

describe('validateNestedObject — direct call edge cases', () => {
  test('throws EntityNotFoundError when nested entity config is missing', () => {
    const d = {
      entitiesConfiguration: {},
      entities: {},
    };
    assert.throws(
      () => validateNestedObject('missing', { field: 'x' }, d),
      EntityNotFoundError
    );
  });
});

// ---------------------------------------------------------------------------
// EntityManager — edge cases
// ---------------------------------------------------------------------------

describe('EntityManager — createEntity config validation', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('throws TypeError when values array has duplicates', async () => {
    await assert.rejects(
      () => db.entityManager.createEntity('items', {
        type: 'table',
        values: ['id', 'id', 'name'],
      }),
      TypeError
    );
  });

  test('throws TypeError when notnullable field is not in values', async () => {
    await assert.rejects(
      () => db.entityManager.createEntity('items', {
        type: 'table',
        values: ['id', 'name'],
        notnullable: ['missing'],
      }),
      TypeError
    );
  });

  test('throws TypeError when unique field is not in values', async () => {
    await assert.rejects(
      () => db.entityManager.createEntity('items', {
        type: 'table',
        values: ['id', 'name'],
        unique: ['missing'],
      }),
      TypeError
    );
  });

  test('id normalization does not create duplicates in notnullable/unique', async () => {
    const config = await db.entityManager.createEntity('items', {
      type: 'table',
      id: ['id'],
      values: ['id', 'name'],
      notnullable: ['id'],  // already listed — must not appear twice
      unique: ['id'],       // already listed — must not appear twice
    });
    assert.equal(config.notnullable.filter(f => f === 'id').length, 1);
    assert.equal(config.unique.filter(f => f === 'id').length, 1);
  });

  test('createEntity with multiple nested fields pointing to different object entities', async () => {
    await db.entityManager.createEntity('billing', { type: 'object', values: ['amount'] });
    await db.entityManager.createEntity('shipping', { type: 'object', values: ['city'] });
    const config = await db.entityManager.createEntity('orders', {
      type: 'table',
      id: ['id'],
      values: ['id', 'billing', 'shipping'],
      nested: ['billing', 'shipping'],
    });
    assert.deepEqual(config.nested, ['billing', 'shipping']);
  });
});

describe('EntityManager — listEntities on empty DB', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('returns empty array when no entities exist', async () => {
    const all = await db.entityManager.listEntities();
    assert.deepEqual(all, []);
  });

  test('returns empty array when filtering type on empty DB', async () => {
    const tables = await db.entityManager.listEntities('table');
    assert.deepEqual(tables, []);
  });
});

describe('EntityManager — deleteEntity on table with no records', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('does not crash when deleting a table that never had records inserted', async () => {
    await db.entityManager.createEntity('ghosts', { type: 'table', values: ['id'], id: ['id'] });
    await assert.doesNotReject(() => db.entityManager.deleteEntity('ghosts'));
    const all = await db.entityManager.listEntities();
    assert.ok(!all.includes('ghosts'));
  });
});

// ---------------------------------------------------------------------------
// RecordManager — clone isolation
// ---------------------------------------------------------------------------

describe('RecordManager — clone isolation', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('mutating the record returned by insert does not affect the DB', async () => {
    await db.entityManager.createEntity('items', {
      type: 'table', id: ['id'], values: ['id', 'name'],
    });
    const rec = await db.recordManager.insert('items', { id: 1, name: 'original' });
    rec.name = 'mutated';

    const fromDb = await db.recordManager.findByIdSingle('items', 1);
    assert.equal(fromDb.name, 'original');
  });

  test('mutating a record returned by findAll does not affect the DB', async () => {
    await db.entityManager.createEntity('items', {
      type: 'table', id: ['id'], values: ['id', 'name'],
    });
    await db.recordManager.insert('items', { id: 1, name: 'original' });
    const all = await db.recordManager.findAll('items');
    all[0].name = 'mutated';

    const fromDb = await db.recordManager.findByIdSingle('items', 1);
    assert.equal(fromDb.name, 'original');
  });
});

// ---------------------------------------------------------------------------
// RecordManager — find edge cases
// ---------------------------------------------------------------------------

describe('RecordManager — find edge cases', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('findByIdSingle returns null when record is not found', async () => {
    await db.entityManager.createEntity('items', {
      type: 'table', id: ['id'], values: ['id', 'name'],
    });
    const result = await db.recordManager.findByIdSingle('items', 999);
    assert.equal(result, null);
  });

  test('findWhere returns empty array when no records match', async () => {
    await db.entityManager.createEntity('items', {
      type: 'table', id: ['id'], values: ['id', 'name'],
    });
    await db.recordManager.insert('items', { id: 1, name: 'alpha' });
    const result = await db.recordManager.findWhere('items', r => r.name === 'nonexistent');
    assert.deepEqual(result, []);
  });

  test('findWhere with null predicate throws TypeError', async () => {
    await db.entityManager.createEntity('items', {
      type: 'table', id: ['id'], values: ['id'],
    });
    await assert.rejects(
      () => db.recordManager.findWhere('items', null),
      TypeError
    );
  });

  test('findById with a non-id field in idObject throws InvalidIdError', async () => {
    await db.entityManager.createEntity('items', {
      type: 'table', id: ['id'], values: ['id', 'name'],
    });
    await db.recordManager.insert('items', { id: 1, name: 'alpha' });
    await assert.rejects(
      () => db.recordManager.findById('items', { name: 'alpha' }),
      InvalidIdError
    );
  });
});

// ---------------------------------------------------------------------------
// RecordManager — update edge cases
// ---------------------------------------------------------------------------

describe('RecordManager — update edge cases', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('update on a nested field replaces the object and validates it', async () => {
    await db.entityManager.createEntity('address', {
      type: 'object', values: ['city'], notnullable: ['city'],
    });
    await db.entityManager.createEntity('users', {
      type: 'table', id: ['id'], values: ['id', 'address'], nested: ['address'],
    });
    await db.recordManager.insert('users', { id: 1, address: { city: 'Milano' } });
    const updated = await db.recordManager.update('users', { id: 1 }, { address: { city: 'Roma' } });
    assert.equal(updated.address.city, 'Roma');
  });

  test('update nested field with invalid value throws NestedTypeError', async () => {
    await db.entityManager.createEntity('address', {
      type: 'object', values: ['city'], notnullable: ['city'],
    });
    await db.entityManager.createEntity('users', {
      type: 'table', id: ['id'], values: ['id', 'address'], nested: ['address'],
    });
    await db.recordManager.insert('users', { id: 1, address: { city: 'Milano' } });
    await assert.rejects(
      () => db.recordManager.update('users', { id: 1 }, { address: 'not-an-object' }),
      NestedTypeError
    );
  });
});

// ---------------------------------------------------------------------------
// RecordManager — composite id deleteRecord
// ---------------------------------------------------------------------------

describe('RecordManager — deleteRecord with composite id', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('deletes the correct record by composite id', async () => {
    // NOTE: because each id field is auto-added to unique individually,
    // all id field values must be globally unique across all records.
    // Composite tuple uniqueness is not supported — this is a known design limitation.
    await db.entityManager.createEntity('lines', {
      type: 'table',
      id: ['orderId', 'lineId'],
      values: ['orderId', 'lineId', 'qty'],
    });
    await db.recordManager.insert('lines', { orderId: 10, lineId: 100, qty: 2 });
    await db.recordManager.insert('lines', { orderId: 20, lineId: 200, qty: 5 });

    const deleted = await db.recordManager.deleteRecord('lines', { orderId: 10, lineId: 100 });
    assert.equal(deleted.qty, 2);

    const remaining = await db.recordManager.findAll('lines');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].orderId, 20);
  });
});

// ---------------------------------------------------------------------------
// RecordManager — entity with no id
// ---------------------------------------------------------------------------

describe('RecordManager — entity with no id field', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('createEntity table senza id field lancia TypeError', async () => {
    await assert.rejects(
      () => db.entityManager.createEntity('logs', {
        type: 'table',
        values: ['msg', 'level'],
        notnullable: ['msg'],
      }),
      TypeError
    );
  });
});

// ---------------------------------------------------------------------------
// Database — lifecycle edge cases
// ---------------------------------------------------------------------------

describe('Database — non-eager lifecycle', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitreousdb-lifecycle-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('flush() in non-eager mode is a no-op and does not throw', async () => {
    const dbPath = path.join(tmpDir, 'db.json');
    const d = await Database.create(dbPath);
    await assert.doesNotReject(() => d.flush());
    await d.close();
  });

  test('close() in non-eager mode disables further operations', async () => {
    const dbPath = path.join(tmpDir, 'db.json');
    const d = await Database.create(dbPath);
    await d.close();
    await assert.rejects(
      () => d.entityManager.listEntities(),
      FileAccessError
    );
  });
});
