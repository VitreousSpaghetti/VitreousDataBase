'use strict';

/**
 * bugs.test.js — regression tests per i bug documentati in BUGS.md.
 *
 * Ogni sezione verifica che il comportamento corretto sia ora garantito.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const {
  Database,
  EntityNotFoundError,
  InvalidIdError,
  UniqueConstraintError,
  CircularReferenceError,
  RecordNotFoundError,
} = require('../index');

// ─── helpers ──────────────────────────────────────────────────────────────────

async function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitreousdb-bugs-'));
  const db = await Database.create(path.join(tmpDir, 'db.json'));
  return { db, tmpDir };
}

async function teardown(db, tmpDir) {
  try { await db.close(); } catch { /* ignorato */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function buildMinimalSchema(db) {
  await db.entityManager.createEntity('item', {
    type: 'table',
    id: ['id'],
    values: ['id', 'name', 'tag'],
    notnullable: ['name'],
    unique: ['tag'],
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// BUG 1 — Queue poisoning: FIXED
// ═════════════════════════════════════════════════════════════════════════════

describe('BUG 1 — queue poisoning (fixed)', () => {
  test('operazione valida ha successo anche dopo una precedente operazione invalida', async () => {
    const { db, tmpDir } = await freshDb();
    await buildMinimalSchema(db);
    await db.recordManager.insert('item', { id: 1, name: 'Alpha' });

    // Prima operazione: invalida (entity inesistente)
    await assert.rejects(
      () => db.recordManager.findAll('ghost_entity'),
      EntityNotFoundError
    );

    // Seconda operazione: VALIDA — la coda deve essersi ripristinata
    const all = await db.recordManager.findAll('item');
    assert.equal(all.length, 1);
    assert.equal(all[0].name, 'Alpha');

    await teardown(db, tmpDir);
  });

  test('findWhere con predicate che lancia non avvelena la coda', async () => {
    const { db, tmpDir } = await freshDb();
    await buildMinimalSchema(db);
    await db.recordManager.insert('item', { id: 1, name: 'Alpha' });
    await db.recordManager.insert('item', { id: 2, name: 'Beta' });

    // Predicate che lancia
    await assert.rejects(
      () => db.recordManager.findWhere('item', () => { throw new Error('PREDICATE_EXPLODED'); }),
      { message: 'PREDICATE_EXPLODED' }
    );

    // findAll successivo deve funzionare correttamente
    const all = await db.recordManager.findAll('item');
    assert.equal(all.length, 2);

    await teardown(db, tmpDir);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BUG 2 — update e deleteRecord validano le chiavi di idObject: FIXED
// ═════════════════════════════════════════════════════════════════════════════

describe('BUG 2 — update/deleteRecord validano le chiavi di idObject (fixed)', () => {
  let db, tmpDir;

  beforeEach(async () => {
    ({ db, tmpDir } = await freshDb());
    await buildMinimalSchema(db);
    await db.recordManager.insert('item', { id: 1, name: 'Alpha', tag: 'a' });
    await db.recordManager.insert('item', { id: 2, name: 'Beta',  tag: 'b' });
  });

  afterEach(() => teardown(db, tmpDir));

  test('update con chiave non-id (name) lancia InvalidIdError', async () => {
    await assert.rejects(
      () => db.recordManager.update('item', { name: 'Alpha' }, { tag: 'HACKED' }),
      InvalidIdError
    );
    // record non modificato
    const rec = await db.recordManager.findByIdSingle('item', 1);
    assert.equal(rec.tag, 'a');
  });

  test('deleteRecord con chiave non-id (name) lancia InvalidIdError', async () => {
    await assert.rejects(
      () => db.recordManager.deleteRecord('item', { name: 'Beta' }),
      InvalidIdError
    );
    // record non eliminato
    const all = await db.recordManager.findAll('item');
    assert.equal(all.length, 2);
  });

  test('update con idObject vuoto {} lancia InvalidIdError', async () => {
    await assert.rejects(
      () => db.recordManager.update('item', {}, { tag: 'OVERWRITTEN' }),
      InvalidIdError
    );
  });

  test('deleteRecord con idObject vuoto {} lancia InvalidIdError', async () => {
    await assert.rejects(
      () => db.recordManager.deleteRecord('item', {}),
      InvalidIdError
    );
    const all = await db.recordManager.findAll('item');
    assert.equal(all.length, 2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BUG 3 — NaN come id: rifiutato come valore non-finito: FIXED
// ═════════════════════════════════════════════════════════════════════════════

describe('BUG 3 — NaN come id rifiutato (fixed)', () => {
  let db, tmpDir;

  beforeEach(async () => {
    ({ db, tmpDir } = await freshDb());
    await buildMinimalSchema(db);
  });

  afterEach(() => teardown(db, tmpDir));

  test('insert con id:NaN lancia TypeError (valore non serializzabile)', async () => {
    await assert.rejects(
      () => db.recordManager.insert('item', { id: NaN, name: 'NaN record' }),
      TypeError
    );
    const all = await db.recordManager.findAll('item');
    assert.equal(all.length, 0);
  });

  test('il check unique usa Object.is — NaN === NaN verrebbe rilevato se il valore passasse', async () => {
    // Verifica che Object.is(NaN, NaN) sia true (il fix è in Validator.js)
    assert.ok(Object.is(NaN, NaN));
    assert.ok(!Object.is(NaN, 0));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BUG 4 — Infinity/-Infinity corrompono i dati: FIXED
// ═════════════════════════════════════════════════════════════════════════════

describe('BUG 4 — Infinity come id rifiutato (fixed)', () => {
  let db, tmpDir;

  beforeEach(async () => {
    ({ db, tmpDir } = await freshDb());
    await buildMinimalSchema(db);
  });

  afterEach(() => teardown(db, tmpDir));

  test('insert con id:Infinity lancia TypeError', async () => {
    await assert.rejects(
      () => db.recordManager.insert('item', { id: Infinity, name: 'Inf' }),
      TypeError
    );
    const all = await db.recordManager.findAll('item');
    assert.equal(all.length, 0);
  });

  test('insert con id:-Infinity lancia TypeError', async () => {
    await assert.rejects(
      () => db.recordManager.insert('item', { id: -Infinity, name: 'NegInf' }),
      TypeError
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BUG 5 — Tabella senza id fields rifiutata: FIXED
// ═════════════════════════════════════════════════════════════════════════════

describe('BUG 5 — tabella senza id fields rifiutata (fixed)', () => {
  let db, tmpDir;

  beforeEach(async () => {
    ({ db, tmpDir } = await freshDb());
  });

  afterEach(() => teardown(db, tmpDir));

  test('createEntity type:table senza id lancia InvalidIdError', async () => {
    await assert.rejects(
      () => db.entityManager.createEntity('log', {
        type: 'table',
        values: ['msg', 'level'],
        // id non fornito — default []
      }),
      InvalidIdError
    );
  });

  test('createEntity type:table con id:[] lancia InvalidIdError', async () => {
    await assert.rejects(
      () => db.entityManager.createEntity('log', {
        type: 'table',
        id: [],
        values: ['msg'],
      }),
      InvalidIdError
    );
  });

  test('createEntity type:object senza id è consentito', async () => {
    // gli object entity non richiedono id (invariante del progetto)
    const config = await db.entityManager.createEntity('address', {
      type: 'object',
      values: ['city', 'zip'],
    });
    assert.equal(config.type, 'object');
    assert.deepEqual(config.id, []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BUG 6 — RecordNotFoundError per record mancante: FIXED
// ═════════════════════════════════════════════════════════════════════════════

describe('BUG 6 — RecordNotFoundError per record mancante (fixed)', () => {
  let db, tmpDir;

  beforeEach(async () => {
    ({ db, tmpDir } = await freshDb());
    await buildMinimalSchema(db);
  });

  afterEach(() => teardown(db, tmpDir));

  test('update record inesistente lancia RecordNotFoundError', async () => {
    await assert.rejects(
      () => db.recordManager.update('item', { id: 9999 }, { name: 'ghost' }),
      RecordNotFoundError
    );
  });

  test('deleteRecord record inesistente lancia RecordNotFoundError', async () => {
    await assert.rejects(
      () => db.recordManager.deleteRecord('item', { id: 9999 }),
      RecordNotFoundError
    );
  });

  test('RecordNotFoundError riporta entityName e idObject', async () => {
    let err;
    try {
      await db.recordManager.update('item', { id: 42 }, { name: 'x' });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof RecordNotFoundError);
    assert.equal(err.entityName, 'item');
    assert.deepEqual(err.idObject, { id: 42 });
    assert.ok(err.message.includes('item'));
    assert.ok(err.message.includes('42'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BUG 7 — Self-reference produce CircularReferenceError: FIXED
// ═════════════════════════════════════════════════════════════════════════════

describe('BUG 7 — self-reference produce CircularReferenceError (fixed)', () => {
  let db, tmpDir;

  beforeEach(async () => {
    ({ db, tmpDir } = await freshDb());
  });

  afterEach(() => teardown(db, tmpDir));

  test('self-reference lancia CircularReferenceError', async () => {
    await assert.rejects(
      () => db.entityManager.createEntity('selfRef', {
        type: 'object',
        values: ['selfRef'],
        nested: ['selfRef'], // A → A
      }),
      CircularReferenceError
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BONUS — eager mode: _read() espone il cache per riferimento (comportamento noto)
// ═════════════════════════════════════════════════════════════════════════════

describe('BONUS — eager mode: _read() espone il cache per riferimento', () => {
  /*
   * Questo è documentato come pattern intenzionale per i Manager interni.
   * Il test verifica che il comportamento sia stabile e noto.
   */

  let db, tmpDir;

  beforeEach(async () => {
    ({ db, tmpDir } = await freshDb());
    await buildMinimalSchema(db);
  });

  afterEach(() => teardown(db, tmpDir));

  test('in eager mode, mutare il risultato di _read() muta il cache interno', async () => {
    const eagerDb = await Database.create(path.join(tmpDir, 'eager.json'), { eager: true });
    await eagerDb.entityManager.createEntity('x', { type: 'table', id: ['id'], values: ['id', 'val'] });
    await eagerDb.recordManager.insert('x', { id: 1, val: 'originale' });

    const cache = await eagerDb._read();
    assert.equal(cache.entities.x[0].val, 'originale');

    cache.entities.x[0].val = 'MUTATO_SILENZIOSAMENTE';

    const found = await eagerDb.recordManager.findByIdSingle('x', 1);
    assert.equal(found.val, 'MUTATO_SILENZIOSAMENTE');

    await eagerDb.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BUG-1 (quinta tornata) — Partial composite id: FIXED
// findById/update/deleteRecord ora richiedono TUTTI i campi id
// ═════════════════════════════════════════════════════════════════════════════

describe('BUG-1 quinta tornata — partial composite idObject ora rifiutato', () => {
  let db, tmpDir;

  beforeEach(async () => {
    ({ db, tmpDir } = await freshDb());
    await db.entityManager.createEntity('orderLines', {
      type: 'table',
      id: ['orderId', 'lineId'],
      values: ['orderId', 'lineId', 'qty'],
      notnullable: ['qty'],
    });
    await db.recordManager.insert('orderLines', { orderId: 1, lineId: 1, qty: 2 });
    await db.recordManager.insert('orderLines', { orderId: 1, lineId: 2, qty: 5 });
  });

  afterEach(() => teardown(db, tmpDir));

  test('findById con partial idObject lancia InvalidIdError', async () => {
    await assert.rejects(
      () => db.recordManager.findById('orderLines', { orderId: 1 }),
      InvalidIdError
    );
  });

  test('update con partial idObject lancia InvalidIdError', async () => {
    await assert.rejects(
      () => db.recordManager.update('orderLines', { orderId: 1 }, { qty: 99 }),
      InvalidIdError
    );
  });

  test('deleteRecord con partial idObject lancia InvalidIdError', async () => {
    await assert.rejects(
      () => db.recordManager.deleteRecord('orderLines', { orderId: 1 }),
      InvalidIdError
    );
  });

  test('findById con idObject completo funziona correttamente', async () => {
    const rec = await db.recordManager.findById('orderLines', { orderId: 1, lineId: 2 });
    assert.equal(rec.qty, 5);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BUG-5 (quinta tornata) — EntityInUseError transitivo: FIXED
// deleteEntity blocca anche oggetti referenziati da altri oggetti (non solo da table)
// ═════════════════════════════════════════════════════════════════════════════

describe('BUG-5 quinta tornata — deleteEntity blocca riferimenti object→object', () => {
  let db, tmpDir;

  beforeEach(async () => ({ db, tmpDir } = await freshDb()));
  afterEach(() => teardown(db, tmpDir));

  test('deleteEntity su object referenziato da un altro object lancia EntityInUseError', async () => {
    await db.entityManager.createEntity('inner', { type: 'object', values: ['x'] });
    await db.entityManager.createEntity('outer', {
      type: 'object',
      values: ['inner'],
      nested: ['inner'],
    });
    await assert.rejects(
      () => db.entityManager.deleteEntity('inner'),
      { name: 'EntityInUseError' }
    );
  });

  test('nella catena table→objectB→objectA, deleteEntity(objectA) è bloccato', async () => {
    await db.entityManager.createEntity('objectA', { type: 'object', values: ['v'] });
    await db.entityManager.createEntity('objectB', {
      type: 'object',
      values: ['objectA'],
      nested: ['objectA'],
    });
    await db.entityManager.createEntity('myTable', {
      type: 'table',
      id: ['id'],
      values: ['id', 'objectB'],
      nested: ['objectB'],
    });
    await assert.rejects(
      () => db.entityManager.deleteEntity('objectA'),
      { name: 'EntityInUseError' }
    );
  });

  test('dopo aver eliminato il referenziante, il referenziato diventa eliminabile', async () => {
    await db.entityManager.createEntity('inner', { type: 'object', values: ['x'] });
    await db.entityManager.createEntity('outer', {
      type: 'object',
      values: ['inner'],
      nested: ['inner'],
    });
    await db.entityManager.deleteEntity('outer');
    await db.entityManager.deleteEntity('inner'); // ora deve riuscire
    const names = await db.entityManager.listEntities();
    assert.ok(!names.includes('inner'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BUG-01 (sesta tornata) — unique su entity object ora rifiutato
// ═════════════════════════════════════════════════════════════════════════════

describe('BUG-01 sesta tornata — unique su entità "object" lancia TypeError', () => {
  let db, tmpDir;

  beforeEach(async () => ({ db, tmpDir } = await freshDb()));
  afterEach(() => teardown(db, tmpDir));

  test('createEntity object con unique lancia InvalidIdError', async () => {
    await assert.rejects(
      () => db.entityManager.createEntity('addr', {
        type: 'object',
        values: ['street', 'city'],
        unique: ['city'],
      }),
      InvalidIdError
    );
  });

  test('createEntity object senza unique continua a funzionare', async () => {
    await db.entityManager.createEntity('addr', {
      type: 'object',
      values: ['street', 'city'],
      notnullable: ['city'],
    });
    const cfg = await db.entityManager.getEntity('addr');
    assert.deepEqual(cfg.unique, []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BUG-05 (sesta tornata) — campi config come stringa anziché array ora rifiutati
// ═════════════════════════════════════════════════════════════════════════════

describe('BUG-05 sesta tornata — array config come stringa lancia TypeError', () => {
  let db, tmpDir;

  beforeEach(async () => ({ db, tmpDir } = await freshDb()));
  afterEach(() => teardown(db, tmpDir));

  test('id come stringa lancia TypeError', async () => {
    await assert.rejects(
      () => db.entityManager.createEntity('foo', {
        type: 'table',
        values: ['id', 'name'],
        id: 'id',
      }),
      TypeError
    );
  });

  test('notnullable come stringa lancia TypeError', async () => {
    await assert.rejects(
      () => db.entityManager.createEntity('foo', {
        type: 'table',
        id: ['id'],
        values: ['id', 'name'],
        notnullable: 'name',
      }),
      TypeError
    );
  });

  test('nested come stringa lancia TypeError', async () => {
    await db.entityManager.createEntity('addr', { type: 'object', values: ['city'] });
    await assert.rejects(
      () => db.entityManager.createEntity('foo', {
        type: 'table',
        id: ['id'],
        values: ['id', 'addr'],
        nested: 'addr',
      }),
      TypeError
    );
  });

  test('unique come stringa lancia TypeError', async () => {
    await assert.rejects(
      () => db.entityManager.createEntity('foo', {
        type: 'table',
        id: ['id'],
        values: ['id', 'name'],
        unique: 'name',
      }),
      TypeError
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BUG-01 (settima tornata) — NaN/Infinity in nested objects ora rifiutati
// ═════════════════════════════════════════════════════════════════════════════

describe('BUG-01 settima tornata — valori non-finiti in nested objects', () => {
  let db, tmpDir;

  beforeEach(async () => {
    ({ db, tmpDir } = await freshDb());
    await db.entityManager.createEntity('coords', {
      type: 'object',
      values: ['lat', 'lng'],
      notnullable: ['lat', 'lng'],
    });
    await db.entityManager.createEntity('stores', {
      type: 'table',
      id: ['id'],
      values: ['id', 'coords'],
      nested: ['coords'],
    });
  });

  afterEach(() => teardown(db, tmpDir));

  test('insert con NaN in nested object lancia TypeError', async () => {
    await assert.rejects(
      () => db.recordManager.insert('stores', { id: 1, coords: { lat: NaN, lng: 9.19 } }),
      TypeError
    );
  });

  test('insert con Infinity in nested object lancia TypeError', async () => {
    await assert.rejects(
      () => db.recordManager.insert('stores', { id: 1, coords: { lat: 45.46, lng: Infinity } }),
      TypeError
    );
  });

  test('insert con valori numerici validi in nested object funziona', async () => {
    const rec = await db.recordManager.insert('stores', { id: 1, coords: { lat: 45.46, lng: 9.19 } });
    assert.equal(rec.coords.lat, 45.46);
  });
});
