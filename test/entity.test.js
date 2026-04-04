'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  Database,
  EntityNotFoundError,
  EntityAlreadyExistsError,
  EntityTypeError,
  EntityInUseError,
  InvalidIdError,
  CircularReferenceError,
} = require('../index');

let tmpDir;
let db;

async function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitreousdb-entity-'));
  db = await Database.create(path.join(tmpDir, 'db.json'));
}

async function cleanup() {
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('createEntity', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('creates a table entity successfully', async () => {
    const config = await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id', 'name'],
    });
    assert.equal(config.type, 'table');
    assert.deepEqual(config.id, ['id']);
    assert.ok(config.notnullable.includes('id'));
    assert.ok(config.unique.includes('id'));
  });

  test('auto-adds id fields to notnullable and unique', async () => {
    const config = await db.entityManager.createEntity('products', {
      type: 'table',
      id: ['sku'],
      values: ['sku', 'name'],
    });
    assert.ok(config.notnullable.includes('sku'));
    assert.ok(config.unique.includes('sku'));
  });

  test('creates an object entity successfully', async () => {
    const config = await db.entityManager.createEntity('address', {
      type: 'object',
      values: ['street', 'city'],
    });
    assert.equal(config.type, 'object');
  });

  test('throws EntityAlreadyExistsError on duplicate name', async () => {
    await db.entityManager.createEntity('users', { type: 'table', values: ['id'], id: ['id'] });
    await assert.rejects(
      () => db.entityManager.createEntity('users', { type: 'table', values: ['id'] }),
      EntityAlreadyExistsError
    );
  });

  test('throws InvalidIdError when id field is also nested', async () => {
    await db.entityManager.createEntity('addr', { type: 'object', values: ['city'] });
    await assert.rejects(
      () => db.entityManager.createEntity('orders', {
        type: 'table',
        id: ['addr'],
        values: ['addr'],
        nested: ['addr'],
      }),
      InvalidIdError
    );
  });

  test('throws InvalidIdError when object entity has id', async () => {
    await assert.rejects(
      () => db.entityManager.createEntity('tag', {
        type: 'object',
        id: ['id'],
        values: ['id', 'label'],
      }),
      InvalidIdError
    );
  });

  test('throws EntityNotFoundError when nested field entity does not exist', async () => {
    await assert.rejects(
      () => db.entityManager.createEntity('orders', {
        type: 'table',
        values: ['id', 'address'],
        nested: ['address'],
      }),
      EntityNotFoundError
    );
  });

  test('throws EntityTypeError when nested field entity is not type object', async () => {
    await db.entityManager.createEntity('address', { type: 'table', values: ['city'], id: ['city'] });
    await assert.rejects(
      () => db.entityManager.createEntity('orders', {
        type: 'table',
        values: ['id', 'address'],
        nested: ['address'],
      }),
      EntityTypeError
    );
  });

  test('throws CircularReferenceError on direct cycle', async () => {
    await db.entityManager.createEntity('nodeA', { type: 'object', values: ['x'], nested: [] });
    // nodeB references nodeA (valid: nodeA is an object type and in nodeB's values)
    await db.entityManager.createEntity('nodeB', { type: 'object', values: ['nodeA'], nested: ['nodeA'] });
    // Inject a cycle back: nodeA now references nodeB (bypass createEntity to simulate corruption)
    const data = await db._read();
    data.entitiesConfiguration.nodeA.values.push('nodeB');
    data.entitiesConfiguration.nodeA.nested = ['nodeB'];
    await db._write(data);

    // Creating nodeC that references nodeB triggers DFS: nodeC -> nodeB -> nodeA -> nodeB = cycle
    await assert.rejects(
      () => db.entityManager.createEntity('nodeC', {
        type: 'table',
        values: ['nodeB'],
        nested: ['nodeB'],
      }),
      CircularReferenceError
    );
  });
});

describe('getEntity', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('returns config for existing entity', async () => {
    await db.entityManager.createEntity('items', { type: 'table', values: ['id'], id: ['id'] });
    const config = await db.entityManager.getEntity('items');
    assert.equal(config.type, 'table');
  });

  test('throws EntityNotFoundError for missing entity', async () => {
    await assert.rejects(
      () => db.entityManager.getEntity('ghost'),
      EntityNotFoundError
    );
  });
});

describe('listEntities', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('lists all entities', async () => {
    await db.entityManager.createEntity('addr', { type: 'object', values: ['city'] });
    await db.entityManager.createEntity('users', { type: 'table', values: ['id'], id: ['id'] });
    const all = await db.entityManager.listEntities();
    assert.ok(all.includes('addr'));
    assert.ok(all.includes('users'));
  });

  test('filters by type', async () => {
    await db.entityManager.createEntity('addr', { type: 'object', values: ['city'] });
    await db.entityManager.createEntity('users', { type: 'table', values: ['id'], id: ['id'] });
    const tables = await db.entityManager.listEntities('table');
    assert.ok(tables.includes('users'));
    assert.ok(!tables.includes('addr'));
  });
});

describe('deleteEntity', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('deletes a table entity and its records', async () => {
    await db.entityManager.createEntity('items', { type: 'table', values: ['id', 'name'], id: ['id'] });
    await db.recordManager.insert('items', { id: 1, name: 'thing' });
    await db.entityManager.deleteEntity('items');

    await assert.rejects(() => db.entityManager.getEntity('items'), EntityNotFoundError);
    const data = await db._read();
    assert.equal(data.entities.items, undefined);
  });

  test('deletes an object entity not in use', async () => {
    await db.entityManager.createEntity('tag', { type: 'object', values: ['label'] });
    await db.entityManager.deleteEntity('tag');
    await assert.rejects(() => db.entityManager.getEntity('tag'), EntityNotFoundError);
  });

  test('throws EntityInUseError when object entity is still referenced', async () => {
    await db.entityManager.createEntity('addr', { type: 'object', values: ['city'] });
    await db.entityManager.createEntity('users', {
      type: 'table',
      values: ['id', 'addr'],
      id: ['id'],
      nested: ['addr'],
    });
    await assert.rejects(
      () => db.entityManager.deleteEntity('addr'),
      EntityInUseError
    );
  });

  test('throws EntityNotFoundError for missing entity', async () => {
    await assert.rejects(
      () => db.entityManager.deleteEntity('ghost'),
      EntityNotFoundError
    );
  });
});
