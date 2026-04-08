'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  Database,
  EntityNotFoundError,
  UnknownFieldError,
  NullConstraintError,
  UniqueConstraintError,
  NestedTypeError,
  InvalidIdError,
} = require('../index');

let tmpDir;
let db;

async function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitreousdb-record-'));
  db = await Database.create(path.join(tmpDir, 'db.json'));

  await db.entityManager.createEntity('address', {
    type: 'object',
    values: ['street', 'city'],
    notnullable: ['city'],
  });

  await db.entityManager.createEntity('users', {
    type: 'table',
    id: ['id'],
    values: ['id', 'name', 'email', 'address'],
    notnullable: ['name'],
    unique: ['email'],
    nested: ['address'],
  });
}

async function cleanup() {
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('insert', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('inserts a valid record', async () => {
    const rec = await db.recordManager.insert('users', { id: 1, name: 'Alice', email: 'a@x.com' });
    assert.equal(rec.id, 1);
    assert.equal(rec.name, 'Alice');
  });

  test('inserts with nested object', async () => {
    const rec = await db.recordManager.insert('users', {
      id: 1,
      name: 'Alice',
      address: { street: 'Via Roma', city: 'Milano' },
    });
    assert.equal(rec.address.city, 'Milano');
  });

  test('throws UnknownFieldError for unknown field', async () => {
    await assert.rejects(
      () => db.recordManager.insert('users', { id: 1, name: 'Alice', unknown: 'x' }),
      UnknownFieldError
    );
  });

  test('throws NullConstraintError for null notnullable field', async () => {
    await assert.rejects(
      () => db.recordManager.insert('users', { id: 1, name: null }),
      NullConstraintError
    );
  });

  test('throws UniqueConstraintError for duplicate unique field', async () => {
    await db.recordManager.insert('users', { id: 1, name: 'Alice', email: 'a@x.com' });
    await assert.rejects(
      () => db.recordManager.insert('users', { id: 2, name: 'Bob', email: 'a@x.com' }),
      UniqueConstraintError
    );
  });

  test('throws NestedTypeError for non-object nested field', async () => {
    await assert.rejects(
      () => db.recordManager.insert('users', { id: 1, name: 'Alice', address: 'not an object' }),
      NestedTypeError
    );
  });
});

describe('findById', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('finds a record by id object', async () => {
    await db.recordManager.insert('users', { id: 1, name: 'Alice' });
    const found = await db.recordManager.findById('users', { id: 1 });
    assert.equal(found.name, 'Alice');
  });

  test('returns null if not found', async () => {
    const found = await db.recordManager.findById('users', { id: 999 });
    assert.equal(found, null);
  });

  test('key order does not matter', async () => {
    await db.entityManager.createEntity('orders', {
      type: 'table',
      id: ['userId', 'orderId'],
      values: ['userId', 'orderId', 'total'],
    });
    await db.recordManager.insert('orders', { userId: 1, orderId: 42, total: 100 });
    const found = await db.recordManager.findById('orders', { orderId: 42, userId: 1 });
    assert.equal(found.total, 100);
  });
});

describe('findByIdSingle', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('finds a record by single value', async () => {
    await db.recordManager.insert('users', { id: 5, name: 'Carol' });
    const found = await db.recordManager.findByIdSingle('users', 5);
    assert.equal(found.name, 'Carol');
  });

  test('throws InvalidIdError on composite id entity', async () => {
    await db.entityManager.createEntity('orders', {
      type: 'table',
      id: ['userId', 'orderId'],
      values: ['userId', 'orderId'],
    });
    await assert.rejects(
      () => db.recordManager.findByIdSingle('orders', 1),
      InvalidIdError
    );
  });
});

describe('findAll', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('returns empty array when no records', async () => {
    const all = await db.recordManager.findAll('users');
    assert.deepEqual(all, []);
  });

  test('returns all inserted records', async () => {
    await db.recordManager.insert('users', { id: 1, name: 'Alice' });
    await db.recordManager.insert('users', { id: 2, name: 'Bob' });
    const all = await db.recordManager.findAll('users');
    assert.equal(all.length, 2);
  });
});

