'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  Database,
  InvalidIdError,
  UniqueConstraintError,
  RecordNotFoundError,
  ShardKeyError,
} = require('../index');

let tmpDir;
let dbPath;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitreousdb-shard-'));
  dbPath = path.join(tmpDir, 'test.json');
}
function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('sharded — schema validation', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('requires shardKey', async () => {
    const db = await Database.create(dbPath);
    await assert.rejects(
      db.entityManager.createEntity('c', {
        type: 'sharded', values: ['code'], id: ['code'],
      }),
      ShardKeyError
    );
    await db.close();
  });

  test('requires id ⊇ shardKey', async () => {
    const db = await Database.create(dbPath);
    await assert.rejects(
      db.entityManager.createEntity('c', {
        type: 'sharded', values: ['code', 'name'], id: ['name'], shardKey: ['code'],
      }),
      ShardKeyError
    );
    await db.close();
  });

  test('requires unique ⊆ shardKey', async () => {
    const db = await Database.create(dbPath);
    await assert.rejects(
      db.entityManager.createEntity('c', {
        type: 'sharded',
        values: ['code', 'name'],
        id: ['code'],
        shardKey: ['code'],
        unique: ['name'],
      }),
      ShardKeyError
    );
    await db.close();
  });

  test('shardKey cannot be nested (triggers InvalidIdError via id∩nested)', async () => {
    // Because shardKey ⊆ id, any nested shardKey field is also a nested id
    // field, which is caught by the earlier id∩nested check.
    const db = await Database.create(dbPath);
    await db.entityManager.createEntity('addr', {
      type: 'object', values: ['street'],
    });
    await assert.rejects(
      db.entityManager.createEntity('c', {
        type: 'sharded',
        values: ['addr'],
        id: ['addr'],
        shardKey: ['addr'],
        nested: ['addr'],
      }),
      InvalidIdError
    );
    await db.close();
  });

  test('accepts valid shardKey', async () => {
    const db = await Database.create(dbPath);
    const cfg = await db.entityManager.createEntity('c', {
      type: 'sharded',
      values: ['code', 'name'],
      id: ['code'],
      shardKey: ['code'],
    });
    assert.deepEqual(cfg.shardKey, ['code']);
    assert.deepEqual(cfg.id, ['code']);
    assert.ok(cfg.notnullable.includes('code'));
    await db.close();
  });
});

