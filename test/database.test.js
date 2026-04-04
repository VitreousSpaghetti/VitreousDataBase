'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { Database, FileAccessError } = require('../index');

let tmpDir;
let dbPath;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitreousdb-test-'));
  dbPath = path.join(tmpDir, 'test.json');
}

function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('Database init', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('creates file with empty structure if it does not exist', async () => {
    const db = await Database.create(dbPath);
    assert.ok(fs.existsSync(dbPath));
    const content = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    assert.deepEqual(content, { entitiesConfiguration: {}, entities: {} });
    await db.close();
  });

  test('throws FileAccessError on inaccessible directory', async () => {
    await assert.rejects(
      () => Database.create('/nonexistent/path/db.json'),
      FileAccessError
    );
  });

  test('throws FileAccessError on corrupted JSON', async () => {
    fs.writeFileSync(dbPath, 'not valid json', 'utf8');
    await assert.rejects(
      () => Database.create(dbPath),
      FileAccessError
    );
  });

  test('loads existing file correctly', async () => {
    const initial = { entitiesConfiguration: {}, entities: {} };
    fs.writeFileSync(dbPath, JSON.stringify(initial), 'utf8');
    const db = await Database.create(dbPath);
    assert.ok(db.entityManager);
    assert.ok(db.recordManager);
    await db.close();
  });
});

describe('Database eager mode', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('writes in eager mode do not touch disk until flush', async () => {
    const db = await Database.create(dbPath, { eager: true });
    const before = fs.readFileSync(dbPath, 'utf8');

    await db.entityManager.createEntity('items', { type: 'table', values: ['id', 'name'], id: ['id'] });

    const after = fs.readFileSync(dbPath, 'utf8');
    assert.equal(before, after, 'disk should not change before flush');
    await db.close();
  });

  test('flush writes cache to disk', async () => {
    const db = await Database.create(dbPath, { eager: true });
    await db.entityManager.createEntity('items', { type: 'table', values: ['id', 'name'], id: ['id'] });
    await db.flush();

    const content = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    assert.ok(content.entitiesConfiguration.items);
  });

  test('close flushes and prevents further operations', async () => {
    const db = await Database.create(dbPath, { eager: true });
    await db.entityManager.createEntity('items', { type: 'table', values: ['id'], id: ['id'] });
    await db.close();

    const content = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    assert.ok(content.entitiesConfiguration.items);

    await assert.rejects(
      () => db.entityManager.listEntities(),
      FileAccessError
    );
  });
});
