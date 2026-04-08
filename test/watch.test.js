'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { Database } = require('../index');

let tmpDir;
let db;

async function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitreousdb-watch-'));
  db = await Database.create(path.join(tmpDir, 'db.json'));
  await db.entityManager.createEntity('users', {
    type: 'table',
    id: ['id'],
    values: ['id', 'name', 'email'],
    unique: ['email'],
  });
}

async function cleanup() {
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('watch — insert events', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('fires insert event with correct shape', async () => {
    const events = [];
    db.recordManager.watch('users', (e) => events.push(e));
    await db.recordManager.insert('users', { id: 1, name: 'Alice' });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'insert');
    assert.deepEqual(events[0].record, { id: 1, name: 'Alice' });
  });

  test('insert event record is a clone — mutating it does not affect the DB', async () => {
    let captured;
    db.recordManager.watch('users', (e) => { captured = e.record; });
    await db.recordManager.insert('users', { id: 1, name: 'Alice' });
    captured.name = 'MUTATED';
    const r = await db.recordManager.findByIdSingle('users', 1);
    assert.equal(r.name, 'Alice');
  });

  test('no event fired when insert fails validation', async () => {
    const events = [];
    db.recordManager.watch('users', (e) => events.push(e));
    await db.recordManager.insert('users', { id: 1, email: 'a@b.com' });
    await assert.rejects(() =>
      db.recordManager.insert('users', { id: 2, email: 'a@b.com' }) // unique violation
    );
    assert.equal(events.length, 1); // only the first insert
  });
});

describe('watch — update events', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('fires update event with record and previous', async () => {
    await db.recordManager.insert('users', { id: 1, name: 'Alice' });
    const events = [];
    db.recordManager.watch('users', (e) => events.push(e));
    await db.recordManager.update('users', { id: 1 }, { name: 'Alicia' });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'update');
    assert.equal(events[0].record.name, 'Alicia');
    assert.equal(events[0].previous.name, 'Alice');
  });

  test('previous is a snapshot of the record before each update', async () => {
    await db.recordManager.insert('users', { id: 1, name: 'Alice' });
    const captured = [];
    db.recordManager.watch('users', (e) => { if (e.previous) captured.push(e.previous); });
    await db.recordManager.update('users', { id: 1 }, { name: 'Alicia' });
    await db.recordManager.update('users', { id: 1 }, { name: 'Ali' });
    assert.equal(captured[0].name, 'Alice');   // previous before first update
    assert.equal(captured[1].name, 'Alicia');  // previous before second update
  });
});

describe('watch — delete events', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('fires delete event with the deleted record', async () => {
    await db.recordManager.insert('users', { id: 1, name: 'Alice' });
    const events = [];
    db.recordManager.watch('users', (e) => events.push(e));
    await db.recordManager.deleteRecord('users', { id: 1 });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'delete');
    assert.equal(events[0].record.id, 1);
    assert.equal(events[0].record.name, 'Alice');
  });
});

describe('watch — unsubscribe', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('unsubscribe stops further events', async () => {
    const events = [];
    const unsub = db.recordManager.watch('users', (e) => events.push(e));
    await db.recordManager.insert('users', { id: 1, name: 'Alice' });
    unsub();
    await db.recordManager.insert('users', { id: 2, name: 'Bob' });
    assert.equal(events.length, 1);
  });

  test('unsubscribing twice is a safe no-op', async () => {
    const unsub = db.recordManager.watch('users', () => {});
    unsub();
    assert.doesNotThrow(() => unsub());
  });
});

describe('watch — multiple watchers', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('all watchers on the same entity fire', async () => {
    const a = [];
    const b = [];
    db.recordManager.watch('users', (e) => a.push(e));
    db.recordManager.watch('users', (e) => b.push(e));
    await db.recordManager.insert('users', { id: 1, name: 'Alice' });
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
  });

  test('watcher on one entity does not fire for another entity', async () => {
    await db.entityManager.createEntity('products', {
      type: 'table',
      id: ['id'],
      values: ['id', 'title'],
    });
    const userEvents = [];
    db.recordManager.watch('users', (e) => userEvents.push(e));
    await db.recordManager.insert('products', { id: 1, title: 'Widget' });
    assert.equal(userEvents.length, 0);
  });
});

describe('watch — callback error isolation', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('a throwing callback does not abort the write or affect other watchers', async () => {
    const good = [];
    db.recordManager.watch('users', () => { throw new Error('callback boom'); });
    db.recordManager.watch('users', (e) => good.push(e));

    // Insert should succeed despite the throwing watcher
    const inserted = await db.recordManager.insert('users', { id: 1, name: 'Alice' });
    assert.equal(inserted.id, 1);

    // The record is in the DB
    const r = await db.recordManager.findByIdSingle('users', 1);
    assert.ok(r !== null);

    // The good watcher still received the event
    assert.equal(good.length, 1);
  });
});

describe('watch — watching before entity has records', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('can watch an entity before any records exist', async () => {
    const events = [];
    db.recordManager.watch('users', (e) => events.push(e));
    assert.equal(events.length, 0);
    await db.recordManager.insert('users', { id: 1, name: 'Alice' });
    assert.equal(events.length, 1);
  });
});
