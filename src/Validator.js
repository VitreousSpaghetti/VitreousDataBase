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
function validateNestedObject(nestedEntityName, value, data, _visited = new Set()) {
  if (_visited.has(nestedEntityName)) {
    const cycle = [..._visited, nestedEntityName];
    throw new CircularReferenceError(nestedEntityName, cycle);
  }

  const config = data.entitiesConfiguration[nestedEntityName];
  if (!config) throw new EntityNotFoundError(nestedEntityName);
  if (config.type !== 'object') throw new EntityTypeError(nestedEntityName, 'object', config.type);

  for (const key of Object.keys(value)) {
    if (!config.values.includes(key)) {
      throw new UnknownFieldError(nestedEntityName, key);
    }
  }

  // Reject non-JSON-serializable number values (same check as validateRecord)
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'number' && !isFinite(val)) {
      throw new TypeError(
        `Field "${key}" of nested entity "${nestedEntityName}" has non-serializable value: ${val}`
      );
    }
  }

  for (const field of (config.notnullable || [])) {
    if (value[field] === null || value[field] === undefined) {
      throw new NullConstraintError(nestedEntityName, field);
    }
  }

  const visited = new Set(_visited);
  visited.add(nestedEntityName);

  for (const field of (config.nested || [])) {
    if (value[field] === undefined || value[field] === null) continue;
    if (!isPlainObject(value[field])) {
      throw new NestedTypeError(nestedEntityName, field);
    }
    validateNestedObject(field, value[field], data, visited);
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

  // 0. Reject non-JSON-serializable number values
  for (const [key, val] of Object.entries(record)) {
    if (typeof val === 'number' && !isFinite(val)) {
      throw new TypeError(`Field "${key}" of entity "${entityName}" has non-serializable value: ${val}`);
    }
  }

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

  // 3. unique checks
  const nested = config.nested || [];
  const existing = data.entities[entityName] || [];

  // 3a. Composite id uniqueness — id fields are unique as a tuple, not individually
  const idFields = config.id || [];
  if (idFields.length > 0) {
    const idCompareTo = isUpdate && existingRecord
      ? existing.filter(r => r !== existingRecord)
      : existing;

    for (const r of idCompareTo) {
      if (idFields.every(f => Object.is(r[f], record[f]))) {
        const compositeKey = idFields.map(f => `${f}=${record[f]}`).join(', ');
        throw new UniqueConstraintError(entityName, idFields.join('+'), compositeKey);
      }
    }
  }

  // 3b. Non-id unique fields (skip nested fields — deep equality not supported)
  for (const field of (config.unique || [])) {
    if (idFields.includes(field)) continue; // already covered by composite id check (3a)
    if (nested.includes(field)) continue;
    // null treated as "absent" for uniqueness — multiple records may have null on the same unique field
    if (record[field] === undefined || record[field] === null) continue;

    const compareTo = isUpdate && existingRecord
      ? existing.filter(r => r !== existingRecord)
      : existing;

    for (const r of compareTo) {
      if (Object.is(r[field], record[field])) {
        throw new UniqueConstraintError(entityName, field, record[field]);
      }
    }
  }

  // 4. nested field validation
  for (const field of nested) {
    // undefined → field omitted (ok); null → explicitly cleared (ok for non-notnullable)
    if (record[field] === undefined || record[field] === null) continue;
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
