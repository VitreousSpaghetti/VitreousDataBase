'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { Database } = require('../index');

let tmpDir;
let dbPath;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitreousdb-idx-'));
  dbPath = path.join(tmpDir, 'test.json');
}
function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('id index — eager mode', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('builds lazily on first lookup, maintained by insert', async () => {
    const db = await Database.create(dbPath, { eager: true });
    await db.entityManager.createEntity('users', {
      type: 'table', values: ['id', 'name'], id: ['id'],
    });
    // Insert before first lookup — no index built yet
    await db.recordManager.insert('users', { id: 1, name: 'Alice' });
    assert.equal(db._idIndex.size, 0, 'index is not built by insert alone');

    // Lookup builds the index
    const found = await db.recordManager.findById('users', { id: 1 });
    assert.equal(found.name, 'Alice');
    assert.equal(db._idIndex.has('table/users'), true);
    assert.equal(db._idIndex.get('table/users').size, 1);

    // Subsequent insert updates the index incrementally
    await db.recordManager.insert('users', { id: 2, name: 'Bob' });
    assert.equal(db._idIndex.get('table/users').size, 2);

    // Lookup of new record works
    const bob = await db.recordManager.findById('users', { id: 2 });
    assert.equal(bob.name, 'Bob');
    await db.close();
  });

  test('delete invalidates the scope map', async () => {
    const db = await Database.create(dbPath, { eager: true });
    await db.entityManager.createEntity('users', {
      type: 'table', values: ['id'], id: ['id'],
    });
    await db.recordManager.insert('users', { id: 1 });
    await db.recordManager.insert('users', { id: 2 });
    await db.recordManager.findById('users', { id: 1 }); // build index
    assert.equal(db._idIndex.get('table/users').size, 2);

    await db.recordManager.deleteRecord('users', { id: 1 });
    assert.equal(db._idIndex.has('table/users'), false, 'index cleared after delete');

    // Rebuilt on next lookup
    const remaining = await db.recordManager.findById('users', { id: 2 });
    assert.ok(remaining);
    assert.equal(db._idIndex.get('table/users').size, 1);
    await db.close();
  });

  test('composite id lookup works', async () => {
    const db = await Database.create(dbPath, { eager: true });
    await db.entityManager.createEntity('orders', {
      type: 'table', values: ['userId', 'orderId', 'amount'], id: ['userId', 'orderId'],
    });
    await db.recordManager.insert('orders', { userId: 1, orderId: 10, amount: 5 });
    await db.recordManager.insert('orders', { userId: 1, orderId: 11, amount: 6 });
    await db.recordManager.insert('orders', { userId: 2, orderId: 10, amount: 7 });

    const o = await db.recordManager.findById('orders', { userId: 1, orderId: 11 });
    assert.equal(o.amount, 6);
    await db.close();
  });

  test('independent index per sharded shard file', async () => {
    const db = await Database.create(dbPath, { eager: true });
    await db.entityManager.createEntity('c', {
      type: 'sharded', values: ['code', 'name'], id: ['code'], shardKey: ['code'],
    });
    await db.recordManager.insert('c', { code: 'US', name: 'US' });
    await db.recordManager.insert('c', { code: 'IT', name: 'IT' });
    await db.recordManager.findById('c', { code: 'US' });
    await db.recordManager.findById('c', { code: 'IT' });

    const keys = Array.from(db._idIndex.keys());
    assert.equal(keys.filter(k => k.startsWith('sharded/c/')).length, 2);
    await db.close();
  });
});

describe('id index — non-eager mode', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('non-eager mode falls back to linear scan, leaves _idIndex empty', async () => {
    const db = await Database.create(dbPath);
    await db.entityManager.createEntity('users', {
      type: 'table', values: ['id'], id: ['id'],
    });
    await db.recordManager.insert('users', { id: 1 });
    await db.recordManager.findById('users', { id: 1 });
    assert.equal(db._idIndex.size, 0);
    await db.close();
  });
});
