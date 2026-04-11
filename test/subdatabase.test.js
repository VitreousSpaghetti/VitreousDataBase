'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  Database,
  EntityNotFoundError,
  EntityTypeError,
  InvalidIdError,
  UniqueConstraintError,
  RecordNotFoundError,
  ShardKeyError,
} = require('../index');

let tmpDir;
let dbPath;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitreousdb-sub-'));
  dbPath = path.join(tmpDir, 'test.json');
}
function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('subdatabase — schema validation', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('requires id', async () => {
    const db = await Database.create(dbPath);
    await assert.rejects(
      db.entityManager.createEntity('settings', {
        type: 'subdatabase', values: ['key', 'val'],
      }),
      InvalidIdError
    );
    await db.close();
  });

  test('rejects shardKey', async () => {
    const db = await Database.create(dbPath);
    await assert.rejects(
      db.entityManager.createEntity('settings', {
        type: 'subdatabase', values: ['k'], id: ['k'], shardKey: ['k'],
      }),
      ShardKeyError
    );
    await db.close();
  });

  test('accepts subEntities children', async () => {
    const db = await Database.create(dbPath);
    const cfg = await db.entityManager.createEntity('app', {
      type: 'subdatabase',
      values: ['name'],
      id: ['name'],
      subEntities: {
        log: { type: 'table', values: ['entry', 'id'], id: ['id'] },
      },
    });
    assert.equal(cfg.type, 'subdatabase');
    assert.ok(cfg.subEntities.log);
    assert.equal(cfg.subEntities.log.type, 'table');
    await db.close();
  });

  test('rejects reserved _self as subEntity name', async () => {
    const db = await Database.create(dbPath);
    await assert.rejects(
      db.entityManager.createEntity('app', {
        type: 'subdatabase', values: ['k'], id: ['k'],
        subEntities: { _self: { type: 'table', values: ['x'], id: ['x'] } },
      }),
      /reserved/
    );
    await db.close();
  });
});

describe('subdatabase — CRUD', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('insert and findById', async () => {
    const db = await Database.create(dbPath);
    await db.entityManager.createEntity('config', {
      type: 'subdatabase', values: ['key', 'val'], id: ['key'],
    });
    const rec = await db.recordManager.insert('config', { key: 'theme', val: 'dark' });
    assert.deepEqual(rec, { key: 'theme', val: 'dark' });

    const found = await db.recordManager.findById('config', { key: 'theme' });
    assert.deepEqual(found, { key: 'theme', val: 'dark' });

    const missing = await db.recordManager.findById('config', { key: 'nope' });
    assert.equal(missing, null);

    await db.close();
  });

  test('sidecar file created on first insert, not on createEntity', async () => {
    const db = await Database.create(dbPath);
    await db.entityManager.createEntity('config', {
      type: 'subdatabase', values: ['key'], id: ['key'],
    });
    const sidecarFile = path.join(dbPath + '.vdb', 'config.json');
    assert.equal(fs.existsSync(sidecarFile), false, 'no sidecar before insert');

    await db.recordManager.insert('config', { key: 'a' });
    await db.close(); // flush
    assert.equal(fs.existsSync(sidecarFile), true, 'sidecar after insert');

    const payload = JSON.parse(fs.readFileSync(sidecarFile, 'utf8'));
    assert.deepEqual(payload.records, [{ key: 'a' }]);
    assert.deepEqual(payload.entities, {});
  });

  test('update and delete', async () => {
    const db = await Database.create(dbPath);
    await db.entityManager.createEntity('config', {
      type: 'subdatabase', values: ['key', 'val'], id: ['key'],
    });
    await db.recordManager.insert('config', { key: 'theme', val: 'dark' });

    const updated = await db.recordManager.update('config', { key: 'theme' }, { val: 'light' });
    assert.equal(updated.val, 'light');

    const deleted = await db.recordManager.deleteRecord('config', { key: 'theme' });
    assert.equal(deleted.val, 'light');

    const gone = await db.recordManager.findById('config', { key: 'theme' });
    assert.equal(gone, null);
    await db.close();
  });

  test('id immutable', async () => {
    const db = await Database.create(dbPath);
    await db.entityManager.createEntity('config', {
      type: 'subdatabase', values: ['key'], id: ['key'],
    });
    await db.recordManager.insert('config', { key: 'a' });
    await assert.rejects(
      db.recordManager.update('config', { key: 'a' }, { key: 'b' }),
      InvalidIdError
    );
    await db.close();
  });

  test('multiple instances share one sidecar file', async () => {
    const db = await Database.create(dbPath);
    await db.entityManager.createEntity('config', {
      type: 'subdatabase', values: ['key', 'val'], id: ['key'],
    });
    await db.recordManager.insert('config', { key: 'a', val: 1 });
    await db.recordManager.insert('config', { key: 'b', val: 2 });
    const all = await db.recordManager.findAll('config');
    assert.equal(all.length, 2);

    // Unique id enforcement
    await assert.rejects(
      db.recordManager.insert('config', { key: 'a', val: 999 }),
      UniqueConstraintError
    );
    await db.close();
  });

  test('child table records live in the sidecar', async () => {
    const db = await Database.create(dbPath);
    await db.entityManager.createEntity('app', {
      type: 'subdatabase',
      values: ['name'], id: ['name'],
      subEntities: {
        log: { type: 'table', values: ['entry', 'id'], id: ['id'] },
      },
    });
    await db.recordManager.insert('app', { name: 'vdb' });
    await db.recordManager.insert('app.log', { id: 1, entry: 'first' });
    await db.recordManager.insert('app.log', { id: 2, entry: 'second' });

    const all = await db.recordManager.findAll('app.log');
    assert.equal(all.length, 2);

    const one = await db.recordManager.findById('app.log', { id: 1 });
    assert.equal(one.entry, 'first');

    await db.close();

    const payload = JSON.parse(fs.readFileSync(path.join(dbPath + '.vdb', 'app.json'), 'utf8'));
    assert.equal(payload.records.length, 1);
    assert.equal(payload.entities.log.length, 2);
  });
});

describe('subdatabase — persistence and deleteEntity', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('persists across close/reopen', async () => {
    let db = await Database.create(dbPath);
    await db.entityManager.createEntity('config', {
      type: 'subdatabase', values: ['key', 'val'], id: ['key'],
    });
    await db.recordManager.insert('config', { key: 'theme', val: 'dark' });
    await db.close();

    db = await Database.create(dbPath);
    const found = await db.recordManager.findById('config', { key: 'theme' });
    assert.deepEqual(found, { key: 'theme', val: 'dark' });
    await db.close();
  });

  test('deleteEntity removes sidecar file', async () => {
    const db = await Database.create(dbPath);
    await db.entityManager.createEntity('config', {
      type: 'subdatabase', values: ['key'], id: ['key'],
    });
    await db.recordManager.insert('config', { key: 'a' });
    const sidecarFile = path.join(dbPath + '.vdb', 'config.json');
    await db.close();
    assert.equal(fs.existsSync(sidecarFile), true);

    const db2 = await Database.create(dbPath);
    await db2.entityManager.deleteEntity('config');
    assert.equal(fs.existsSync(sidecarFile), false);
    await assert.rejects(
      db2.recordManager.findAll('config'),
      EntityNotFoundError
    );
    await db2.close();
  });
});