describe('findWhere', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('filters by function predicate', async () => {
    await db.recordManager.insert('users', { id: 1, name: 'Alice' });
    await db.recordManager.insert('users', { id: 2, name: 'Bob' });
    const result = await db.recordManager.findWhere('users', r => r.name === 'Alice');
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'Alice');
  });

  test('filters by plain object predicate', async () => {
    await db.recordManager.insert('users', { id: 1, name: 'Alice' });
    await db.recordManager.insert('users', { id: 2, name: 'Bob' });
    const result = await db.recordManager.findWhere('users', { name: 'Bob' });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 2);
  });

  test('filters by nested plain object predicate', async () => {
    await db.recordManager.insert('users', { id: 1, name: 'Alice', address: { street: 'Via Roma', city: 'Milano' } });
    await db.recordManager.insert('users', { id: 2, name: 'Bob', address: { street: 'Rue de Rivoli', city: 'Paris' } });
    const result = await db.recordManager.findWhere('users', { address: { city: 'Milano' } });
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'Alice');
  });

  test('nested predicate does not match partial object value', async () => {
    await db.recordManager.insert('users', { id: 1, name: 'Alice', address: { street: 'Via Roma', city: 'Milano' } });
    const result = await db.recordManager.findWhere('users', { address: { city: 'Roma' } });
    assert.equal(result.length, 0);
  });

  test('throws TypeError for invalid predicate', async () => {
    await assert.rejects(
      () => db.recordManager.findWhere('users', 'invalid'),
      TypeError
    );
  });
});

describe('update', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('merges updates into existing record', async () => {
    await db.recordManager.insert('users', { id: 1, name: 'Alice', email: 'a@x.com' });
    const updated = await db.recordManager.update('users', { id: 1 }, { name: 'Alice B.' });
    assert.equal(updated.name, 'Alice B.');
    assert.equal(updated.email, 'a@x.com');
  });

  test('throws InvalidIdError when updating id field', async () => {
    await db.recordManager.insert('users', { id: 1, name: 'Alice' });
    await assert.rejects(
      () => db.recordManager.update('users', { id: 1 }, { id: 99 }),
      InvalidIdError
    );
  });

  test('throws EntityNotFoundError when record not found', async () => {
    await assert.rejects(
      () => db.recordManager.update('users', { id: 999 }, { name: 'Ghost' }),
      EntityNotFoundError
    );
  });

  test('unique constraint still applied on update', async () => {
    await db.recordManager.insert('users', { id: 1, name: 'Alice', email: 'a@x.com' });
    await db.recordManager.insert('users', { id: 2, name: 'Bob', email: 'b@x.com' });
    await assert.rejects(
      () => db.recordManager.update('users', { id: 2 }, { email: 'a@x.com' }),
      UniqueConstraintError
    );
  });
});

describe('unique constraint on nested fields', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitreousdb-unique-nested-'));
    db = await Database.create(path.join(tmpDir, 'db.json'));

    await db.entityManager.createEntity('address', {
      type: 'object',
      values: ['street', 'city'],
      notnullable: ['city'],
    });

    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'name', 'address'],
      notnullable: ['name'],
      unique: ['address'],
      nested: ['address'],
    });
  });
  afterEach(cleanup);

  test('allows two records with different nested values', async () => {
    await db.recordManager.insert('users', { id: 1, name: 'Alice', address: { street: 'Via Roma', city: 'Milano' } });
    const rec = await db.recordManager.insert('users', { id: 2, name: 'Bob', address: { street: 'Via Roma', city: 'Roma' } });
    assert.equal(rec.id, 2);
  });

  test('throws UniqueConstraintError for duplicate nested value', async () => {
    await db.recordManager.insert('users', { id: 1, name: 'Alice', address: { street: 'Via Roma', city: 'Milano' } });
    await assert.rejects(
      () => db.recordManager.insert('users', { id: 2, name: 'Bob', address: { street: 'Via Roma', city: 'Milano' } }),
      UniqueConstraintError
    );
  });

  test('deep equality is key-order independent', async () => {
    await db.recordManager.insert('users', { id: 1, name: 'Alice', address: { street: 'Via Roma', city: 'Milano' } });
    await assert.rejects(
      () => db.recordManager.insert('users', { id: 2, name: 'Bob', address: { city: 'Milano', street: 'Via Roma' } }),
      UniqueConstraintError
    );
  });

  test('unique constraint on nested field respected on update', async () => {
    await db.recordManager.insert('users', { id: 1, name: 'Alice', address: { street: 'Via Roma', city: 'Milano' } });
    await db.recordManager.insert('users', { id: 2, name: 'Bob', address: { street: 'Rue de Rivoli', city: 'Paris' } });
    await assert.rejects(
      () => db.recordManager.update('users', { id: 2 }, { address: { street: 'Via Roma', city: 'Milano' } }),
      UniqueConstraintError
    );
  });
});

describe('deleteRecord', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('deletes and returns the record', async () => {
    await db.recordManager.insert('users', { id: 1, name: 'Alice' });
    const deleted = await db.recordManager.deleteRecord('users', { id: 1 });
    assert.equal(deleted.name, 'Alice');
    const all = await db.recordManager.findAll('users');
    assert.equal(all.length, 0);
  });

  test('throws EntityNotFoundError when record not found', async () => {
    await assert.rejects(
      () => db.recordManager.deleteRecord('users', { id: 999 }),
      EntityNotFoundError
    );
  });
});