describe('sharded — CRUD and sharding', () => {
  beforeEach(setup);
  afterEach(cleanup);

  async function setupCountries(db) {
    await db.entityManager.createEntity('countries', {
      type: 'sharded',
      values: ['code', 'name', 'continent'],
      id: ['code'],
      shardKey: ['code'],
    });
  }

  test('insert creates a shard file per shardKey value', async () => {
    const db = await Database.create(dbPath);
    await setupCountries(db);
    await db.recordManager.insert('countries', { code: 'US', name: 'United States', continent: 'NA' });
    await db.recordManager.insert('countries', { code: 'IT', name: 'Italy', continent: 'EU' });
    await db.close();

    const dir = path.join(dbPath + '.vdb', 'countries');
    assert.ok(fs.existsSync(dir));
    assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));
    const files = fs.readdirSync(dir).filter(f => f !== 'manifest.json');
    assert.equal(files.length, 2);
  });

  test('findById routes to correct shard', async () => {
    const db = await Database.create(dbPath);
    await setupCountries(db);
    await db.recordManager.insert('countries', { code: 'US', name: 'United States', continent: 'NA' });
    await db.recordManager.insert('countries', { code: 'IT', name: 'Italy', continent: 'EU' });

    const us = await db.recordManager.findById('countries', { code: 'US' });
    assert.equal(us.name, 'United States');
    const it = await db.recordManager.findById('countries', { code: 'IT' });
    assert.equal(it.name, 'Italy');
    const missing = await db.recordManager.findById('countries', { code: 'XX' });
    assert.equal(missing, null);
    await db.close();
  });

  test('findAll fans out across shards', async () => {
    const db = await Database.create(dbPath);
    await setupCountries(db);
    await db.recordManager.insert('countries', { code: 'US', name: 'US', continent: 'NA' });
    await db.recordManager.insert('countries', { code: 'IT', name: 'IT', continent: 'EU' });
    const all = await db.recordManager.findAll('countries');
    assert.equal(all.length, 2);
    await db.close();
  });

  test('findWhere prunes when shardKey is pinned in predicate', async () => {
    const db = await Database.create(dbPath);
    await setupCountries(db);
    await db.recordManager.insert('countries', { code: 'US', name: 'US', continent: 'NA' });
    await db.recordManager.insert('countries', { code: 'IT', name: 'IT', continent: 'EU' });

    // Spy on _loadContainer
    let loadCount = 0;
    const orig = db._loadContainer.bind(db);
    db._loadContainer = async (p) => { loadCount++; return orig(p); };

    const res = await db.recordManager.findWhere('countries', { code: 'US' });
    assert.equal(res.length, 1);
    assert.equal(loadCount, 1, 'only the US shard should have been loaded');
    await db.close();
  });

  test('update rejects shardKey changes (via id immutability)', async () => {
    const db = await Database.create(dbPath);
    await setupCountries(db);
    await db.recordManager.insert('countries', { code: 'US', name: 'US', continent: 'NA' });
    await assert.rejects(
      db.recordManager.update('countries', { code: 'US' }, { code: 'USA' }),
      InvalidIdError
    );
    const updated = await db.recordManager.update('countries', { code: 'US' }, { name: 'United States' });
    assert.equal(updated.name, 'United States');
    await db.close();
  });

  test('delete removes from correct shard', async () => {
    const db = await Database.create(dbPath);
    await setupCountries(db);
    await db.recordManager.insert('countries', { code: 'US', name: 'US', continent: 'NA' });
    await db.recordManager.insert('countries', { code: 'IT', name: 'IT', continent: 'EU' });
    await db.recordManager.deleteRecord('countries', { code: 'US' });
    const all = await db.recordManager.findAll('countries');
    assert.equal(all.length, 1);
    assert.equal(all[0].code, 'IT');
    await db.close();
  });

  test('insert missing shardKey throws', async () => {
    const db = await Database.create(dbPath);
    await setupCountries(db);
    await assert.rejects(
      db.recordManager.insert('countries', { name: 'Nowhere', continent: 'XX' }),
      ShardKeyError
    );
    await db.close();
  });

  test('duplicate id within a shard throws UniqueConstraintError', async () => {
    const db = await Database.create(dbPath);
    await setupCountries(db);
    await db.recordManager.insert('countries', { code: 'US', name: 'US', continent: 'NA' });
    await assert.rejects(
      db.recordManager.insert('countries', { code: 'US', name: 'Again', continent: 'NA' }),
      UniqueConstraintError
    );
    await db.close();
  });

  test('deleteEntity removes sharded directory', async () => {
    const db = await Database.create(dbPath);
    await setupCountries(db);
    await db.recordManager.insert('countries', { code: 'US', name: 'US', continent: 'NA' });
    const dir = path.join(dbPath + '.vdb', 'countries');
    await db.close();
    assert.ok(fs.existsSync(dir));

    const db2 = await Database.create(dbPath);
    await db2.entityManager.deleteEntity('countries');
    assert.equal(fs.existsSync(dir), false);
    await db2.close();
  });

  test('persists across close/reopen', async () => {
    let db = await Database.create(dbPath);
    await setupCountries(db);
    await db.recordManager.insert('countries', { code: 'US', name: 'US', continent: 'NA' });
    await db.recordManager.insert('countries', { code: 'IT', name: 'IT', continent: 'EU' });
    await db.close();

    db = await Database.create(dbPath);
    const all = await db.recordManager.findAll('countries');
    assert.equal(all.length, 2);
    await db.close();
  });
});
