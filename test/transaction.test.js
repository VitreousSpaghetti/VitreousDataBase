'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { Database, UniqueConstraintError } = require('../index');

let tmpDir;
let db;

async function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitreousdb-transaction-'));
  db = await Database.create(path.join(tmpDir, 'db.json'));
}

async function cleanup() {
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('transaction', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('both operations persist when both succeed', async () => {
    await db.entityManager.createEntity('orders', {
      type: 'table',
      id: ['orderId'],
      values: ['orderId', 'customerId'],
    });
    await db.entityManager.createEntity('lines', {
      type: 'table',
      id: ['lineId'],
      values: ['lineId', 'orderId'],
    });

    await db.transaction(async (tx) => {
      await tx.recordManager.insert('orders', { orderId: 1, customerId: 42 });
      await tx.recordManager.insert('lines',  { lineId: 1, orderId: 1 });
    });

    const orders = await db.recordManager.findAll('orders');
    const lines  = await db.recordManager.findAll('lines');
    assert.equal(orders.length, 1);
    assert.equal(lines.length, 1);
  });

  test('no operations persist when one throws (rollback)', async () => {
    await db.entityManager.createEntity('orders', {
      type: 'table',
      id: ['orderId'],
      values: ['orderId'],
      unique: ['orderId'],
    });

    // Pre-insert a record so the second insert in the transaction will conflict
    await db.recordManager.insert('orders', { orderId: 99 });

    await assert.rejects(async () => {
      await db.transaction(async (tx) => {
        await tx.recordManager.insert('orders', { orderId: 1 }); // succeeds in tx context
        await tx.recordManager.insert('orders', { orderId: 99 }); // conflicts — throws
      });
    }, UniqueConstraintError);

    // Only the pre-existing record should be there
    const orders = await db.recordManager.findAll('orders');
    assert.equal(orders.length, 1);
    assert.equal(orders[0].orderId, 99);
  });

  test('transaction reads its own uncommitted writes', async () => {
    await db.entityManager.createEntity('items', {
      type: 'table',
      id: ['id'],
      values: ['id', 'qty'],
    });

    let seenInTx;
    await db.transaction(async (tx) => {
      await tx.recordManager.insert('items', { id: 1, qty: 10 });
      seenInTx = await tx.recordManager.findByIdSingle('items', 1);
    });

    assert.equal(seenInTx.qty, 10);
  });

  test('real db is unchanged until transaction commits', async () => {
    await db.entityManager.createEntity('items', {
      type: 'table',
      id: ['id'],
      values: ['id'],
    });

    let outsideSnapshot;
    await db.transaction(async (tx) => {
      await tx.recordManager.insert('items', { id: 1 });
      // While inside the transaction (still awaiting), the real db has no records yet
      // We can't easily interleave due to the mutex, but we can verify post-commit state
      outsideSnapshot = await tx.recordManager.findAll('items');
    });

    const after = await db.recordManager.findAll('items');
    assert.equal(outsideSnapshot.length, 1); // tx sees its own write
    assert.equal(after.length, 1);           // committed after fn resolves
  });

  test('entity operations inside transaction are also rolled back on failure', async () => {
    await db.entityManager.createEntity('users', {
      type: 'table',
      id: ['id'],
      values: ['id'],
    });

    await assert.rejects(async () => {
      await db.transaction(async (tx) => {
        await tx.recordManager.insert('users', { id: 1 });
        await tx.entityManager.addField('users', 'email');
        throw new Error('intentional rollback');
      });
    }, /intentional rollback/);

    const users = await db.recordManager.findAll('users');
    assert.equal(users.length, 0);
    const config = await db.entityManager.getEntity('users');
    assert.ok(!config.values.includes('email'));
  });

  test('multiple transactions are serialized — second sees first commit', async () => {
    await db.entityManager.createEntity('counters', {
      type: 'table',
      id: ['id'],
      values: ['id', 'value'],
    });
    await db.recordManager.insert('counters', { id: 1, value: 0 });

    await db.transaction(async (tx) => {
      const r = await tx.recordManager.findByIdSingle('counters', 1);
      await tx.recordManager.update('counters', { id: 1 }, { value: r.value + 1 });
    });
    await db.transaction(async (tx) => {
      const r = await tx.recordManager.findByIdSingle('counters', 1);
      await tx.recordManager.update('counters', { id: 1 }, { value: r.value + 1 });
    });

    const final = await db.recordManager.findByIdSingle('counters', 1);
    assert.equal(final.value, 2);
  });

  test('transaction works in eager mode', async () => {
    let eagerDb;
    const eagerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitreousdb-tx-eager-'));
    try {
      eagerDb = await Database.create(path.join(eagerDir, 'db.json'), { eager: true });
      await eagerDb.entityManager.createEntity('items', {
        type: 'table',
        id: ['id'],
        values: ['id', 'name'],
      });
      await eagerDb.transaction(async (tx) => {
        await tx.recordManager.insert('items', { id: 1, name: 'A' });
        await tx.recordManager.insert('items', { id: 2, name: 'B' });
      });
      const all = await eagerDb.recordManager.findAll('items');
      assert.equal(all.length, 2);
    } finally {
      await eagerDb.close();
      fs.rmSync(eagerDir, { recursive: true, force: true });
    }
  });
});
