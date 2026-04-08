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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitreousdb-qops-'));
  db = await Database.create(path.join(tmpDir, 'db.json'));

  await db.entityManager.createEntity('address', {
    type: 'object',
    values: ['street', 'city'],
  });

  await db.entityManager.createEntity('orders', {
    type: 'table',
    id: ['id'],
    values: ['id', 'total', 'status', 'tag', 'address'],
    nested: ['address'],
  });

  await db.recordManager.insert('orders', { id: 1, total: 50,  status: 'new',       tag: 'a' });
  await db.recordManager.insert('orders', { id: 2, total: 100, status: 'pending',   tag: 'b' });
  await db.recordManager.insert('orders', { id: 3, total: 200, status: 'completed', tag: 'a', address: { street: 'Via Roma', city: 'Milano' } });
  await db.recordManager.insert('orders', { id: 4, total: 300, status: 'cancelled', tag: 'b' });
}

async function cleanup() {
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// $eq
// ---------------------------------------------------------------------------
describe('$eq operator', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('matches records where field equals operand', async () => {
    const result = await db.recordManager.findWhere('orders', { status: { $eq: 'new' } });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 1);
  });

  test('returns empty array when no match', async () => {
    const result = await db.recordManager.findWhere('orders', { status: { $eq: 'unknown' } });
    assert.deepEqual(result, []);
  });

  test('$eq on number', async () => {
    const result = await db.recordManager.findWhere('orders', { total: { $eq: 100 } });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 2);
  });
});

// ---------------------------------------------------------------------------
// $ne
// ---------------------------------------------------------------------------
describe('$ne operator', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('matches records where field does not equal operand', async () => {
    const result = await db.recordManager.findWhere('orders', { status: { $ne: 'cancelled' } });
    assert.equal(result.length, 3);
    assert.ok(result.every(r => r.status !== 'cancelled'));
  });
});

// ---------------------------------------------------------------------------
// $gt / $gte
// ---------------------------------------------------------------------------
describe('$gt and $gte operators', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('$gt matches records with field strictly greater than operand', async () => {
    const result = await db.recordManager.findWhere('orders', { total: { $gt: 100 } });
    assert.equal(result.length, 2);
    assert.ok(result.every(r => r.total > 100));
  });

  test('$gt excludes equal value', async () => {
    const result = await db.recordManager.findWhere('orders', { total: { $gt: 200 } });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 4);
  });

  test('$gte matches records with field greater than or equal to operand', async () => {
    const result = await db.recordManager.findWhere('orders', { total: { $gte: 100 } });
    assert.equal(result.length, 3);
    assert.ok(result.every(r => r.total >= 100));
  });
});

// ---------------------------------------------------------------------------
// $lt / $lte
// ---------------------------------------------------------------------------
describe('$lt and $lte operators', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('$lt matches records with field strictly less than operand', async () => {
    const result = await db.recordManager.findWhere('orders', { total: { $lt: 100 } });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 1);
  });

  test('$lte matches records with field less than or equal to operand', async () => {
    const result = await db.recordManager.findWhere('orders', { total: { $lte: 100 } });
    assert.equal(result.length, 2);
    assert.ok(result.every(r => r.total <= 100));
  });
});

// ---------------------------------------------------------------------------
// $in / $nin
// ---------------------------------------------------------------------------
describe('$in operator', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('matches records where field value is in the array', async () => {
    const result = await db.recordManager.findWhere('orders', { status: { $in: ['new', 'pending'] } });
    assert.equal(result.length, 2);
    assert.ok(result.every(r => ['new', 'pending'].includes(r.status)));
  });

  test('returns empty array when no value matches', async () => {
    const result = await db.recordManager.findWhere('orders', { status: { $in: ['shipped'] } });
    assert.deepEqual(result, []);
  });

  test('throws TypeError when $in operand is not an array', async () => {
    await assert.rejects(
      () => db.recordManager.findWhere('orders', { status: { $in: 'new' } }),
      TypeError
    );
  });
});

describe('$nin operator', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('matches records where field value is NOT in the array', async () => {
    const result = await db.recordManager.findWhere('orders', { status: { $nin: ['cancelled', 'completed'] } });
    assert.equal(result.length, 2);
    assert.ok(result.every(r => !['cancelled', 'completed'].includes(r.status)));
  });

  test('throws TypeError when $nin operand is not an array', async () => {
    await assert.rejects(
      () => db.recordManager.findWhere('orders', { status: { $nin: 42 } }),
      TypeError
    );
  });
});

// ---------------------------------------------------------------------------
// $exists
// ---------------------------------------------------------------------------
describe('$exists operator', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('$exists: true matches records where field is present (not undefined)', async () => {
    const result = await db.recordManager.findWhere('orders', { address: { $exists: true } });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 3);
  });

  test('$exists: false matches records where field is absent (undefined)', async () => {
    const result = await db.recordManager.findWhere('orders', { address: { $exists: false } });
    assert.equal(result.length, 3);
    assert.ok(result.every(r => r.address === undefined));
  });
});

