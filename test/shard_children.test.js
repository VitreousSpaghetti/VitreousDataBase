'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  Database,
  ShardKeyError,
  RecordNotFoundError,
  UniqueConstraintError,
} = require('../index');

let tmpDir;
let dbPath;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitreousdb-schild-'));
  dbPath = path.join(tmpDir, 'test.json');
}
function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function setupCountriesWithPeople(db) {
  await db.entityManager.createEntity('countries', {
    type: 'sharded',
    values: ['code', 'name'],
    id: ['code'],
    shardKey: ['code'],
    subEntities: {
      person: {
        type: 'table',
        values: ['personId', 'firstName'],
        id: ['personId'],
        unique: ['firstName'],
      },
    },
  });
}

describe('sharded children — CRUD with scope', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('insert with scope writes into the right shard', async () => {
    const db = await Database.create(dbPath);
    await setupCountriesWithPeople(db);
    await db.recordManager.insert('countries', { code: 'US', name: 'US' });
    await db.recordManager.insert('countries', { code: 'IT', name: 'IT' });

    await db.recordManager.insert('countries.person',
      { personId: 1, firstName: 'Alice' }, { scope: { code: 'US' } });
    await db.recordManager.insert('countries.person',
      { personId: 2, firstName: 'Bob' }, { scope: { code: 'IT' } });

    const us = await db.recordManager.findById('countries.person',
      { personId: 1 }, { scope: { code: 'US' } });
    assert.equal(us.firstName, 'Alice');

    const it = await db.recordManager.findById('countries.person',
      { personId: 2 }, { scope: { code: 'IT' } });
    assert.equal(it.firstName, 'Bob');

    // Wrong shard returns null
    const wrong = await db.recordManager.findById('countries.person',
      { personId: 1 }, { scope: { code: 'IT' } });
    assert.equal(wrong, null);

    await db.close();
  });

  test('insert without scope throws ShardKeyError', async () => {
    const db = await Database.create(dbPath);
    await setupCountriesWithPeople(db);
    await db.recordManager.insert('countries', { code: 'US', name: 'US' });
    await assert.rejects(
      db.recordManager.insert('countries.person', { personId: 1, firstName: 'A' }),
      ShardKeyError
    );
    await db.close();
  });

  test('findAll without scope fans out across all shards', async () => {
    const db = await Database.create(dbPath);
    await setupCountriesWithPeople(db);
    await db.recordManager.insert('countries', { code: 'US', name: 'US' });
    await db.recordManager.insert('countries', { code: 'IT', name: 'IT' });
    await db.recordManager.insert('countries.person',
      { personId: 1, firstName: 'A' }, { scope: { code: 'US' } });
    await db.recordManager.insert('countries.person',
      { personId: 2, firstName: 'B' }, { scope: { code: 'IT' } });

    const all = await db.recordManager.findAll('countries.person');
    assert.equal(all.length, 2);
    await db.close();
  });

  test('findAll with scope restricts to one parent shard', async () => {
    const db = await Database.create(dbPath);
    await setupCountriesWithPeople(db);
    await db.recordManager.insert('countries', { code: 'US', name: 'US' });
    await db.recordManager.insert('countries', { code: 'IT', name: 'IT' });
    await db.recordManager.insert('countries.person',
      { personId: 1, firstName: 'A' }, { scope: { code: 'US' } });
    await db.recordManager.insert('countries.person',
      { personId: 2, firstName: 'B' }, { scope: { code: 'IT' } });

    const us = await db.recordManager.findAll('countries.person', { scope: { code: 'US' } });
    assert.equal(us.length, 1);
    assert.equal(us[0].firstName, 'A');
    await db.close();
  });

  test('unique constraint is scoped per shard', async () => {
    const db = await Database.create(dbPath);
    await setupCountriesWithPeople(db);
    await db.recordManager.insert('countries', { code: 'US', name: 'US' });
    await db.recordManager.insert('countries', { code: 'IT', name: 'IT' });

    // Same firstName in different shards is allowed — unique is shard-local
    await db.recordManager.insert('countries.person',
      { personId: 1, firstName: 'Alice' }, { scope: { code: 'US' } });
    await db.recordManager.insert('countries.person',
      { personId: 1, firstName: 'Alice' }, { scope: { code: 'IT' } });

    // Same firstName in the same shard is rejected
    await assert.rejects(
      db.recordManager.insert('countries.person',
        { personId: 2, firstName: 'Alice' }, { scope: { code: 'US' } }),
      UniqueConstraintError
    );
    await db.close();
  });

  test('update with scope modifies only the targeted shard row', async () => {
    const db = await Database.create(dbPath);
    await setupCountriesWithPeople(db);
    await db.recordManager.insert('countries', { code: 'US', name: 'US' });
    await db.recordManager.insert('countries.person',
      { personId: 1, firstName: 'Alice' }, { scope: { code: 'US' } });

    const updated = await db.recordManager.update('countries.person',
      { personId: 1 }, { firstName: 'Alicia' }, { scope: { code: 'US' } });
    assert.equal(updated.firstName, 'Alicia');
    await db.close();
  });

  test('delete with scope removes the row', async () => {
    const db = await Database.create(dbPath);
    await setupCountriesWithPeople(db);
    await db.recordManager.insert('countries', { code: 'US', name: 'US' });
    await db.recordManager.insert('countries.person',
      { personId: 1, firstName: 'Alice' }, { scope: { code: 'US' } });
    await db.recordManager.deleteRecord('countries.person',
      { personId: 1 }, { scope: { code: 'US' } });
    const all = await db.recordManager.findAll('countries.person');
    assert.equal(all.length, 0);
    await db.close();
  });

  test('update with wrong scope throws RecordNotFoundError', async () => {
    const db = await Database.create(dbPath);
    await setupCountriesWithPeople(db);
    await db.recordManager.insert('countries', { code: 'US', name: 'US' });
    await db.recordManager.insert('countries', { code: 'IT', name: 'IT' });
    await db.recordManager.insert('countries.person',
      { personId: 1, firstName: 'A' }, { scope: { code: 'US' } });

    await assert.rejects(
      db.recordManager.update('countries.person',
        { personId: 1 }, { firstName: 'X' }, { scope: { code: 'IT' } }),
      RecordNotFoundError
    );
    await db.close();
  });
});
