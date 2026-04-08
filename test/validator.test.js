'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { validateRecord, validateNestedObject, detectCircularReference } = require('../src/Validator');
const {
  EntityNotFoundError,
  EntityTypeError,
  UnknownFieldError,
  NullConstraintError,
  UniqueConstraintError,
  NestedTypeError,
  CircularReferenceError,
} = require('../src/errors');

function makeData(overrides = {}) {
  return {
    entitiesConfiguration: {
      users: {
        type: 'table',
        id: ['id'],
        values: ['id', 'name', 'email', 'address'],
        notnullable: ['id', 'name'],
        unique: ['id', 'email'],
        nested: ['address'],
      },
      address: {
        type: 'object',
        values: ['street', 'city'],
        notnullable: ['city'],
        unique: [],
        nested: [],
      },
    },
    entities: {
      users: [
        { id: 1, name: 'Alice', email: 'alice@ex.com', address: { street: 'Via Roma', city: 'Milano' } },
      ],
    },
    ...overrides,
  };
}

describe('validateRecord', () => {
  test('accepts a valid record', () => {
    const data = makeData();
    assert.doesNotThrow(() =>
      validateRecord('users', { id: 2, name: 'Bob', email: 'bob@ex.com' }, data)
    );
  });

  test('throws EntityNotFoundError for unknown entity', () => {
    const data = makeData();
    assert.throws(
      () => validateRecord('unknown', { id: 1 }, data),
      EntityNotFoundError
    );
  });

  test('throws EntityTypeError when entity is not a table', () => {
    const data = makeData();
    assert.throws(
      () => validateRecord('address', { street: 'x', city: 'y' }, data),
      EntityTypeError
    );
  });

  test('throws UnknownFieldError for extra field', () => {
    const data = makeData();
    assert.throws(
      () => validateRecord('users', { id: 2, name: 'Bob', unknown: 'x' }, data),
      UnknownFieldError
    );
  });

  test('throws NullConstraintError for null notnullable field', () => {
    const data = makeData();
    assert.throws(
      () => validateRecord('users', { id: 2, name: null }, data),
      NullConstraintError
    );
  });

  test('throws NullConstraintError for undefined notnullable field', () => {
    const data = makeData();
    assert.throws(
      () => validateRecord('users', { id: 2 }, data),
      NullConstraintError
    );
  });

  test('throws UniqueConstraintError for duplicate unique field', () => {
    const data = makeData();
    assert.throws(
      () => validateRecord('users', { id: 1, name: 'Bob' }, data),
      UniqueConstraintError
    );
  });

  test('does not check unique for existingRecord in update mode', () => {
    const data = makeData();
    const existingRecord = data.entities.users[0];
    assert.doesNotThrow(() =>
      validateRecord('users', { id: 1, name: 'Alice Updated' }, data, { isUpdate: true, existingRecord })
    );
  });

  test('throws NestedTypeError when nested field is a primitive', () => {
    const data = makeData();
    assert.throws(
      () => validateRecord('users', { id: 2, name: 'Bob', address: 'not-an-object' }, data),
      NestedTypeError
    );
  });

  test('throws NestedTypeError when nested field is an array', () => {
    const data = makeData();
    assert.throws(
      () => validateRecord('users', { id: 2, name: 'Bob', address: [] }, data),
      NestedTypeError
    );
  });

  test('validates nested object fields', () => {
    const data = makeData();
    assert.throws(
      () => validateRecord('users', { id: 2, name: 'Bob', address: { city: null } }, data),
      NullConstraintError
    );
  });

  test('nested field unknown key throws UnknownFieldError', () => {
    const data = makeData();
    assert.throws(
      () => validateRecord('users', { id: 2, name: 'Bob', address: { city: 'Rome', unknown: 'x' } }, data),
      UnknownFieldError
    );
  });

  test('throws UniqueConstraintError for duplicate nested field value', () => {
    const data = makeData();
    data.entitiesConfiguration.users.unique.push('address');
    assert.throws(
      () => validateRecord('users', { id: 2, name: 'Bob', address: { street: 'Via Roma', city: 'Milano' } }, data),
      UniqueConstraintError
    );
  });

  test('allows different nested field values even when unique is set', () => {
    const data = makeData();
    data.entitiesConfiguration.users.unique.push('address');
    assert.doesNotThrow(() =>
      validateRecord('users', { id: 2, name: 'Bob', address: { street: 'Via Garibaldi', city: 'Roma' } }, data)
    );
  });
});

describe('detectCircularReference', () => {
  test('no cycle — passes', () => {
    const data = makeData();
    assert.doesNotThrow(() => detectCircularReference('users', data));
  });

  test('direct cycle throws CircularReferenceError', () => {
    const data = makeData();
    // make address nested back into itself
    data.entitiesConfiguration.address.nested = ['address'];
    assert.throws(
      () => detectCircularReference('address', data),
      CircularReferenceError
    );
  });

  test('transitive cycle throws CircularReferenceError', () => {
    const data = makeData();
    data.entitiesConfiguration.address.type = 'object';
    data.entitiesConfiguration.address.nested = ['users'];
    // users -> address -> users
    assert.throws(
      () => detectCircularReference('users', data),
      CircularReferenceError
    );
  });

  test('diamond (A->B, A->C, B->D, C->D) does not throw', () => {
    const data = {
      entitiesConfiguration: {
        A: { type: 'table', values: ['b', 'c'], nested: ['B', 'C'] },
        B: { type: 'object', values: ['d'], nested: ['D'] },
        C: { type: 'object', values: ['d'], nested: ['D'] },
        D: { type: 'object', values: ['x'], nested: [] },
      },
      entities: {},
    };
    assert.doesNotThrow(() => detectCircularReference('A', data));
  });
});
