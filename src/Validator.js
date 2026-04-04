'use strict';

const {
  EntityNotFoundError,
  EntityTypeError,
  UnknownFieldError,
  NullConstraintError,
  UniqueConstraintError,
  NestedTypeError,
  CircularReferenceError,
} = require('./errors');

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

/**
 * Validates a nested object value against its entity configuration.
 * No unique check at nested level — by design.
 *
 * @param {string} nestedEntityName
 * @param {object} value
 * @param {object} data  full DB snapshot
 */
function validateNestedObject(nestedEntityName, value, data) {
  const config = data.entitiesConfiguration[nestedEntityName];
  if (!config) throw new EntityNotFoundError(nestedEntityName);
  if (config.type !== 'object') throw new EntityTypeError(nestedEntityName, 'object', config.type);

  for (const key of Object.keys(value)) {
    if (!config.values.includes(key)) {
      throw new UnknownFieldError(nestedEntityName, key);
    }
  }

  for (const field of (config.notnullable || [])) {
    if (value[field] === null || value[field] === undefined) {
      throw new NullConstraintError(nestedEntityName, field);
    }
  }

  for (const field of (config.nested || [])) {
    if (value[field] !== undefined) {
      if (!isPlainObject(value[field])) {
        throw new NestedTypeError(nestedEntityName, field);
      }
      const nestedRef = field;
      validateNestedObject(nestedRef, value[field], data);
    }
  }
}

/**
 * Validates a record before insert or update.
 *
 * @param {string} entityName
 * @param {object} record
 * @param {object} data  full DB snapshot
 * @param {{ isUpdate?: boolean, existingRecord?: object|null }} options
 */
function validateRecord(entityName, record, data, { isUpdate = false, existingRecord = null } = {}) {
  const config = data.entitiesConfiguration[entityName];
  if (!config) throw new EntityNotFoundError(entityName);
  if (config.type !== 'table') throw new EntityTypeError(entityName, 'table', config.type);

  // 1. No unknown fields
  for (const key of Object.keys(record)) {
    if (!config.values.includes(key)) {
      throw new UnknownFieldError(entityName, key);
    }
  }

  // 2. notnullable
  for (const field of (config.notnullable || [])) {
    if (record[field] === null || record[field] === undefined) {
      throw new NullConstraintError(entityName, field);
    }
  }

  // 3. unique (skip nested fields — deep equality not supported)
  const nested = config.nested || [];
  const existing = data.entities[entityName] || [];
  for (const field of (config.unique || [])) {
    if (nested.includes(field)) continue;
    if (record[field] === undefined) continue;

    const compareTo = isUpdate && existingRecord
      ? existing.filter(r => r !== existingRecord)
      : existing;

    for (const r of compareTo) {
      if (r[field] === record[field]) {
        throw new UniqueConstraintError(entityName, field, record[field]);
      }
    }
  }

  // 4. nested field validation
  for (const field of nested) {
    if (record[field] === undefined) continue;
    if (!isPlainObject(record[field])) {
      throw new NestedTypeError(entityName, field);
    }
    validateNestedObject(field, record[field], data);
  }
}

/**
 * Detects circular nested references via DFS.
 * Uses a copy of `visited` per branch to allow diamond shapes but catch true cycles.
 *
 * @param {string} entityName
 * @param {object} data  full DB snapshot (with the new entity already tentatively added)
 * @param {Set<string>} visited
 */
function detectCircularReference(entityName, data, visited = new Set()) {
  if (visited.has(entityName)) {
    const cycle = [...visited, entityName];
    throw new CircularReferenceError(entityName, cycle);
  }

  const config = data.entitiesConfiguration[entityName];
  if (!config || !config.nested || config.nested.length === 0) return;

  for (const nestedField of config.nested) {
    const branchVisited = new Set(visited);
    branchVisited.add(entityName);
    detectCircularReference(nestedField, data, branchVisited);
  }
}

module.exports = { validateRecord, validateNestedObject, detectCircularReference };
