'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  Database,
  EntityNotFoundError,
  InvalidIdError,
  InvalidMigrationError,
  NullConstraintError,
  UniqueConstraintError,
} = require('../index');

let tmpDir;
let db;

async function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitreousdb-migration-'));
  db = await Database.create(path.join(tmpDir, 'db.json'));
}

async function cleanup() {
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// addField
// ---------------------------------------------------------------------------

describe('addField', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('adds a new optional field to a table entity', async () => {
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'name'],
    });
    const config = await db.entityManager.addField('users', 'email');
    assert.ok(config.values.includes('email'));
  });

  test('newly added field is optional — existing records are unaffected', async () => {
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'name'],
    });
    await db.recordManager.insert('users', { id: 1, name: 'Alice' });
    await db.entityManager.addField('users', 'email');
    const record = await db.recordManager.findByIdSingle('users', 1);
    assert.equal(record.name, 'Alice');
    assert.equal(record.email, undefined);
  });

  test('can insert with the new field after addField', async () => {
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'name'],
    });
    await db.entityManager.addField('users', 'email');
    const r = await db.recordManager.insert('users', { id: 1, name: 'Alice', email: 'a@b.com' });
    assert.equal(r.email, 'a@b.com');
  });

  test('adds a field to an object entity', async () => {
    await db.entityManager.createEntity('address', {
      type: 'object',
      values: ['city'],
    });
    const config = await db.entityManager.addField('address', 'zip');
    assert.ok(config.values.includes('zip'));
  });

  test('throws InvalidMigrationError if field already exists', async () => {
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'name'],
    });
    await assert.rejects(
      () => db.entityManager.addField('users', 'name'),
      (e) => {
        assert.ok(e instanceof InvalidMigrationError);
        assert.equal(e.entityName, 'users');
        return true;
      }
    );
  });

  test('throws EntityNotFoundError if entity does not exist', async () => {
    await assert.rejects(
      () => db.entityManager.addField('nonexistent', 'field'),
      EntityNotFoundError
    );
  });

  test('returned config is a clone — mutating it does not affect stored config', async () => {
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'name'],
    });
    const config = await db.entityManager.addField('users', 'email');
    config.values.push('MUTATED');
    const stored = await db.entityManager.getEntity('users');
    assert.ok(!stored.values.includes('MUTATED'));
  });
});

// ---------------------------------------------------------------------------
// removeField
// ---------------------------------------------------------------------------

describe('removeField', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('removes a field from a table entity', async () => {
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'name', 'legacy'],
    });
    await db.entityManager.removeField('users', 'legacy');
    const config = await db.entityManager.getEntity('users');
    assert.ok(!config.values.includes('legacy'));
  });

  test('strips the removed field from all existing records', async () => {
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'name', 'legacy'],
    });
    await db.recordManager.insert('users', { id: 1, name: 'Alice', legacy: 'old' });
    await db.recordManager.insert('users', { id: 2, name: 'Bob', legacy: 'data' });
    await db.entityManager.removeField('users', 'legacy');
    const records = await db.recordManager.findAll('users');
    for (const r of records) {
      assert.equal(Object.prototype.hasOwnProperty.call(r, 'legacy'), false);
    }
  });

  test('also removes field from notnullable, unique, nested arrays', async () => {
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'name', 'email'],
      notnullable: ['name'],
      unique: ['email'],
    });
    // Add notnullable on email by direct addConstraint so we can remove it
    await db.entityManager.addConstraint('users', 'notnullable', ['email']);
    await db.entityManager.removeField('users', 'email');
    const config = await db.entityManager.getEntity('users');
    assert.ok(!config.values.includes('email'));
    assert.ok(!config.notnullable.includes('email'));
    assert.ok(!config.unique.includes('email'));
  });

  test('throws InvalidIdError when trying to remove an id field', async () => {
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'name'],
    });
    await assert.rejects(
      () => db.entityManager.removeField('users', 'id'),
      (e) => {
        assert.ok(e instanceof InvalidIdError);
        assert.equal(e.entityName, 'users');
        return true;
      }
    );
  });

  test('throws InvalidMigrationError if field does not exist', async () => {
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'name'],
    });
    await assert.rejects(
      () => db.entityManager.removeField('users', 'nonexistent'),
      (e) => {
        assert.ok(e instanceof InvalidMigrationError);
        assert.equal(e.entityName, 'users');
        return true;
      }
    );
  });

  test('throws EntityNotFoundError if entity does not exist', async () => {
    await assert.rejects(
      () => db.entityManager.removeField('nonexistent', 'field'),
      EntityNotFoundError
    );
  });

  test('removing field from entity with no records is safe', async () => {
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'name', 'extra'],
    });
    await db.entityManager.removeField('users', 'extra');
    const config = await db.entityManager.getEntity('users');
    assert.ok(!config.values.includes('extra'));
  });
});

