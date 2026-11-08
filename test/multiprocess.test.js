'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork, spawn } = require('child_process');

const { Database, FileAccessError } = require('../index');

let tmpDir;
let dbPath;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitreousdb-mp-'));
  dbPath = path.join(tmpDir, 'test.json');
}
function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const WORKER = path.join(__dirname, 'fixtures', 'multiprocess_worker.js');

function runWorker(...args) {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, args.map(String), { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve(child.pid) : reject(new Error(`worker exited with ${code}`))));
  });
}

describe('multiProcess — options', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('eager + multiProcess throws TypeError before touching disk', async () => {
    await assert.rejects(Database.create(dbPath, { eager: true, multiProcess: true }), TypeError);
    assert.equal(fs.existsSync(dbPath), false);
  });

  test('invalid lockTimeout throws TypeError', async () => {
    for (const lockTimeout of [0, -1, NaN, Infinity, '100']) {
      await assert.rejects(Database.create(dbPath, { multiProcess: true, lockTimeout }), TypeError);
    }
  });

  test('default mode creates no lock file', async () => {
    const db = await Database.create(dbPath);
    await db.entityManager.createEntity('t', { type: 'table', id: ['n'], values: ['n'] });
    assert.equal(fs.existsSync(dbPath + '.lock'), false);
    await db.close();
  });

  test('lock is released after each operation, also on failure', async () => {
    const db = await Database.create(dbPath, { multiProcess: true });
    await db.entityManager.createEntity('t', { type: 'table', id: ['n'], values: ['n'] });
    assert.equal(fs.existsSync(dbPath + '.lock'), false);
    await db.recordManager.insert('t', { n: 1 });
    await assert.rejects(db.recordManager.insert('t', { n: 1 }));
    assert.equal(fs.existsSync(dbPath + '.lock'), false);
    await db.close();
  });
});

describe('multiProcess — lock contention', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('lock held by a live pid → FileAccessError after lockTimeout', async () => {
    const db = await Database.create(dbPath, { multiProcess: true, lockTimeout: 100 });
    fs.writeFileSync(dbPath + '.lock', String(process.pid)); // this process is alive
    await assert.rejects(db.entityManager.listEntities(), FileAccessError);
    fs.unlinkSync(dbPath + '.lock');
    await db.close();
  });

  test('lock left by a dead pid is broken', async () => {
    const db = await Database.create(dbPath, { multiProcess: true, lockTimeout: 2000 });
    // A process that has exited: its pid is dead.
    const deadPid = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', '']);
      child.on('error', reject);
      child.on('exit', () => resolve(child.pid));
    });
    fs.writeFileSync(dbPath + '.lock', String(deadPid));
    assert.deepEqual(await db.entityManager.listEntities(), []);
    assert.equal(fs.existsSync(dbPath + '.lock'), false);
    await db.close();
  });

  test('empty lock file older than lockTimeout is broken', async () => {
    const db = await Database.create(dbPath, { multiProcess: true, lockTimeout: 200 });
    fs.writeFileSync(dbPath + '.lock', '');
    const old = new Date(Date.now() - 10000);
    fs.utimesSync(dbPath + '.lock', old, old);
    assert.deepEqual(await db.entityManager.listEntities(), []);
    await db.close();
  });
});

describe('multiProcess — concurrent writers', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('no lost writes across processes (table, subdatabase, sharded)', { timeout: 120000 }, async () => {
    const WORKERS = 4;
    const COUNT = 15;
    const db = await Database.create(dbPath, { multiProcess: true });
    await db.entityManager.createEntity('items', { type: 'table', id: ['n'], values: ['n'] });
    await db.entityManager.createEntity('bag', { type: 'subdatabase', id: ['n'], values: ['n'] });
    await db.entityManager.createEntity('geo', {
      type: 'sharded', id: ['region', 'n'], values: ['region', 'n'], shardKey: ['region'],
    });

    await Promise.all(Array.from({ length: WORKERS }, (_, w) => runWorker(dbPath, w, COUNT)));

    const rm = db.recordManager;
    assert.equal((await rm.findAll('items')).length, WORKERS * COUNT);
    assert.equal((await rm.findAll('bag')).length, WORKERS * COUNT);
    assert.equal((await rm.findAll('geo')).length, WORKERS * COUNT * 2);

    const manifest = JSON.parse(fs.readFileSync(path.join(dbPath + '.vdb', 'geo', 'manifest.json'), 'utf8'));
    assert.equal(Object.keys(manifest.shards).length, 3 + WORKERS);
    assert.equal(fs.existsSync(dbPath + '.lock'), false);
    await db.close();
  });

  test('concurrent opens of a brand-new db all succeed', { timeout: 60000 }, async () => {
    // Concurrent init on a missing file must leave one valid empty db.
    await Promise.all(Array.from({ length: 4 }, () => Database.create(dbPath, { multiProcess: true })
      .then(db => db.close())));
    assert.deepEqual(JSON.parse(fs.readFileSync(dbPath, 'utf8')), { entitiesConfiguration: {}, entities: {} });
  });
});
