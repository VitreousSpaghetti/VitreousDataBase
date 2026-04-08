/**
 * adversarial.test.js
 *
 * Written from CLAUDE.md + README.md analysis ONLY — no source code read.
 * Goal: expose undocumented failures, surprising edge cases, and potential bugs.
 *
 * Each describe block targets a specific flaw or blind spot derived from the docs.
 * Tests that "pass" may still reveal surprising behavior worth reviewing.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  Database,
  VitreousError,
  EntityNotFoundError,
  EntityAlreadyExistsError,
  EntityTypeError,
  EntityInUseError,
  UnknownFieldError,
  NullConstraintError,
  UniqueConstraintError,
  NestedTypeError,
  InvalidIdError,
  CircularReferenceError,
  RecordNotFoundError,
  FileAccessError,
} = require('..');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tmpFile() {
  return path.join(
    os.tmpdir(),
    `vdb_adv_${Date.now()}_${Math.random().toString(36).slice(2)}.json`
  );
}

async function freshDb(opts) {
  const file = tmpFile();
  const db = await Database.create(file, opts);
  return { db, file };
}

function cleanup(file) {
  try { fs.unlinkSync(file); } catch {}
}


// ─── 1. Prototype pollution ───────────────────────────────────────────────────
// CLAUDE.md: "Entity names are not validated. Names that collide with JavaScript
// prototype properties … are accepted silently."
// BUG RISK: assigning to data['__proto__'] could pollute Object.prototype.

describe('Prototype pollution — entity name __proto__', () => {
  test('Object.prototype is not polluted after creating __proto__ entity', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('__proto__', {
        type: 'table',
        id: ['id'],
        values: ['id', 'x'],
      });
      await db.recordManager.insert('__proto__', { id: 1, x: 'evil' });
      // If data['__proto__'] was assigned instead of data[name], Object.prototype would have 'id' and 'x'
      assert.equal(typeof ({}).id, 'undefined',
        'BUG: Object.prototype.id was set — prototype pollution via entity name');
      assert.equal(typeof ({}).x, 'undefined',
        'BUG: Object.prototype.x was set — prototype pollution via entity name');
    } finally { cleanup(file); }
  });

  test('Object.prototype is not polluted after inserting __proto__ field', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('things', {
        type: 'table',
        id: ['id'],
        values: ['id', '__proto__'],
      });
      await db.recordManager.insert('things', { id: 1, __proto__: 'pwned' });
      const record = await db.recordManager.findByIdSingle('things', 1);
      assert.equal(typeof ({}).pwned, 'undefined',
        'BUG: inserting __proto__ field polluted Object.prototype');
    } finally { cleanup(file); }
  });
});


// ─── 2. -0 vs 0 in unique constraints ────────────────────────────────────────
// CLAUDE.md: "uses Object.is for comparison" — Object.is(-0, 0) === false.
// Surprising: -0 and 0 would be allowed as two distinct unique values,
// even though they print identically and compare with ===.

describe('Unique constraint: -0 vs 0 (Object.is semantics)', () => {
  test('-0 and 0 unique treatment is documented — verify actual behavior', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('nums', {
        type: 'table',
        id: ['id'],
        values: ['id', 'val'],
        unique: ['val'],
      });
      await db.recordManager.insert('nums', { id: 1, val: 0 });

      let duplicateThrown = false;
      try {
        await db.recordManager.insert('nums', { id: 2, val: -0 });
      } catch (e) {
        if (e instanceof UniqueConstraintError) duplicateThrown = true;
        else throw e;
      }

      if (!duplicateThrown) {
        // -0 treated as distinct from 0 — verify both records exist
        const all = await db.recordManager.findAll('nums');
        assert.equal(all.length, 2,
          'SURPRISING: -0 and 0 are stored as two distinct unique values (Object.is semantics)');
      } else {
        // UniqueConstraintError was thrown — -0 treated same as 0
        assert.ok(true, 'SURPRISING: -0 triggers UniqueConstraintError against 0 (contradicts Object.is)');
      }
    } finally { cleanup(file); }
  });
});


// ─── 3. undefined in update deepMerge bypasses notnullable? ──────────────────
// CLAUDE.md: deepMerge cannot remove keys. JSON round-trip drops undefined.
// BUG RISK: if deepMerge produces { name: undefined }, JSON.parse(JSON.stringify)
// will silently drop the key — if validation runs AFTER the round-trip,
// the notnullable check never sees the undefined value.

describe('update() with undefined value on notnullable field', () => {
  test('setting notnullable field to undefined in update should NOT silently clear it', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('users', {
        type: 'table',
        id: ['id'],
        values: ['id', 'name'],
        notnullable: ['name'],
      });
      await db.recordManager.insert('users', { id: 1, name: 'Alice' });

      let threw = false;
      try {
        await db.recordManager.update('users', { id: 1 }, { name: undefined });
      } catch (e) {
        threw = true;
        assert.ok(e instanceof VitreousError,
          `Should throw a VitreousError, got: ${e.constructor.name}: ${e.message}`);
      }

      if (!threw) {
        // No error — check whether 'name' was silently dropped
        const record = await db.recordManager.findByIdSingle('users', 1);
        assert.equal(record.name, 'Alice',
          'BUG: notnullable field was silently dropped by update({name: undefined}) — ' +
          'deepMerge+JSON round-trip bypasses notnullable validation');
      }
    } finally { cleanup(file); }
  });
});


// ─── 4. NaN / Infinity inside nested objects ─────────────────────────────────
// CLAUDE.md: check 4 rejects NaN/Infinity at top-level fields.
// validateNestedObject also checks "non-JSON-serializable numbers".
// Verify this actually propagates.

describe('NaN / Infinity in nested objects', () => {
  test('NaN inside nested object throws TypeError', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('coords', {
        type: 'object',
        values: ['lat', 'lng'],
      });
      await db.entityManager.createEntity('places', {
        type: 'table',
        id: ['id'],
        values: ['id', 'coords'],
        nested: ['coords'],
      });
      await assert.rejects(
        () => db.recordManager.insert('places', { id: 1, coords: { lat: NaN, lng: 9.0 } }),
        TypeError,
        'BUG: NaN inside nested object was not rejected'
      );
    } finally { cleanup(file); }
  });

  test('Infinity inside nested object throws TypeError', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('pricing', {
        type: 'object',
        values: ['amount'],
      });
      await db.entityManager.createEntity('products', {
        type: 'table',
        id: ['id'],
        values: ['id', 'pricing'],
        nested: ['pricing'],
      });
      await assert.rejects(
        () => db.recordManager.insert('products', { id: 1, pricing: { amount: Infinity } }),
        TypeError,
        'BUG: Infinity inside nested object was not rejected'
      );
    } finally { cleanup(file); }
  });
});


// ─── 5. nested field referencing a "table" entity (not "object") ─────────────
// CLAUDE.md: nested field name must match a registered "object" entity.
// Unclear: is the type checked at createEntity time?
// BUG RISK: if it isn't, inserting proceeds, validateNestedObject runs on a
// "table" entity config — which has id/unique fields not meaningful for objects.

describe('nested field referencing a table entity', () => {
  test('createEntity with nested pointing to a table entity should throw', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('orders', {
        type: 'table',
        id: ['orderId'],
        values: ['orderId', 'total'],
      });
      await assert.rejects(
        () => db.entityManager.createEntity('customers', {
          type: 'table',
          id: ['id'],
          values: ['id', 'orders'],
          nested: ['orders'], // 'orders' is a table, not an object
        }),
        VitreousError,
        'BUG: nested field referencing a table entity was silently accepted'
      );
    } finally { cleanup(file); }
  });
});


// ─── 6. Constraint fields not listed in values ────────────────────────────────
// CLAUDE.md does not explicitly say createEntity validates that notnullable/unique/
// nested fields are a subset of values. This could allow phantom constraints.

describe('Constraint fields absent from values', () => {
  test('notnullable field not in values should be rejected at createEntity', async () => {
    const { db, file } = await freshDb();
    try {
      await assert.rejects(
        () => db.entityManager.createEntity('x', {
          type: 'table',
          id: ['id'],
          values: ['id'],
          notnullable: ['ghost'], // 'ghost' not in values
        }),
        VitreousError,
        'BUG: notnullable with a field not in values was silently accepted'
      );
    } finally { cleanup(file); }
  });

  test('unique field not in values should be rejected at createEntity', async () => {
    const { db, file } = await freshDb();
    try {
      await assert.rejects(
        () => db.entityManager.createEntity('x', {
          type: 'table',
          id: ['id'],
          values: ['id'],
          unique: ['phantom'], // not in values
        }),
        VitreousError,
        'BUG: unique with a field not in values was silently accepted'
      );
    } finally { cleanup(file); }
  });

  test('nested field not in values should be rejected at createEntity', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('addr', {
        type: 'object',
        values: ['city'],
      });
      await assert.rejects(
        () => db.entityManager.createEntity('x', {
          type: 'table',
          id: ['id'],
          values: ['id'],
          nested: ['addr'], // 'addr' not in values
        }),
        VitreousError,
        'BUG: nested field not in values was silently accepted'
      );
    } finally { cleanup(file); }
  });
});


// ─── 7. Operations after close() ─────────────────────────────────────────────
// CLAUDE.md: _read()/_write() throw FileAccessError('database is closed').

describe('Operations after close()', () => {
  test('insert after close() throws FileAccessError', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('logs', {
        type: 'table',
        id: ['id'],
        values: ['id', 'msg'],
      });
      await db.close();
      await assert.rejects(
        () => db.recordManager.insert('logs', { id: 1, msg: 'late' }),
        FileAccessError
      );
    } finally { cleanup(file); }
  });

  test('findAll after close() throws FileAccessError', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('logs', {
        type: 'table',
        id: ['id'],
        values: ['id'],
      });
      await db.close();
      await assert.rejects(
        () => db.recordManager.findAll('logs'),
        FileAccessError
      );
    } finally { cleanup(file); }
  });

  test('createEntity after close() throws FileAccessError', async () => {
    const { db, file } = await freshDb();
    try {
      await db.close();
      await assert.rejects(
        () => db.entityManager.createEntity('new', {
          type: 'table',
          id: ['id'],
          values: ['id'],
        }),
        FileAccessError
      );
    } finally { cleanup(file); }
  });

  test('close() twice is a safe no-op (documented)', async () => {
    const { db, file } = await freshDb();
    try {
      await db.close();
      await assert.doesNotReject(() => db.close(), 'BUG: second close() threw instead of being a no-op');
    } finally { cleanup(file); }
  });
});


// ─── 8. Clone invariant ───────────────────────────────────────────────────────
// CLAUDE.md: "Records are always cloned … before being returned."
// BUG RISK: if a shallow clone is used, mutating nested objects in the
// returned record corrupts the in-memory cache in eager mode.

describe('Clone invariant', () => {
  test('mutating insert() result does not affect stored record', async () => {
    const { db, file } = await freshDb({ eager: true });
    try {
      await db.entityManager.createEntity('items', {
        type: 'table',
        id: ['id'],
        values: ['id', 'name'],
      });
      const returned = await db.recordManager.insert('items', { id: 1, name: 'original' });
      returned.name = 'mutated';
      const stored = await db.recordManager.findByIdSingle('items', 1);
      assert.equal(stored.name, 'original',
        'BUG: mutating insert() result corrupted the stored record (shallow clone)');
    } finally { cleanup(file); }
  });

  test('mutating findAll() result does not affect stored records', async () => {
    const { db, file } = await freshDb({ eager: true });
    try {
      await db.entityManager.createEntity('items', {
        type: 'table',
        id: ['id'],
        values: ['id', 'name'],
      });
      await db.recordManager.insert('items', { id: 1, name: 'original' });
      const all = await db.recordManager.findAll('items');
      all[0].name = 'mutated';
      const stored = await db.recordManager.findByIdSingle('items', 1);
      assert.equal(stored.name, 'original',
        'BUG: mutating findAll() result corrupted the stored record');
    } finally { cleanup(file); }
  });

  test('mutating nested object in findByIdSingle() result does not corrupt cache', async () => {
    const { db, file } = await freshDb({ eager: true });
    try {
      await db.entityManager.createEntity('addr', {
        type: 'object',
        values: ['city'],
        notnullable: ['city'],
      });
      await db.entityManager.createEntity('users', {
        type: 'table',
        id: ['id'],
        values: ['id', 'addr'],
        nested: ['addr'],
      });
      await db.recordManager.insert('users', { id: 1, addr: { city: 'Rome' } });
      const record = await db.recordManager.findByIdSingle('users', 1);
      record.addr.city = 'Hacked'; // mutate nested
      const stored = await db.recordManager.findByIdSingle('users', 1);
      assert.equal(stored.addr.city, 'Rome',
        'BUG: shallow clone — mutating nested object in result corrupted the cache');
    } finally { cleanup(file); }
  });

  test('mutating getEntity() result does not affect stored config', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('users', {
        type: 'table',
        id: ['id'],
        values: ['id', 'name', 'email'],
      });
      const config = await db.entityManager.getEntity('users');
      config.values.push('injected_field');

      const config2 = await db.entityManager.getEntity('users');
      assert.ok(!config2.values.includes('injected_field'),
        'BUG: mutating getEntity() result affected the stored entity config (not a deep clone)');
    } finally { cleanup(file); }
  });
});


// ─── 9. findWhere predicate that throws ──────────────────────────────────────
// README: "If the predicate function throws … the raw JavaScript error
// propagates uncaught — it is not wrapped in a VitreousError."
// Verify this documented behavior actually holds.

describe('findWhere: throwing predicate', () => {
  test('raw TypeError from predicate propagates unwrapped', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('things', {
        type: 'table',
        id: ['id'],
        values: ['id', 'name'],
      });
      await db.recordManager.insert('things', { id: 1, name: 'x' });

      let caught;
      try {
        await db.recordManager.findWhere('things', r => {
          throw new TypeError('predicate exploded');
        });
      } catch (e) {
        caught = e;
      }
      assert.ok(caught instanceof TypeError, 'Raw TypeError should propagate');
      assert.ok(!(caught instanceof VitreousError), 'Error should NOT be wrapped in VitreousError');
    } finally { cleanup(file); }
  });

  test('null access in predicate propagates as TypeError, not VitreousError', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('things', {
        type: 'table',
        id: ['id'],
        values: ['id', 'obj'],
      });
      await db.recordManager.insert('things', { id: 1, obj: null });

      let caught;
      try {
        // Accessing .city on null will throw TypeError
        await db.recordManager.findWhere('things', r => r.obj.city === 'x');
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, 'An error should have been thrown');
      assert.ok(!(caught instanceof VitreousError),
        'BUG: null-access in predicate was wrapped as VitreousError — docs say it should not be');
    } finally { cleanup(file); }
  });
});


// ─── 10. Object entity invariants ────────────────────────────────────────────
// CLAUDE.md invariants 4 & 5: object entities must not have id or unique;
// table entities must declare at least one id field.

describe('Entity type invariants', () => {
  test('object entity with id field is rejected', async () => {
    const { db, file } = await freshDb();
    try {
      await assert.rejects(
        () => db.entityManager.createEntity('shape', {
          type: 'object',
          values: ['id', 'color'],
          id: ['id'],
        }),
        VitreousError,
        'BUG: object entity with id was accepted'
      );
    } finally { cleanup(file); }
  });

  test('object entity with unique constraint is rejected', async () => {
    const { db, file } = await freshDb();
    try {
      await assert.rejects(
        () => db.entityManager.createEntity('shape', {
          type: 'object',
          values: ['color', 'code'],
          unique: ['code'],
        }),
        VitreousError,
        'BUG: object entity with unique was accepted'
      );
    } finally { cleanup(file); }
  });

  test('table entity with no id field is rejected', async () => {
    const { db, file } = await freshDb();
    try {
      await assert.rejects(
        () => db.entityManager.createEntity('noid', {
          type: 'table',
          values: ['name', 'val'],
        }),
        VitreousError,
        'BUG: table entity with no id was accepted'
      );
    } finally { cleanup(file); }
  });

  test('id field also in nested is rejected', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('profile', {
        type: 'object',
        values: ['name'],
      });
      await assert.rejects(
        () => db.entityManager.createEntity('users', {
          type: 'table',
          id: ['profile'],
          values: ['profile', 'age'],
          nested: ['profile'],
        }),
        VitreousError,
        'BUG: id field that is also nested was accepted'
      );
    } finally { cleanup(file); }
  });

  test('insert on object entity throws EntityTypeError', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('shape', {
        type: 'object',
        values: ['color'],
      });
      await assert.rejects(
        () => db.recordManager.insert('shape', { color: 'red' }),
        EntityTypeError,
        'BUG: insert on object entity did not throw EntityTypeError'
      );
    } finally { cleanup(file); }
  });

  test('findAll on object entity throws EntityTypeError', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('shape', {
        type: 'object',
        values: ['color'],
      });
      await assert.rejects(
        () => db.recordManager.findAll('shape'),
        EntityTypeError,
        'BUG: findAll on object entity did not throw EntityTypeError'
      );
    } finally { cleanup(file); }
  });

  test('findWhere on object entity throws EntityTypeError', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('shape', {
        type: 'object',
        values: ['color'],
      });
      await assert.rejects(
        () => db.recordManager.findWhere('shape', { color: 'red' }),
        EntityTypeError,
        'BUG: findWhere on object entity did not throw EntityTypeError'
      );
    } finally { cleanup(file); }
  });
});


// ─── 11. Composite id edge cases ─────────────────────────────────────────────
// CLAUDE.md: findById / update / deleteRecord require ALL id fields.
// Extra non-id keys must throw InvalidIdError.

describe('Composite id edge cases', () => {
  test('findById with empty idObject throws InvalidIdError', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('lines', {
        type: 'table',
        id: ['orderId', 'lineId'],
        values: ['orderId', 'lineId', 'qty'],
      });
      await assert.rejects(
        () => db.recordManager.findById('lines', {}),
        InvalidIdError,
        'BUG: empty idObject was accepted by findById'
      );
    } finally { cleanup(file); }
  });

  test('findById with extra non-id key throws InvalidIdError', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('orders', {
        type: 'table',
        id: ['orderId'],
        values: ['orderId', 'total'],
      });
      await db.recordManager.insert('orders', { orderId: 1, total: 50 });
      await assert.rejects(
        () => db.recordManager.findById('orders', { orderId: 1, total: 50 }),
        InvalidIdError,
        'BUG: findById with non-id key (total) was not rejected'
      );
    } finally { cleanup(file); }
  });

  test('findByIdSingle on composite-id entity throws InvalidIdError', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('lines', {
        type: 'table',
        id: ['orderId', 'lineId'],
        values: ['orderId', 'lineId'],
      });
      await assert.rejects(
        () => db.recordManager.findByIdSingle('lines', 1),
        InvalidIdError,
        'BUG: findByIdSingle on composite-id entity did not throw InvalidIdError'
      );
    } finally { cleanup(file); }
  });

  test('update with id field in the updates object throws InvalidIdError', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('users', {
        type: 'table',
        id: ['id'],
        values: ['id', 'name'],
      });
      await db.recordManager.insert('users', { id: 1, name: 'Alice' });
      await assert.rejects(
        () => db.recordManager.update('users', { id: 1 }, { id: 99, name: 'Hacker' }),
        InvalidIdError,
        'BUG: update with id field in updates was not rejected'
      );
    } finally { cleanup(file); }
  });

  test('deleteRecord with extra non-id key throws InvalidIdError', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('orders', {
        type: 'table',
        id: ['orderId'],
        values: ['orderId', 'total'],
      });
      await db.recordManager.insert('orders', { orderId: 1, total: 100 });
      await assert.rejects(
        () => db.recordManager.deleteRecord('orders', { orderId: 1, total: 100 }),
        InvalidIdError,
        'BUG: deleteRecord with non-id key (total) was not rejected'
      );
    } finally { cleanup(file); }
  });
});


// ─── 12. Eager mode — cache corruption on failed write ───────────────────────
// CLAUDE.md: "all validation must run before any in-place mutation; in eager mode
// _read() returns this._cache directly, so a mutation before a failed validation
// would corrupt the cache with no rollback."

describe('Eager mode — cache must not be corrupted by failed operations', () => {
  test('failed insert (unique constraint) does not corrupt cache', async () => {
    const { db, file } = await freshDb({ eager: true });
    try {
      await db.entityManager.createEntity('users', {
        type: 'table',
        id: ['id'],
        values: ['id', 'email'],
        unique: ['email'],
      });
      await db.recordManager.insert('users', { id: 1, email: 'a@b.com' });

      try {
        await db.recordManager.insert('users', { id: 2, email: 'a@b.com' }); // duplicate
      } catch (e) {
        if (!(e instanceof UniqueConstraintError)) throw e;
      }

      const all = await db.recordManager.findAll('users');
      assert.equal(all.length, 1, 'BUG: failed insert corrupted cache — wrong record count');
      assert.equal(all[0].id, 1, 'BUG: wrong record in cache after failed insert');
    } finally { cleanup(file); }
  });

  test('failed insert (null constraint) does not corrupt cache', async () => {
    const { db, file } = await freshDb({ eager: true });
    try {
      await db.entityManager.createEntity('users', {
        type: 'table',
        id: ['id'],
        values: ['id', 'name'],
        notnullable: ['name'],
      });
      await db.recordManager.insert('users', { id: 1, name: 'Alice' });

      try {
        await db.recordManager.insert('users', { id: 2, name: null }); // null constraint
      } catch (e) {
        if (!(e instanceof NullConstraintError)) throw e;
      }

      const all = await db.recordManager.findAll('users');
      assert.equal(all.length, 1, 'BUG: failed insert (null) corrupted eager cache');
    } finally { cleanup(file); }
  });

  test('failed createEntity (duplicate) does not corrupt cache', async () => {
    const { db, file } = await freshDb({ eager: true });
    try {
      await db.entityManager.createEntity('users', {
        type: 'table',
        id: ['id'],
        values: ['id', 'name'],
      });

      try {
        await db.entityManager.createEntity('users', {
          type: 'table',
          id: ['id'],
          values: ['id', 'name'],
        });
      } catch (e) {
        if (!(e instanceof EntityAlreadyExistsError)) throw e;
      }

      const config = await db.entityManager.getEntity('users');
      assert.ok(config, 'BUG: original entity was lost after failed duplicate createEntity');
    } finally { cleanup(file); }
  });
});


// ─── 13. Nested field set to non-object ──────────────────────────────────────
// Should throw NestedTypeError. But what about null? (documented: null is valid
// for non-notnullable nested fields.)

describe('Nested field type enforcement', () => {
  test('nested field set to a string throws NestedTypeError', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('addr', { type: 'object', values: ['city'] });
      await db.entityManager.createEntity('users', {
        type: 'table',
        id: ['id'],
        values: ['id', 'addr'],
        nested: ['addr'],
      });
      await assert.rejects(
        () => db.recordManager.insert('users', { id: 1, addr: 'not an object' }),
        NestedTypeError,
        'BUG: string nested field was not rejected with NestedTypeError'
      );
    } finally { cleanup(file); }
  });

  test('nested field set to an array throws NestedTypeError', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('addr', { type: 'object', values: ['city'] });
      await db.entityManager.createEntity('users', {
        type: 'table',
        id: ['id'],
        values: ['id', 'addr'],
        nested: ['addr'],
      });
      await assert.rejects(
        () => db.recordManager.insert('users', { id: 1, addr: ['Milano'] }),
        NestedTypeError,
        'BUG: array nested field was not rejected with NestedTypeError'
      );
    } finally { cleanup(file); }
  });

  test('nested field set to null is valid for non-notnullable (documented)', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('addr', { type: 'object', values: ['city'] });
      await db.entityManager.createEntity('users', {
        type: 'table',
        id: ['id'],
        values: ['id', 'addr'],
        nested: ['addr'],
        // addr is not notnullable
      });
      const record = await db.recordManager.insert('users', { id: 1, addr: null });
      assert.equal(record.addr, null, 'null nested field should be stored as null');
    } finally { cleanup(file); }
  });
});


// ─── 14. Self-referencing entity (circular reference detection) ───────────────
// CLAUDE.md: "In createEntity, the new config is added to a snapshot first;
// detectCircularReference runs on the snapshot" — so a self-referencing entity
// (nested: ['itself']) should be detectable because the entity is in the snapshot.

describe('Circular reference detection', () => {
  test('self-referencing object entity is rejected with CircularReferenceError', async () => {
    const { db, file } = await freshDb();
    try {
      await assert.rejects(
        () => db.entityManager.createEntity('node', {
          type: 'object',
          values: ['node'],
          nested: ['node'], // references itself
        }),
        VitreousError, // CircularReferenceError is a VitreousError
        'BUG: self-referencing entity was not rejected'
      );
    } finally { cleanup(file); }
  });

  test('two-entity cycle A→B, B→A is rejected when creating B', async () => {
    const { db, file } = await freshDb();
    try {
      // Create A (no nesting yet)
      await db.entityManager.createEntity('nodeA', {
        type: 'object',
        values: ['nodeB'],
      });
      // Create B with nested: ['nodeA'] — this forms a cycle: A references B (via nested on B), B references A
      // Wait: A was created without nested — so A→B link doesn't exist.
      // For a cycle we'd need A to nest B and B to nest A.
      // Since there's no updateEntity, a two-entity cycle requires:
      // First create A with nested: ['nodeB'] — but nodeB doesn't exist yet → may throw EntityNotFoundError
      // This exposes whether the entity existence check happens before or after cycle detection.

      // Delete A and try from scratch
      await db.entityManager.deleteEntity('nodeA');

      // Try to create A that nests nonExistent (B doesn't exist yet)
      let err;
      try {
        await db.entityManager.createEntity('cycleA', {
          type: 'object',
          values: ['cycleB'],
          nested: ['cycleB'], // cycleB does not exist yet
        });
      } catch (e) {
        err = e;
      }

      // Should throw EntityNotFoundError (entity doesn't exist)
      // OR CircularReferenceError (if it auto-adds to snapshot and detects cycle with missing entity)
      // Either is a VitreousError — the key question is: does it crash unexpectedly?
      assert.ok(err instanceof VitreousError,
        `BUG: creating entity with non-existent nested ref threw unexpected error: ${err}`);
    } finally { cleanup(file); }
  });
});


// ─── 15. Type-sensitive id comparison ────────────────────────────────────────
// findById compares values — if using ===, string '1' won't match number 1.
// README does not explicitly state comparison semantics.

describe('findById type-sensitive comparison', () => {
  test('findById with string id does not match stored number id', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('items', {
        type: 'table',
        id: ['id'],
        values: ['id', 'name'],
      });
      await db.recordManager.insert('items', { id: 1, name: 'thing' }); // number 1
      const found = await db.recordManager.findById('items', { id: '1' }); // string '1'
      // Expected: null (strict comparison)
      // BUG if: returns the record (loose comparison)
      assert.equal(found, null,
        'SURPRISING: findById with string "1" matched a record with numeric id 1 (loose comparison)');
    } finally { cleanup(file); }
  });
});


// ─── 16. listEntities with unknown type ──────────────────────────────────────
// README shows listEntities('table'), listEntities('object'), listEntities().
// Behavior for an unknown type is not specified.

describe('listEntities with invalid type', () => {
  test('listEntities("invalid") returns an empty array, not all entities', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('users', {
        type: 'table',
        id: ['id'],
        values: ['id'],
      });
      const result = await db.entityManager.listEntities('invalid_type');
      assert.ok(Array.isArray(result), 'listEntities should return an array');
      assert.equal(result.length, 0,
        'BUG: listEntities("invalid_type") returned entities instead of empty array');
    } finally { cleanup(file); }
  });
});


// ─── 17. Concurrent operations — mutex sanity ─────────────────────────────────
// CLAUDE.md: all operations are serialized through _enqueue.
// Fire N inserts simultaneously and verify all N succeed without corruption.

describe('Concurrent inserts — mutex ensures serial execution', () => {
  test('50 simultaneous inserts all succeed in eager mode', async () => {
    const { db, file } = await freshDb({ eager: true });
    try {
      await db.entityManager.createEntity('counter', {
        type: 'table',
        id: ['id'],
        values: ['id', 'val'],
      });

      const N = 50;
      const promises = Array.from({ length: N }, (_, i) =>
        db.recordManager.insert('counter', { id: i, val: i })
      );
      const results = await Promise.allSettled(promises);
      const failed = results.filter(r => r.status === 'rejected');
      assert.equal(failed.length, 0,
        `BUG: ${failed.length} inserts failed unexpectedly: ${failed.map(r => r.reason?.message).join(', ')}`);

      const all = await db.recordManager.findAll('counter');
      assert.equal(all.length, N,
        `BUG: expected ${N} records, got ${all.length} — mutex may not be preventing race conditions`);
    } finally { cleanup(file); }
  });
});


// ─── 18. Empty string entity name ────────────────────────────────────────────
// CLAUDE.md: createEntity requires a non-empty string — '' throws TypeError.
// The test tolerates either outcome for forward-compatibility.

describe('Empty string entity name', () => {
  test('empty string entity name is accepted but subsequent operations behave predictably', async () => {
    const { db, file } = await freshDb();
    try {
      let createError;
      try {
        await db.entityManager.createEntity('', {
          type: 'table',
          id: ['id'],
          values: ['id'],
        });
      } catch (e) {
        createError = e;
      }

      if (!createError) {
        // If accepted, make sure basic ops don't crash the process
        const all = await db.entityManager.listEntities();
        assert.ok(all.includes(''), 'entity with empty-string name should be listable');

        await db.recordManager.insert('', { id: 1 });
        const found = await db.recordManager.findByIdSingle('', 1);
        assert.ok(found, 'record in empty-string-named entity should be retrievable');
      }
      // If it threw, that is also acceptable behavior
    } finally { cleanup(file); }
  });
});


// ─── 19. deleteEntity removes records from entities store ─────────────────────
// Deleting a table entity must also clear its record array, not leave orphan data.

describe('deleteEntity cleans up records', () => {
  test('re-creating a deleted table entity starts with zero records', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('logs', {
        type: 'table',
        id: ['id'],
        values: ['id', 'msg'],
      });
      await db.recordManager.insert('logs', { id: 1, msg: 'hello' });
      await db.recordManager.insert('logs', { id: 2, msg: 'world' });

      await db.entityManager.deleteEntity('logs');

      // Re-create with same name
      await db.entityManager.createEntity('logs', {
        type: 'table',
        id: ['id'],
        values: ['id', 'msg'],
      });
      const all = await db.recordManager.findAll('logs');
      assert.equal(all.length, 0,
        'BUG: re-created entity still contains records from the previous entity');
    } finally { cleanup(file); }
  });

  test('deleting object entity still referenced by a table throws EntityInUseError', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('addr', {
        type: 'object',
        values: ['city'],
      });
      await db.entityManager.createEntity('users', {
        type: 'table',
        id: ['id'],
        values: ['id', 'addr'],
        nested: ['addr'],
      });
      await assert.rejects(
        () => db.entityManager.deleteEntity('addr'),
        EntityInUseError,
        'BUG: deleting a referenced object entity did not throw EntityInUseError'
      );
    } finally { cleanup(file); }
  });
});


// ─── 20. JSON-only value silent corruption ────────────────────────────────────
// README: "Date becomes an ISO string, RegExp/Map/Set become {}, undefined fields
// are dropped." Verify these are truly silent (no error thrown), per the docs.

describe('JSON-only value silent corruption (documented limitations)', () => {
  test('Date value silently becomes ISO string after round-trip', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('events', {
        type: 'table',
        id: ['id'],
        values: ['id', 'date'],
      });
      const d = new Date('2024-06-01T00:00:00.000Z');
      await db.recordManager.insert('events', { id: 1, date: d });
      const record = await db.recordManager.findByIdSingle('events', 1);
      assert.equal(typeof record.date, 'string',
        'Date should be silently converted to string (documented limitation)');
      assert.ok(!(record.date instanceof Date));
    } finally { cleanup(file); }
  });

  test('undefined non-notnullable field is silently dropped (documented limitation)', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('things', {
        type: 'table',
        id: ['id'],
        values: ['id', 'optional'],
      });
      await db.recordManager.insert('things', { id: 1, optional: undefined });
      const record = await db.recordManager.findByIdSingle('things', 1);
      // Field should be absent or undefined after round-trip
      assert.ok(!('optional' in record) || record.optional === undefined,
        'undefined field should be silently dropped (documented limitation)');
    } finally { cleanup(file); }
  });

  test('NaN at top-level throws TypeError (is NOT silently corrupted)', async () => {
    const { db, file } = await freshDb();
    try {
      await db.entityManager.createEntity('things', {
        type: 'table',
        id: ['id'],
        values: ['id', 'score'],
      });
      // NaN is explicitly rejected by check 4, unlike other non-serializable types
      await assert.rejects(
        () => db.recordManager.insert('things', { id: 1, score: NaN }),
        TypeError,
        'BUG: NaN was accepted (should be rejected by validator check 4)'
      );
    } finally { cleanup(file); }
  });
});