// ---------------------------------------------------------------------------
// Multiple operators on the same field (AND semantics)
// ---------------------------------------------------------------------------
describe('multiple operators on same field', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('combines $gt and $lt on the same field', async () => {
    const result = await db.recordManager.findWhere('orders', { total: { $gt: 50, $lt: 300 } });
    assert.equal(result.length, 2);
    assert.ok(result.every(r => r.total > 50 && r.total < 300));
  });

  test('combines $gte and $lte on the same field', async () => {
    const result = await db.recordManager.findWhere('orders', { total: { $gte: 100, $lte: 200 } });
    assert.equal(result.length, 2);
    assert.ok(result.every(r => r.total >= 100 && r.total <= 200));
  });
});

// ---------------------------------------------------------------------------
// $and
// ---------------------------------------------------------------------------
describe('$and logical operator', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('matches records satisfying all sub-predicates', async () => {
    const result = await db.recordManager.findWhere('orders', {
      $and: [
        { total: { $gt: 50 } },
        { status: { $ne: 'cancelled' } },
      ],
    });
    assert.equal(result.length, 2);
    assert.ok(result.every(r => r.total > 50 && r.status !== 'cancelled'));
  });

  test('returns empty array when no record satisfies all', async () => {
    const result = await db.recordManager.findWhere('orders', {
      $and: [{ total: { $gt: 200 } }, { status: 'new' }],
    });
    assert.deepEqual(result, []);
  });

  test('throws TypeError when $and operand is not an array', async () => {
    await assert.rejects(
      () => db.recordManager.findWhere('orders', { $and: { total: { $gt: 50 } } }),
      TypeError
    );
  });
});

// ---------------------------------------------------------------------------
// $or
// ---------------------------------------------------------------------------
describe('$or logical operator', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('matches records satisfying at least one sub-predicate', async () => {
    const result = await db.recordManager.findWhere('orders', {
      $or: [{ status: 'new' }, { status: 'cancelled' }],
    });
    assert.equal(result.length, 2);
    assert.ok(result.every(r => r.status === 'new' || r.status === 'cancelled'));
  });

  test('returns empty array when no sub-predicate matches', async () => {
    const result = await db.recordManager.findWhere('orders', {
      $or: [{ status: 'shipped' }, { total: { $gt: 1000 } }],
    });
    assert.deepEqual(result, []);
  });

  test('throws TypeError when $or operand is not an array', async () => {
    await assert.rejects(
      () => db.recordManager.findWhere('orders', { $or: { status: 'new' } }),
      TypeError
    );
  });
});

// ---------------------------------------------------------------------------
// $not
// ---------------------------------------------------------------------------
describe('$not logical operator', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('matches records NOT satisfying the sub-predicate', async () => {
    const result = await db.recordManager.findWhere('orders', {
      $not: { status: 'cancelled' },
    });
    assert.equal(result.length, 3);
    assert.ok(result.every(r => r.status !== 'cancelled'));
  });

  test('$not with operator inside', async () => {
    const result = await db.recordManager.findWhere('orders', {
      $not: { total: { $gt: 100 } },
    });
    assert.equal(result.length, 2);
    assert.ok(result.every(r => r.total <= 100));
  });

  test('throws TypeError when $not operand is not a plain object', async () => {
    await assert.rejects(
      () => db.recordManager.findWhere('orders', { $not: 'new' }),
      TypeError
    );
  });
});

// ---------------------------------------------------------------------------
// Combining $and, $or, $not
// ---------------------------------------------------------------------------
describe('combining logical operators', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('$and containing $or sub-predicate', async () => {
    const result = await db.recordManager.findWhere('orders', {
      $and: [
        { $or: [{ tag: 'a' }, { tag: 'b' }] },
        { total: { $gte: 100 } },
      ],
    });
    assert.equal(result.length, 3);
    assert.ok(result.every(r => r.total >= 100));
  });

  test('$or containing $not sub-predicate', async () => {
    const result = await db.recordManager.findWhere('orders', {
      $or: [
        { $not: { status: 'cancelled' } },
        { total: { $gt: 250 } },
      ],
    });
    // All non-cancelled (3) + cancelled with total > 250 (id:4, total:300) — but id:4 is in both
    assert.equal(result.length, 4);
  });
});

// ---------------------------------------------------------------------------
// Unknown operator
// ---------------------------------------------------------------------------
describe('unknown operator', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('throws TypeError for unknown $-prefixed operator', async () => {
    await assert.rejects(
      () => db.recordManager.findWhere('orders', { total: { $foo: 10 } }),
      TypeError
    );
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility — existing plain-object exact match still works
// ---------------------------------------------------------------------------
describe('backward compatibility', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('plain-object predicate without operators still does exact match', async () => {
    const result = await db.recordManager.findWhere('orders', { status: 'new' });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 1);
  });

  test('nested plain-object predicate still works', async () => {
    const result = await db.recordManager.findWhere('orders', { address: { city: 'Milano' } });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 3);
  });

  test('function predicate still works', async () => {
    const result = await db.recordManager.findWhere('orders', r => r.total > 150);
    assert.equal(result.length, 2);
    assert.ok(result.every(r => r.total > 150));
  });
});
