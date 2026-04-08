'use strict';

/**
 * Tests not covered by the primary suite:
 *
 * Persistence:
 *   - Schema and records survive a full close + re-open of the same file
 *   - Records inserted in a first session are readable in a second session
 *
 * Concurrency (mutex):
 *   - Many concurrent inserts on the same instance produce no lost writes
 *     and no duplicate-id false positives (serialization via _enqueue)
 *
 * Error properties:
 *   - Each error class exposes the correct machine-readable properties
 *     (entityName, fieldName, value, reason, filePath, referencedBy, cycle)
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  Database,
  FileAccessError,
  EntityNotFoundError,
  EntityAlreadyExistsError,
  EntityTypeError,
  EntityInUseError,
  UnknownFieldError,
  NullConstraintError,
  UniqueConstraintError,
  NestedTypeError,
  InvalidIdError,
  CircularReferenceError,
} = require('../index');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

function mkdb() {
  return path.join(tmpDir, 'db.json');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitreousdb-persist-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Persistence across sessions
// ---------------------------------------------------------------------------

describe('Persistence across sessions', () => {
  test('schema survives close + re-open', async () => {
    const dbPath = mkdb();

    const db1 = await Database.create(dbPath);
    await db1.entityManager.createEntity('products', {
      type: 'table',
      id: ['sku'],
      values: ['sku', 'name', 'price'],
      notnullable: ['name'],
    });
    await db1.close();

    const db2 = await Database.create(dbPath);
    const config = await db2.entityManager.getEntity('products');
    assert.equal(config.type, 'table');
    assert.ok(config.values.includes('sku'));
    assert.ok(config.notnullable.includes('name'));
    assert.ok(config.notnullable.includes('sku')); // auto-normalized from id
    await db2.close();
  });

  test('records survive close + re-open', async () => {
    const dbPath = mkdb();

    const db1 = await Database.create(dbPath);
    await db1.entityManager.createEntity('products', {
      type: 'table',
      id: ['sku'],
      values: ['sku', 'name'],
    });
    await db1.recordManager.insert('products', { sku: 'A1', name: 'Widget' });
    await db1.recordManager.insert('products', { sku: 'A2', name: 'Gadget' });
    await db1.close();

    const db2 = await Database.create(dbPath);
    const all = await db2.recordManager.findAll('products');
    assert.equal(all.length, 2);
    const widget = await db2.recordManager.findByIdSingle('products', 'A1');
    assert.equal(widget.name, 'Widget');
    await db2.close();
  });

  test('deleted records are absent after re-open', async () => {
    const dbPath = mkdb();

    const db1 = await Database.create(dbPath);
    await db1.entityManager.createEntity('items', {
      type: 'table', id: ['id'], values: ['id', 'label'],
    });
    await db1.recordManager.insert('items', { id: 1, label: 'keep' });
    await db1.recordManager.insert('items', { id: 2, label: 'delete' });
    await db1.recordManager.deleteRecord('items', { id: 2 });
    await db1.close();

    const db2 = await Database.create(dbPath);
    const all = await db2.recordManager.findAll('items');
    assert.equal(all.length, 1);
    assert.equal(all[0].label, 'keep');
    await db2.close();
  });

  test('unique constraint is enforced across sessions', async () => {
    const dbPath = mkdb();

    const db1 = await Database.create(dbPath);
    await db1.entityManager.createEntity('users', {
      type: 'table', id: ['id'], values: ['id', 'email'], unique: ['email'],
    });
    await db1.recordManager.insert('users', { id: 1, email: 'a@x.com' });
    await db1.close();

    const db2 = await Database.create(dbPath);
    await assert.rejects(
      () => db2.recordManager.insert('users', { id: 2, email: 'a@x.com' }),
      UniqueConstraintError
    );
    await db2.close();
  });
});

// ---------------------------------------------------------------------------
// Eager mode persistence
// ---------------------------------------------------------------------------

describe('Eager mode — persistence', () => {
  test('data written in eager session is readable in a non-eager session', async () => {
    const dbPath = mkdb();

    const db1 = await Database.create(dbPath, { eager: true });
    await db1.entityManager.createEntity('notes', {
      type: 'table', id: ['id'], values: ['id', 'text'],
    });
    await db1.recordManager.insert('notes', { id: 1, text: 'hello' });
    await db1.close(); // flushes to disk

    const db2 = await Database.create(dbPath);
    const note = await db2.recordManager.findByIdSingle('notes', 1);
    assert.equal(note.text, 'hello');
    await db2.close();
  });

  test('data not flushed in eager session is absent on re-open', async () => {
    const dbPath = mkdb();

    const db1 = await Database.create(dbPath, { eager: true });
    await db1.entityManager.createEntity('temp', {
      type: 'table', id: ['id'], values: ['id'],
    });
    // do NOT flush — simulate premature abort (skip close)
    // We have to check the file still has the empty original structure
    const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    assert.deepEqual(raw, { entitiesConfiguration: {}, entities: {} });
    await db1.close(); // now flush properly for cleanup
  });
});

// ---------------------------------------------------------------------------
// Concurrency — mutex
// ---------------------------------------------------------------------------

describe('Concurrency — intra-process mutex', () => {
  test('concurrent inserts are all persisted without lost writes', async () => {
    const dbPath = mkdb();
    const db = await Database.create(dbPath);
    await db.entityManager.createEntity('counters', {
      type: 'table', id: ['id'], values: ['id', 'val'],
    });

    // Fire 20 inserts concurrently — the mutex must serialize them
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        db.recordManager.insert('counters', { id: i + 1, val: i + 1 })
      )
    );

    const all = await db.recordManager.findAll('counters');
    assert.equal(all.length, N);
    await db.close();
  });

  test('concurrent inserts do not produce false UniqueConstraintError', async () => {
    const dbPath = mkdb();
    const db = await Database.create(dbPath);
    await db.entityManager.createEntity('items', {
      type: 'table', id: ['id'], values: ['id', 'name'],
    });

    // All ids are distinct — none should throw
    await assert.doesNotReject(() =>
      Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          db.recordManager.insert('items', { id: i + 1, name: `item-${i}` })
        )
      )
    );
    await db.close();
  });

  test('concurrent insert of the same unique id — exactly one succeeds', async () => {
    const dbPath = mkdb();
    const db = await Database.create(dbPath);
    await db.entityManager.createEntity('users', {
      type: 'table', id: ['id'], values: ['id', 'name'],
    });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        db.recordManager.insert('users', { id: 1, name: 'Alice' })
      )
    );

    const succeeded = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(r => r.status === 'rejected');
    assert.equal(succeeded.length, 1);
    assert.equal(failed.length, 4);
    await db.close();
  });
});

// ---------------------------------------------------------------------------
// Error machine-readable properties
// ---------------------------------------------------------------------------

describe('Error machine-readable properties', () => {
  let db;
  let dbPath;

  beforeEach(async () => {
    dbPath = mkdb();
    db = await Database.create(dbPath);
    await db.entityManager.createEntity('addr', { type: 'object', values: ['city'] });
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'email', 'addr'],
      notnullable: ['id'],
      unique: ['email'],
      nested: ['addr'],
    });
    await db.recordManager.insert('users', { id: 1, email: 'a@x.com' });
  });

  afterEach(async () => {
    await db.close();
  });

  test('FileAccessError exposes filePath and reason', async () => {
    try {
      await Database.create('/nonexistent/path/db.json');
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof FileAccessError);
      assert.equal(typeof e.filePath, 'string');
      assert.equal(typeof e.reason, 'string');
    }
  });

  test('EntityNotFoundError exposes entityName', async () => {
    try {
      await db.entityManager.getEntity('ghost');
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof EntityNotFoundError);
      assert.equal(e.entityName, 'ghost');
    }
  });

  test('EntityAlreadyExistsError exposes entityName', async () => {
    try {
      await db.entityManager.createEntity('users', { type: 'table', values: ['id'] });
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof EntityAlreadyExistsError);
      assert.equal(e.entityName, 'users');
    }
  });

  test('EntityTypeError exposes entityName, expected, actual', async () => {
    try {
      await db.recordManager.insert('addr', { city: 'Roma' });
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof EntityTypeError);
      assert.equal(e.entityName, 'addr');
      assert.equal(e.expected, 'table');
      assert.equal(e.actual, 'object');
    }
  });

  test('EntityInUseError exposes entityName and referencedBy array', async () => {
    try {
      await db.entityManager.deleteEntity('addr');
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof EntityInUseError);
      assert.equal(e.entityName, 'addr');
      assert.ok(Array.isArray(e.referencedBy));
      assert.ok(e.referencedBy.includes('users'));
    }
  });

  test('UnknownFieldError exposes entityName and fieldName', async () => {
    try {
      await db.recordManager.insert('users', { id: 2, ghost: 'x' });
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof UnknownFieldError);
      assert.equal(e.entityName, 'users');
      assert.equal(e.fieldName, 'ghost');
    }
  });

  test('NullConstraintError exposes entityName and fieldName', async () => {
    try {
      await db.recordManager.insert('users', { id: null });
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof NullConstraintError);
      assert.equal(e.entityName, 'users');
      assert.equal(e.fieldName, 'id');
    }
  });

  test('UniqueConstraintError exposes entityName, fieldName, value', async () => {
    try {
      await db.recordManager.insert('users', { id: 2, email: 'a@x.com' });
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof UniqueConstraintError);
      assert.equal(e.entityName, 'users');
      assert.equal(e.fieldName, 'email');
      assert.equal(e.value, 'a@x.com');
    }
  });

  test('NestedTypeError exposes entityName and fieldName', async () => {
    try {
      await db.recordManager.insert('users', { id: 2, addr: 'not-an-object' });
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof NestedTypeError);
      assert.equal(e.entityName, 'users');
      assert.equal(e.fieldName, 'addr');
    }
  });

  test('InvalidIdError exposes entityName and reason', async () => {
    try {
      await db.recordManager.update('users', { id: 1 }, { id: 99 });
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof InvalidIdError);
      assert.equal(e.entityName, 'users');
      assert.equal(typeof e.reason, 'string');
    }
  });

  test('CircularReferenceError exposes entityName and cycle array', async () => {
    // inject a cycle manually then trigger createEntity
    const data = await db._read();
    data.entitiesConfiguration.addr.nested = ['addr'];
    await db._write(data);

    try {
      await db.entityManager.createEntity('newTable', {
        type: 'table',
        id: ['id'],
        values: ['id', 'addr'],
        nested: ['addr'],
      });
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof CircularReferenceError);
      assert.equal(typeof e.entityName, 'string');
      assert.ok(Array.isArray(e.cycle));
      assert.ok(e.cycle.length > 0);
    }
  });
});
