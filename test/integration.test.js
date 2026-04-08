'use strict';

/**
 * integration.test.js — test di integrazione completo
 *
 * Scenario: una piccola azienda tiene dipendenti, progetti e assegnazioni.
 *
 * NOTA ARCHITETTURALE: ogni test usa beforeEach/afterEach per avere un DB
 * isolato. Questo è necessario perché _enqueue() non resetta la coda in caso
 * di errore: se un'operazione lancia, la queue resta rigettata e le operazioni
 * successive (in un DB condiviso) fallirebbero tutte con lo stesso errore.
 *
 * Schema:
 *   address    (object)  — street, city, country          notnullable: city
 *   contact    (object)  — phone, email                   notnullable: email
 *   employee   (table)   — id, firstName, lastName, age, role, address, contact
 *                          id:[id]  notnullable:[firstName,lastName]
 *                          nested:[address, contact]
 *   project    (table)   — id, title, status, budget
 *                          id:[id]  notnullable:[title,status]  unique:[title]
 *   assignment (table)   — id, employeeId, projectId, role, hours
 *                          id:[id]  notnullable:[role]
 *
 * Composite id è dimostrato con un'entity "session" [userId, token].
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const {
  Database,
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
} = require('../index');

// ─── logging helpers ──────────────────────────────────────────────────────────

function log(label, value) {
  const out = value === undefined ? '' : '\n' + JSON.stringify(value, null, 2);
  console.log(`  [LOG] ${label}${out}`);
}

function logOk(label) {
  console.log(`  [OK]  ${label}`);
}

function logFail(label, err) {
  console.log(`  [FAIL expected] ${label} — ${err.name}: ${err.message}`);
}

// ─── schema builder ───────────────────────────────────────────────────────────

async function buildSchema(db) {
  await db.entityManager.createEntity('address', {
    type: 'object',
    values: ['street', 'city', 'country'],
    notnullable: ['city'],
  });
  await db.entityManager.createEntity('contact', {
    type: 'object',
    values: ['phone', 'email'],
    notnullable: ['email'],
  });
  await db.entityManager.createEntity('employee', {
    type: 'table',
    id: ['id'],
    values: ['id', 'firstName', 'lastName', 'age', 'role', 'address', 'contact'],
    notnullable: ['firstName', 'lastName'],
    nested: ['address', 'contact'],
  });
  await db.entityManager.createEntity('project', {
    type: 'table',
    id: ['id'],
    values: ['id', 'title', 'status', 'budget'],
    notnullable: ['title', 'status'],
    unique: ['title'],
  });
  // assignment usa id sintetico: unique per singolo campo (non composite)
  await db.entityManager.createEntity('assignment', {
    type: 'table',
    id: ['id'],
    values: ['id', 'employeeId', 'projectId', 'role', 'hours'],
    notnullable: ['role'],
  });
}

// ─── dataset ──────────────────────────────────────────────────────────────────

const EMPLOYEES = [
  {
    id: 1, firstName: 'Alice', lastName: 'Rossi', age: 30, role: 'engineer',
    address: { street: 'Via Roma 1', city: 'Milano', country: 'IT' },
    contact: { phone: '340-111', email: 'alice@corp.it' },
  },
  {
    id: 2, firstName: 'Bob', lastName: 'Verdi', age: 45, role: 'manager',
    address: { street: 'Corso Garibaldi 5', city: 'Torino', country: 'IT' },
    contact: { phone: '340-222', email: 'bob@corp.it' },
  },
  {
    id: 3, firstName: 'Carol', lastName: 'Neri', age: 28, role: 'designer',
    contact: { email: 'carol@corp.it' },
  },
  {
    id: 4, firstName: 'Dave', lastName: 'Blu', age: 35, role: 'engineer',
    contact: { email: 'dave@corp.it' },
  },
];

const PROJECTS = [
  { id: 101, title: 'Alpha', status: 'active',    budget: 50000 },
  { id: 102, title: 'Beta',  status: 'active',    budget: 20000 },
  { id: 103, title: 'Gamma', status: 'completed', budget: 10000 },
];

const ASSIGNMENTS = [
  { id: 1, employeeId: 1, projectId: 101, role: 'lead',    hours: 120 },
  { id: 2, employeeId: 2, projectId: 101, role: 'sponsor', hours: 20  },
  { id: 3, employeeId: 3, projectId: 101, role: 'design',  hours: 80  },
  { id: 4, employeeId: 1, projectId: 102, role: 'lead',    hours: 60  },
  { id: 5, employeeId: 4, projectId: 102, role: 'backend', hours: 90  },
  { id: 6, employeeId: 2, projectId: 103, role: 'sponsor', hours: 10  },
];

// ─── factory per setup/teardown ───────────────────────────────────────────────

function makeSetup({ withData = false } = {}) {
  let db, tmpDir;

  async function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitreousdb-int-'));
    db = await Database.create(path.join(tmpDir, 'db.json'));
    await buildSchema(db);
    if (withData) {
      for (const emp  of EMPLOYEES)   await db.recordManager.insert('employee',   emp);
      for (const proj of PROJECTS)    await db.recordManager.insert('project',    proj);
      for (const a    of ASSIGNMENTS) await db.recordManager.insert('assignment', a);
    }
    return db;
  }

  async function cleanup() {
    await db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return { getDb: () => db, setup, cleanup };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. SCHEMA — creazione entità
// ═════════════════════════════════════════════════════════════════════════════

describe('1 — creazione schema', () => {
  let db;
  const { setup, cleanup } = makeSetup();

  beforeEach(async () => { db = await setup(); });
  afterEach(cleanup);

  test('tutte le 5 entity esistono dopo buildSchema', async () => {
    const all = await db.entityManager.listEntities();
    log('listEntities()', all);
    for (const name of ['address', 'contact', 'employee', 'project', 'assignment']) {
      assert.ok(all.includes(name), `manca: ${name}`);
    }
    logOk('tutte le entity presenti');
  });

  test('filtro listEntities("table")', async () => {
    const tables = await db.entityManager.listEntities('table');
    log('tables', tables);
    assert.deepEqual(tables.sort(), ['assignment', 'employee', 'project'].sort());
    logOk('solo table entities');
  });

  test('filtro listEntities("object")', async () => {
    const objects = await db.entityManager.listEntities('object');
    log('objects', objects);
    assert.deepEqual(objects.sort(), ['address', 'contact'].sort());
    logOk('solo object entities');
  });

  test('id auto-normalizzato in notnullable (non in unique individuale)', async () => {
    const cfg = await db.entityManager.getEntity('employee');
    log('employee config', cfg);
    assert.ok(cfg.notnullable.includes('id'));
    // id fields are NOT added to unique individually (composite key semantics)
    assert.ok(!cfg.unique.includes('id'));
    assert.ok(cfg.notnullable.includes('firstName')); // dichiarato esplicitamente
    assert.ok(!cfg.unique.includes('firstName'));     // non dichiarato unique
    logOk('normalizzazione id verificata');
  });

  test('getEntity ritorna la config completa', async () => {
    const cfg = await db.entityManager.getEntity('assignment');
    log('assignment config', cfg);
    assert.equal(cfg.type, 'table');
    assert.deepEqual(cfg.id, ['id']);
    assert.ok(cfg.notnullable.includes('role'));
    assert.ok(cfg.notnullable.includes('id'));
    logOk('config assignment corretta');
  });
});

// ─── schema: failure cases ────────────────────────────────────────────────────

describe('1b — schema failure cases', () => {
  let db;
  const { setup, cleanup } = makeSetup();

  beforeEach(async () => { db = await setup(); });
  afterEach(cleanup);

  test('[FAIL] entity duplicata → EntityAlreadyExistsError', async () => {
    try {
      await db.entityManager.createEntity('address', { type: 'object', values: ['x'] });
      assert.fail('deve lanciare');
    } catch (err) {
      logFail('duplicate entity', err);
      assert.ok(err instanceof EntityAlreadyExistsError);
      assert.equal(err.entityName, 'address');
    }
  });

  test('[FAIL] object entity con id → InvalidIdError', async () => {
    try {
      await db.entityManager.createEntity('tag', {
        type: 'object', id: ['id'], values: ['id', 'label'],
      });
      assert.fail('deve lanciare');
    } catch (err) {
      logFail('object con id', err);
      assert.ok(err instanceof InvalidIdError);
    }
  });

  test('[FAIL] id field è anche nested → InvalidIdError', async () => {
    try {
      await db.entityManager.createEntity('weird', {
        type: 'table', id: ['contact'], values: ['contact'], nested: ['contact'],
      });
      assert.fail('deve lanciare');
    } catch (err) {
      logFail('id è nested', err);
      assert.ok(err instanceof InvalidIdError);
    }
  });

  test('[FAIL] nested punta a entity "table" (non object) → EntityTypeError', async () => {
    try {
      await db.entityManager.createEntity('bad', {
        type: 'table', id: ['id'], values: ['id', 'employee'], nested: ['employee'],
      });
      assert.fail('deve lanciare');
    } catch (err) {
      logFail('nested → table entity', err);
      assert.ok(err instanceof EntityTypeError);
      assert.equal(err.expected, 'object');
      assert.equal(err.actual,   'table');
    }
  });

  test('[FAIL] nested punta a entity inesistente → EntityNotFoundError', async () => {
    try {
      await db.entityManager.createEntity('orphan', {
        type: 'table', id: ['id'], values: ['id', 'ghost'], nested: ['ghost'],
      });
      assert.fail('deve lanciare');
    } catch (err) {
      logFail('nested → entity inesistente', err);
      assert.ok(err instanceof EntityNotFoundError);
    }
  });

  test('[OK] campo in id non in values → auto-aggiunto a values', async () => {
    // id fields are now automatically added to values if absent (BUG-5 fix)
    const config = await db.entityManager.createEntity('autoid', {
      type: 'table', id: ['nope'], values: ['name'],
    });
    assert.ok(config.values.includes('nope'));
    assert.ok(config.values.includes('name'));
  });

  test('[FAIL] values con duplicati → TypeError', async () => {
    try {
      await db.entityManager.createEntity('dupes', {
        type: 'table', id: ['id'], values: ['id', 'name', 'name'],
      });
      assert.fail('deve lanciare');
    } catch (err) {
      logFail('values duplicati', err);
      assert.ok(err instanceof TypeError);
    }
  });

  test('[FAIL] getEntity su entity inesistente → EntityNotFoundError', async () => {
    try {
      await db.entityManager.getEntity('ghost');
      assert.fail('deve lanciare');
    } catch (err) {
      logFail('getEntity ghost', err);
      assert.ok(err instanceof EntityNotFoundError);
      assert.equal(err.entityName, 'ghost');
    }
  });

  test('[FAIL] ciclo diretto A → B → A → CircularReferenceError', async () => {
    await db.entityManager.createEntity('cycleA', { type: 'object', values: ['x'] });
    await db.entityManager.createEntity('cycleB', {
      type: 'object', values: ['cycleA'], nested: ['cycleA'],
    });
    // inietta il ciclo bypassando createEntity
    const data = await db._read();
    data.entitiesConfiguration.cycleA.values.push('cycleB');
    data.entitiesConfiguration.cycleA.nested = ['cycleB'];
    await db._write(data);

    try {
      await db.entityManager.createEntity('cycleC', {
        type: 'table', id: ['id'], values: ['id', 'cycleB'], nested: ['cycleB'],
      });
      assert.fail('deve lanciare');
    } catch (err) {
      logFail('circular reference', err);
      log('ciclo', err.cycle);
      assert.ok(err instanceof CircularReferenceError);
      assert.ok(Array.isArray(err.cycle));
    }
  });

  test('diamond dependency (A→B→D, A→C→D) NON è un ciclo', async () => {
    await db.entityManager.createEntity('D', { type: 'object', values: ['x'] });
    await db.entityManager.createEntity('B', { type: 'object', values: ['D'], nested: ['D'] });
    await db.entityManager.createEntity('C', { type: 'object', values: ['D'], nested: ['D'] });
    const cfg = await db.entityManager.createEntity('A', {
      type: 'object', values: ['B', 'C'], nested: ['B', 'C'],
    });
    log('A (diamond root) config', cfg);
    logOk('diamond dependency OK — nessun ciclo rilevato');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. INSERT — inserimento record con nested objects
// ═════════════════════════════════════════════════════════════════════════════

describe('2 — insert record', () => {
  let db;
  const { setup, cleanup } = makeSetup();

  beforeEach(async () => { db = await setup(); });
  afterEach(cleanup);

  test('inserimento dipendenti con address e contact nested', async () => {
    for (const emp of EMPLOYEES) {
      const ins = await db.recordManager.insert('employee', emp);
      log(`employee id=${ins.id}`, ins);
      assert.equal(ins.id,        emp.id);
      assert.equal(ins.firstName, emp.firstName);
      if (emp.address) assert.equal(ins.address.city, emp.address.city);
      if (emp.contact) assert.equal(ins.contact.email, emp.contact.email);
    }
    const all = await db.recordManager.findAll('employee');
    assert.equal(all.length, EMPLOYEES.length);
    logOk(`${all.length} dipendenti inseriti con nested objects`);
  });

  test('inserimento progetti', async () => {
    for (const proj of PROJECTS) {
      const ins = await db.recordManager.insert('project', proj);
      log(`project id=${ins.id}`, ins);
    }
    const all = await db.recordManager.findAll('project');
    assert.equal(all.length, PROJECTS.length);
    logOk(`${all.length} progetti inseriti`);
  });

  test('inserimento assegnazioni molti-a-molti (id sintetico)', async () => {
    for (const a of ASSIGNMENTS) {
      const ins = await db.recordManager.insert('assignment', a);
      log(`assignment id=${ins.id} (emp=${ins.employeeId}→proj=${ins.projectId})`, ins);
    }
    const all = await db.recordManager.findAll('assignment');
    assert.equal(all.length, ASSIGNMENTS.length);
    logOk(`${all.length} assegnazioni inserite`);
  });

  test('campo nested omesso è valido (address è opzionale)', async () => {
    const rec = await db.recordManager.insert('employee', {
      id: 99, firstName: 'NoAddr', lastName: 'Person',
      contact: { email: 'noa@x.it' },
    });
    log('employee senza address', rec);
    assert.equal(rec.address, undefined);
    logOk('campo nested opzionale omesso OK');
  });

  test('il record restituito è un clone (mutazione locale non persiste)', async () => {
    const ins = await db.recordManager.insert('employee', EMPLOYEES[0]);
    ins.firstName = 'MUTATO';
    const check = await db.recordManager.findByIdSingle('employee', EMPLOYEES[0].id);
    log('firstName dopo mutazione locale', check.firstName);
    assert.equal(check.firstName, EMPLOYEES[0].firstName);
    logOk('clone verificato');
  });
});

// ─── insert: failure cases ────────────────────────────────────────────────────

describe('2b — insert failure cases', () => {
  let db;
  const { setup, cleanup } = makeSetup();

  beforeEach(async () => { db = await setup(); });
  afterEach(cleanup);

  test('[FAIL] campo sconosciuto → UnknownFieldError', async () => {
    try {
      await db.recordManager.insert('employee', { id: 1, firstName: 'X', lastName: 'Y', alienField: '?' });
      assert.fail();
    } catch (err) {
      logFail('campo sconosciuto', err);
      assert.ok(err instanceof UnknownFieldError);
      assert.equal(err.fieldName, 'alienField');
    }
  });

  test('[FAIL] notnullable = null → NullConstraintError', async () => {
    try {
      await db.recordManager.insert('employee', { id: 1, firstName: null, lastName: 'Y' });
      assert.fail();
    } catch (err) {
      logFail('null su notnullable', err);
      assert.ok(err instanceof NullConstraintError);
      assert.equal(err.fieldName, 'firstName');
    }
  });

  test('[FAIL] notnullable assente (undefined) → NullConstraintError', async () => {
    try {
      await db.recordManager.insert('employee', { id: 1, lastName: 'Y' }); // firstName mancante
      assert.fail();
    } catch (err) {
      logFail('undefined su notnullable', err);
      assert.ok(err instanceof NullConstraintError);
      assert.equal(err.fieldName, 'firstName');
    }
  });

  test('[FAIL] id duplicato → UniqueConstraintError (composite key)', async () => {
    await db.recordManager.insert('employee', { id: 1, firstName: 'Alice', lastName: 'R', contact: { email: 'a@x.it' } });
    try {
      await db.recordManager.insert('employee', { id: 1, firstName: 'Clone', lastName: 'R', contact: { email: 'c@x.it' } });
      assert.fail();
    } catch (err) {
      logFail('id duplicato', err);
      assert.ok(err instanceof UniqueConstraintError);
      assert.equal(err.fieldName, 'id');         // composite key: single id → 'id'
      assert.equal(err.value, 'id=1');            // composite format: 'field=value'
    }
  });

  test('[FAIL] unique violato su title project → UniqueConstraintError', async () => {
    await db.recordManager.insert('project', { id: 1, title: 'Alpha', status: 'active' });
    try {
      await db.recordManager.insert('project', { id: 2, title: 'Alpha', status: 'draft' });
      assert.fail();
    } catch (err) {
      logFail('title duplicato', err);
      assert.ok(err instanceof UniqueConstraintError);
      assert.equal(err.fieldName, 'title');
      assert.equal(err.value, 'Alpha');
    }
  });

  test('[FAIL] nested field stringa → NestedTypeError', async () => {
    try {
      await db.recordManager.insert('employee', { id: 1, firstName: 'X', lastName: 'Y', address: 'Via Roma' });
      assert.fail();
    } catch (err) {
      logFail('nested = stringa', err);
      assert.ok(err instanceof NestedTypeError);
      assert.equal(err.fieldName, 'address');
    }
  });

  test('[FAIL] nested field array → NestedTypeError', async () => {
    try {
      await db.recordManager.insert('employee', { id: 1, firstName: 'X', lastName: 'Y', contact: ['email@x.it'] });
      assert.fail();
    } catch (err) {
      logFail('nested = array', err);
      assert.ok(err instanceof NestedTypeError);
      assert.equal(err.fieldName, 'contact');
    }
  });

  test('[FAIL] notnullable violato dentro nested object → NullConstraintError', async () => {
    try {
      await db.recordManager.insert('employee', {
        id: 1, firstName: 'X', lastName: 'Y',
        contact: { phone: '000' }, // email mancante (notnullable in contact)
      });
      assert.fail();
    } catch (err) {
      logFail('null su nested notnullable', err);
      assert.ok(err instanceof NullConstraintError);
      assert.equal(err.entityName, 'contact');
      assert.equal(err.fieldName,  'email');
    }
  });

  test('[FAIL] campo sconosciuto dentro nested object → UnknownFieldError', async () => {
    try {
      await db.recordManager.insert('employee', {
        id: 1, firstName: 'X', lastName: 'Y',
        contact: { email: 'x@x.it', badField: 'oops' },
      });
      assert.fail();
    } catch (err) {
      logFail('campo sconosciuto in nested', err);
      assert.ok(err instanceof UnknownFieldError);
      assert.equal(err.entityName, 'contact');
      assert.equal(err.fieldName,  'badField');
    }
  });

  test('[FAIL] insert in entity object (non table) → EntityTypeError', async () => {
    try {
      await db.recordManager.insert('address', { street: 'x', city: 'y' });
      assert.fail();
    } catch (err) {
      logFail('insert in object entity', err);
      assert.ok(err instanceof EntityTypeError);
      assert.equal(err.expected, 'table');
      assert.equal(err.actual,   'object');
    }
  });

  test('[FAIL] insert in entity inesistente → EntityNotFoundError', async () => {
    try {
      await db.recordManager.insert('ghost', { id: 1 });
      assert.fail();
    } catch (err) {
      logFail('insert entity inesistente', err);
      assert.ok(err instanceof EntityNotFoundError);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. QUERY — ricerche sul dataset completo
// ═════════════════════════════════════════════════════════════════════════════

describe('3 — query di ricerca', () => {
  let db;
  const { setup, cleanup } = makeSetup({ withData: true });

  beforeEach(async () => { db = await setup(); });
  afterEach(cleanup);

  test('findAll — tutti i dipendenti', async () => {
    const all = await db.recordManager.findAll('employee');
    log('findAll employee', all.map(e => `${e.id}:${e.firstName}`));
    assert.equal(all.length, EMPLOYEES.length);
  });

  test('findByIdSingle — trova Alice per id=1', async () => {
    const alice = await db.recordManager.findByIdSingle('employee', 1);
    log('findByIdSingle(1)', alice);
    assert.equal(alice.firstName, 'Alice');
    assert.equal(alice.contact.email, 'alice@corp.it');
    assert.equal(alice.address.city, 'Milano');
    logOk('dati nested recuperati correttamente');
  });

  test('findByIdSingle — ritorna null se non trovato', async () => {
    const missing = await db.recordManager.findByIdSingle('employee', 9999);
    log('findByIdSingle(9999)', missing);
    assert.equal(missing, null);
  });

  test('findById — con oggetto id singolo', async () => {
    const bob = await db.recordManager.findById('employee', { id: 2 });
    log('findById({id:2})', bob);
    assert.equal(bob.firstName, 'Bob');
    assert.equal(bob.role, 'manager');
  });

  test('findById — composite id su entity "session"', async () => {
    await db.entityManager.createEntity('session', {
      type: 'table',
      id: ['userId', 'token'],
      values: ['userId', 'token', 'expiresAt'],
    });
    await db.recordManager.insert('session', { userId: 1, token: 'abc', expiresAt: '2099-01-01' });

    const s = await db.recordManager.findById('session', { userId: 1, token: 'abc' });
    log('findById composite', s);
    assert.equal(s.expiresAt, '2099-01-01');
    logOk('composite id trovato');
  });

  test('findById — ordine delle chiavi composite non importa', async () => {
    await db.entityManager.createEntity('session', {
      type: 'table',
      id: ['userId', 'token'],
      values: ['userId', 'token', 'expiresAt'],
    });
    await db.recordManager.insert('session', { userId: 7, token: 'xyz', expiresAt: '2099-12-31' });

    const a1 = await db.recordManager.findById('session', { userId: 7, token: 'xyz' });
    const a2 = await db.recordManager.findById('session', { token: 'xyz', userId: 7 });
    log('a1 == a2', a1);
    assert.deepEqual(a1, a2);
    logOk('ordine chiavi non influisce sul risultato');
  });

  test('findWhere — filtro per oggetto (role="engineer")', async () => {
    const engineers = await db.recordManager.findWhere('employee', { role: 'engineer' });
    log('engineers', engineers.map(e => e.firstName));
    assert.equal(engineers.length, 2);
    assert.ok(engineers.some(e => e.firstName === 'Alice'));
    assert.ok(engineers.some(e => e.firstName === 'Dave'));
  });

  test('findWhere — filtro per funzione (age < 35)', async () => {
    const young = await db.recordManager.findWhere('employee', r => r.age !== undefined && r.age < 35);
    log('age < 35', young.map(e => `${e.firstName}(${e.age})`));
    assert.ok(young.every(e => e.age < 35));
    assert.ok(young.some(e => e.firstName === 'Alice')); // 30
    assert.ok(young.some(e => e.firstName === 'Carol')); // 28
  });

  test('findWhere — accesso a campo nested via funzione (city=Milano)', async () => {
    const milanesi = await db.recordManager.findWhere('employee', r => r.address && r.address.city === 'Milano');
    log('milanesi', milanesi.map(e => e.firstName));
    assert.equal(milanesi.length, 1);
    assert.equal(milanesi[0].firstName, 'Alice');
  });

  test('findWhere — progetti attivi', async () => {
    const attivi = await db.recordManager.findWhere('project', { status: 'active' });
    log('progetti attivi', attivi.map(p => p.title));
    assert.equal(attivi.length, 2);
  });

  test('findWhere — tutte le assegnazioni al progetto 101 (Alpha)', async () => {
    const asse = await db.recordManager.findWhere('assignment', { projectId: 101 });
    log('assegnazioni Alpha', asse);
    assert.equal(asse.length, 3); // Alice (lead), Bob (sponsor), Carol (design)
  });

  test('findWhere — assegnazioni di Alice (id=1) su più progetti', async () => {
    const aliceAss = await db.recordManager.findWhere('assignment', { employeeId: 1 });
    log('assegnazioni Alice', aliceAss);
    assert.equal(aliceAss.length, 2); // Alpha + Beta
  });

  test('findWhere — nessun risultato → array vuoto', async () => {
    const none = await db.recordManager.findWhere('employee', { role: 'CEO' });
    log('CEO results', none);
    assert.deepEqual(none, []);
  });
});

// ─── query: failure cases ─────────────────────────────────────────────────────

describe('3b — query failure cases', () => {
  let db;
  const { setup, cleanup } = makeSetup({ withData: true });

  beforeEach(async () => { db = await setup(); });
  afterEach(cleanup);

  test('[FAIL] findByIdSingle su composite id → InvalidIdError', async () => {
    await db.entityManager.createEntity('session', {
      type: 'table', id: ['userId', 'token'], values: ['userId', 'token'],
    });
    try {
      await db.recordManager.findByIdSingle('session', 1);
      assert.fail();
    } catch (err) {
      logFail('findByIdSingle composite', err);
      assert.ok(err instanceof InvalidIdError);
    }
  });

  test('[FAIL] findById con chiave non-id → InvalidIdError', async () => {
    try {
      await db.recordManager.findById('employee', { firstName: 'Alice' });
      assert.fail();
    } catch (err) {
      logFail('findById chiave non-id', err);
      assert.ok(err instanceof InvalidIdError);
    }
  });

  test('[FAIL] findWhere predicate numero → TypeError', async () => {
    try {
      await db.recordManager.findWhere('employee', 42);
      assert.fail();
    } catch (err) {
      logFail('predicate numero', err);
      assert.ok(err instanceof TypeError);
    }
  });

  test('[FAIL] findWhere predicate null → TypeError', async () => {
    try {
      await db.recordManager.findWhere('employee', null);
      assert.fail();
    } catch (err) {
      logFail('predicate null', err);
      assert.ok(err instanceof TypeError);
    }
  });

  test('[FAIL] findAll su entity inesistente → EntityNotFoundError', async () => {
    try {
      await db.recordManager.findAll('ghost');
      assert.fail();
    } catch (err) {
      logFail('findAll ghost', err);
      assert.ok(err instanceof EntityNotFoundError);
    }
  });

  test('[FAIL] findAll su entity object → EntityTypeError', async () => {
    try {
      await db.recordManager.findAll('address');
      assert.fail();
    } catch (err) {
      logFail('findAll object entity', err);
      assert.ok(err instanceof EntityTypeError);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. UPDATE e DELETE
// ═════════════════════════════════════════════════════════════════════════════

describe('4 — update', () => {
  let db;
  const { setup, cleanup } = makeSetup({ withData: true });

  beforeEach(async () => { db = await setup(); });
  afterEach(cleanup);

  test('update campo semplice (role)', async () => {
    const upd = await db.recordManager.update('employee', { id: 3 }, { role: 'senior designer' });
    log('update Carol role', upd);
    assert.equal(upd.role, 'senior designer');
    assert.equal(upd.firstName, 'Carol'); // invariato
  });

  test('update persiste su disco (rilettura)', async () => {
    await db.recordManager.update('employee', { id: 2 }, { age: 46 });
    const bob = await db.recordManager.findByIdSingle('employee', 2);
    log('Bob dopo update', bob);
    assert.equal(bob.age, 46);
  });

  test('update sostituzione nested object (address)', async () => {
    const upd = await db.recordManager.update('employee', { id: 1 }, {
      address: { street: 'Via Montenapoleone 10', city: 'Milano', country: 'IT' },
    });
    log('Alice nuova address', upd.address);
    assert.equal(upd.address.street, 'Via Montenapoleone 10');
    assert.equal(upd.address.city, 'Milano');
  });

  test('update budget progetto', async () => {
    const upd = await db.recordManager.update('project', { id: 101 }, { budget: 75000 });
    log('Alpha nuovo budget', upd);
    assert.equal(upd.budget, 75000);
    assert.equal(upd.title, 'Alpha'); // invariato
  });

  test('update stesso valore unique non viola il constraint (auto-exclude)', async () => {
    // Aggiorno status senza cambiare title — non deve scattare UniqueConstraintError su title
    const upd = await db.recordManager.update('project', { id: 101 }, { status: 'paused' });
    log('Alpha status aggiornato', upd);
    assert.equal(upd.title, 'Alpha');
    assert.equal(upd.status, 'paused');
    logOk('update stesso valore unique non lancia errore');
  });
});

describe('4b — update failure cases', () => {
  let db;
  const { setup, cleanup } = makeSetup({ withData: true });

  beforeEach(async () => { db = await setup(); });
  afterEach(cleanup);

  test('[FAIL] update di un campo id → InvalidIdError', async () => {
    try {
      await db.recordManager.update('employee', { id: 1 }, { id: 999 });
      assert.fail();
    } catch (err) {
      logFail('update id field', err);
      assert.ok(err instanceof InvalidIdError);
    }
  });

  test('[FAIL] update viola unique → UniqueConstraintError', async () => {
    try {
      await db.recordManager.update('project', { id: 102 }, { title: 'Alpha' }); // Alpha esiste già
      assert.fail();
    } catch (err) {
      logFail('update viola unique', err);
      assert.ok(err instanceof UniqueConstraintError);
      assert.equal(err.fieldName, 'title');
    }
  });

  test('[FAIL] update viola notnullable → NullConstraintError', async () => {
    try {
      await db.recordManager.update('employee', { id: 1 }, { firstName: null });
      assert.fail();
    } catch (err) {
      logFail('update null su notnullable', err);
      assert.ok(err instanceof NullConstraintError);
    }
  });

  test('[FAIL] update aggiunge campo sconosciuto → UnknownFieldError', async () => {
    try {
      await db.recordManager.update('employee', { id: 1 }, { salary: 9999 }); // salary non in values
      assert.fail();
    } catch (err) {
      logFail('update campo sconosciuto', err);
      assert.ok(err instanceof UnknownFieldError);
    }
  });

  test('[FAIL] update record inesistente → RecordNotFoundError', async () => {
    try {
      await db.recordManager.update('employee', { id: 9999 }, { role: 'ghost' });
      assert.fail();
    } catch (err) {
      logFail('update record inesistente', err);
      assert.ok(err instanceof RecordNotFoundError);
    }
  });
});

describe('4c — delete', () => {
  let db;
  const { setup, cleanup } = makeSetup({ withData: true });

  beforeEach(async () => { db = await setup(); });
  afterEach(cleanup);

  test('deleteRecord — elimina e ritorna il record eliminato', async () => {
    const del = await db.recordManager.deleteRecord('project', { id: 103 });
    log('deleted Gamma', del);
    assert.equal(del.title, 'Gamma');
    const all = await db.recordManager.findAll('project');
    assert.ok(!all.some(p => p.id === 103));
    logOk(`rimasti ${all.length} progetti`);
  });

  test('deleteRecord — assegnazione tramite id sintetico', async () => {
    const del = await db.recordManager.deleteRecord('assignment', { id: 6 });
    log('deleted assignment id=6', del);
    assert.equal(del.role, 'sponsor');
    const remaining = await db.recordManager.findAll('assignment');
    assert.ok(!remaining.some(a => a.id === 6));
    logOk(`assegnazioni rimanenti: ${remaining.length}`);
  });

  test('[FAIL] deleteRecord inesistente → RecordNotFoundError', async () => {
    try {
      await db.recordManager.deleteRecord('employee', { id: 9999 });
      assert.fail();
    } catch (err) {
      logFail('delete record inesistente', err);
      assert.ok(err instanceof RecordNotFoundError);
    }
  });

  test('[FAIL] deleteEntity object ancora referenziata → EntityInUseError', async () => {
    try {
      await db.entityManager.deleteEntity('contact'); // employee ha nested:[..., 'contact']
      assert.fail();
    } catch (err) {
      logFail('delete entity in use', err);
      assert.ok(err instanceof EntityInUseError);
      assert.equal(err.entityName, 'contact');
      log('referencedBy', err.referencedBy);
      assert.ok(err.referencedBy.includes('employee'));
    }
  });

  test('[FAIL] deleteEntity inesistente → EntityNotFoundError', async () => {
    try {
      await db.entityManager.deleteEntity('ghost');
      assert.fail();
    } catch (err) {
      logFail('delete entity inesistente', err);
      assert.ok(err instanceof EntityNotFoundError);
    }
  });

  test('deleteEntity table con records — entity e records rimossi', async () => {
    await db.entityManager.createEntity('temp', {
      type: 'table', id: ['id'], values: ['id', 'name'],
    });
    await db.recordManager.insert('temp', { id: 1, name: 'a' });
    await db.recordManager.insert('temp', { id: 2, name: 'b' });

    await db.entityManager.deleteEntity('temp');
    logOk('deleteEntity "temp" eseguito');

    try {
      await db.entityManager.getEntity('temp');
      assert.fail();
    } catch (err) {
      logFail('getEntity dopo delete', err);
      assert.ok(err instanceof EntityNotFoundError);
    }
    const raw = await db._read();
    assert.equal(raw.entities.temp, undefined);
    logOk('records di "temp" rimossi dal file JSON');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. EDGE CASES
// ═════════════════════════════════════════════════════════════════════════════

describe('5 — edge cases', () => {
  let db;
  const { setup, cleanup } = makeSetup();

  beforeEach(async () => { db = await setup(); });
  afterEach(cleanup);

  test('id con valore 0 (falsy) è valido', async () => {
    const rec = await db.recordManager.insert('employee', {
      id: 0, firstName: 'Zero', lastName: 'Test', contact: { email: 'zero@x.it' },
    });
    log('id=0 inserito', rec);
    assert.equal(rec.id, 0);
    const found = await db.recordManager.findByIdSingle('employee', 0);
    assert.equal(found.firstName, 'Zero');
    logOk('id=0 trovato correttamente (falsy non confuso con "non trovato")');
  });

  test('id stringa è valido', async () => {
    const rec = await db.recordManager.insert('project', {
      id: 'draft-001', title: 'Draft', status: 'draft',
    });
    log('id stringa inserito', rec);
    assert.equal(rec.id, 'draft-001');
    const found = await db.recordManager.findByIdSingle('project', 'draft-001');
    assert.equal(found.title, 'Draft');
  });

  test('ciclo completo insert → update → verify → delete', async () => {
    const ins = await db.recordManager.insert('project', { id: 777, title: 'Lifecycle', status: 'draft' });
    log('[1] insert', ins);
    assert.equal(ins.status, 'draft');

    const upd = await db.recordManager.update('project', { id: 777 }, { status: 'active', budget: 5000 });
    log('[2] update', upd);
    assert.equal(upd.status, 'active');
    assert.equal(upd.budget, 5000);

    const chk = await db.recordManager.findByIdSingle('project', 777);
    log('[3] rilettura', chk);
    assert.equal(chk.status, 'active');

    const del = await db.recordManager.deleteRecord('project', { id: 777 });
    log('[4] delete', del);
    assert.equal(del.title, 'Lifecycle');

    const gone = await db.recordManager.findByIdSingle('project', 777);
    log('[5] dopo delete', gone);
    assert.equal(gone, null);
    logOk('ciclo completo verificato');
  });

  test('findAll su tabella vuota ritorna array vuoto', async () => {
    const all = await db.recordManager.findAll('employee');
    log('findAll tabella vuota', all);
    assert.deepEqual(all, []);
  });

  test('listEntities aggiornata dopo deleteEntity', async () => {
    await db.entityManager.createEntity('toDelete', { type: 'object', values: ['v'] });
    const before = await db.entityManager.listEntities();
    assert.ok(before.includes('toDelete'));

    await db.entityManager.deleteEntity('toDelete');
    const after = await db.entityManager.listEntities();
    log('dopo delete', after);
    assert.ok(!after.includes('toDelete'));
    logOk('listEntities aggiornata');
  });

  test('findWhere predicate non modifica il DB', async () => {
    await db.recordManager.insert('employee', { id: 1, firstName: 'A', lastName: 'B', contact: { email: 'a@b.it' } });
    await db.recordManager.insert('employee', { id: 2, firstName: 'C', lastName: 'D', contact: { email: 'c@d.it' } });

    let calls = 0;
    await db.recordManager.findWhere('employee', r => { calls++; return r.id === 1; });
    log(`predicate chiamato ${calls} volte`, calls);
    assert.ok(calls > 0);

    const all = await db.recordManager.findAll('employee');
    assert.equal(all.length, 2);
    logOk(`DB invariato dopo findWhere (${calls} chiamate al predicate)`);
  });

  test('findAll ritorna cloni (mutazione non persiste)', async () => {
    await db.recordManager.insert('employee', EMPLOYEES[0]);
    const all = await db.recordManager.findAll('employee');
    all[0].firstName = 'MUTATO';
    const all2 = await db.recordManager.findAll('employee');
    log('primo record dopo mutazione locale', all2[0].firstName);
    assert.notEqual(all2[0].firstName, 'MUTATO');
    logOk('findAll ritorna cloni deep');
  });
});