// ---------------------------------------------------------------------------
// addConstraint
// ---------------------------------------------------------------------------

describe('addConstraint', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('adds notnullable constraint when all existing records satisfy it', async () => {
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'name'],
    });
    await db.recordManager.insert('users', { id: 1, name: 'Alice' });
    await db.recordManager.insert('users', { id: 2, name: 'Bob' });
    await db.entityManager.addConstraint('users', 'notnullable', ['name']);
    const config = await db.entityManager.getEntity('users');
    assert.ok(config.notnullable.includes('name'));
  });

  test('addConstraint notnullable is idempotent (field already in notnullable)', async () => {
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'name'],
      notnullable: ['name'],
    });
    await db.entityManager.addConstraint('users', 'notnullable', ['name']);
    const config = await db.entityManager.getEntity('users');
    assert.equal(config.notnullable.filter(f => f === 'name').length, 1);
  });

  test('throws NullConstraintError if a record has null for the constrained field', async () => {
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'name'],
    });
    await db.recordManager.insert('users', { id: 1 }); // name is undefined
    await assert.rejects(
      () => db.entityManager.addConstraint('users', 'notnullable', ['name']),
      (e) => {
        assert.ok(e instanceof NullConstraintError);
        assert.equal(e.entityName, 'users');
        assert.equal(e.fieldName, 'name');
        return true;
      }
    );
  });

  test('adds unique constraint when all existing records satisfy it', async () => {
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'email'],
    });
    await db.recordManager.insert('users', { id: 1, email: 'a@b.com' });
    await db.recordManager.insert('users', { id: 2, email: 'b@c.com' });
    await db.entityManager.addConstraint('users', 'unique', ['email']);
    const config = await db.entityManager.getEntity('users');
    assert.ok(config.unique.includes('email'));
  });

  test('throws UniqueConstraintError if existing records violate uniqueness', async () => {
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'email'],
    });
    await db.recordManager.insert('users', { id: 1, email: 'dup@b.com' });
    await db.recordManager.insert('users', { id: 2, email: 'dup@b.com' });
    await assert.rejects(
      () => db.entityManager.addConstraint('users', 'unique', ['email']),
      (e) => {
        assert.ok(e instanceof UniqueConstraintError);
        assert.equal(e.entityName, 'users');
        assert.equal(e.fieldName, 'email');
        return true;
      }
    );
  });

  test('null values are not considered duplicates for unique constraint safety check', async () => {
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'email'],
    });
    await db.recordManager.insert('users', { id: 1 }); // email undefined
    await db.recordManager.insert('users', { id: 2 }); // email undefined
    // should not throw — null/undefined is "absent" for unique
    await db.entityManager.addConstraint('users', 'unique', ['email']);
    const config = await db.entityManager.getEntity('users');
    assert.ok(config.unique.includes('email'));
  });

  test('throws InvalidMigrationError for unknown constraint type', async () => {
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'name'],
    });
    await assert.rejects(
      () => db.entityManager.addConstraint('users', 'index', ['name']),
      (e) => {
        assert.ok(e instanceof InvalidMigrationError);
        return true;
      }
    );
  });

  test('throws InvalidMigrationError when adding unique to an object entity', async () => {
    await db.entityManager.createEntity('address', {
      type: 'object',
      values: ['city'],
    });
    await assert.rejects(
      () => db.entityManager.addConstraint('address', 'unique', ['city']),
      (e) => {
        assert.ok(e instanceof InvalidMigrationError);
        assert.equal(e.entityName, 'address');
        return true;
      }
    );
  });

  test('throws InvalidMigrationError if constrained field not in values', async () => {
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'name'],
    });
    await assert.rejects(
      () => db.entityManager.addConstraint('users', 'notnullable', ['nonexistent']),
      (e) => {
        assert.ok(e instanceof InvalidMigrationError);
        return true;
      }
    );
  });

  test('throws EntityNotFoundError if entity does not exist', async () => {
    await assert.rejects(
      () => db.entityManager.addConstraint('nonexistent', 'notnullable', ['field']),
      EntityNotFoundError
    );
  });

  test('InvalidMigrationError has entityName and reason properties', async () => {
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'name'],
    });
    try {
      await db.entityManager.addField('users', 'name');
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof InvalidMigrationError);
      assert.equal(e.entityName, 'users');
      assert.ok(typeof e.reason === 'string' && e.reason.length > 0);
      assert.equal(e.name, 'InvalidMigrationError');
    }
  });
});
