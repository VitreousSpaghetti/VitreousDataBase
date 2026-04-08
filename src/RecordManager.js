'use strict';

const {
  EntityNotFoundError,
  EntityTypeError,
  InvalidIdError,
  RecordNotFoundError,
} = require('./errors');
const { validateRecord } = require('./Validator');

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

// Normalize -0 to 0 recursively across all top-level fields
function normalizeMinusZero(record) {
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = (v === 0 && (1 / v) === -Infinity) ? 0 : v;
  }
  return out;
}

function validateFullIdObject(entityName, idObject, config) {
  for (const key of Object.keys(idObject)) {
    if (!config.id.includes(key)) {
      throw new InvalidIdError(entityName, `field "${key}" is not an id field`);
    }
  }
  for (const idField of config.id) {
    if (!Object.prototype.hasOwnProperty.call(idObject, idField)) {
      throw new InvalidIdError(
        entityName,
        `idObject is missing required id field "${idField}"`
      );
    }
  }
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (isPlainObject(source[key]) && isPlainObject(target[key])) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function deepMatch(record, predicate) {
  for (const key of Object.keys(predicate)) {
    const pVal = predicate[key];
    const rVal = record[key];
    if (isPlainObject(pVal) && isPlainObject(rVal)) {
      if (!deepMatch(rVal, pVal)) return false;
    } else if (rVal !== pVal) {
      return false;
    }
  }
  return true;
}

class RecordManager {
  constructor(db) {
    this._db = db;
  }

  _getTableConfig(data, entityName) {
    const config = data.entitiesConfiguration[entityName];
    if (!config) throw new EntityNotFoundError(entityName);
    if (config.type !== 'table') throw new EntityTypeError(entityName, 'table', config.type);
    return config;
  }

  /**
   * Inserts a new record into the given entity.
   *
   * @param {string} entityName
   * @param {object} record
   * @returns {object} inserted record (clone)
   */
  async insert(entityName, rawRecord) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();
      this._getTableConfig(data, entityName);
      const record = normalizeMinusZero(rawRecord);
      validateRecord(entityName, record, data);
      if (!data.entities[entityName]) data.entities[entityName] = [];
      const clone = JSON.parse(JSON.stringify(record));
      data.entities[entityName].push(clone);
      await this._db._write(data);
      return JSON.parse(JSON.stringify(clone));
    });
  }

  /**
   * Finds a record by a composite or single id object.
   * Example: findById('users', { id: 1 }) or findById('orders', { userId: 1, orderId: 42 })
   *
   * @param {string} entityName
   * @param {object} idObject
   * @returns {object|null}
   */
  async findById(entityName, idObject) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();
      const config = this._getTableConfig(data, entityName);

      validateFullIdObject(entityName, idObject, config);

      const idKeys = Object.keys(idObject);
      const records = data.entities[entityName] || [];
      const found = records.find(r =>
        idKeys.every(k => r[k] === idObject[k])
      );
      return found ? JSON.parse(JSON.stringify(found)) : null;
    });
  }

  /**
   * Convenience method for entities with a single id field.
   * Throws InvalidIdError if the entity has a composite id.
   *
   * @param {string} entityName
   * @param {*} value
   * @returns {object|null}
   */
  async findByIdSingle(entityName, value) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();
      const config = this._getTableConfig(data, entityName);

      if (config.id.length !== 1) {
        throw new InvalidIdError(
          entityName,
          `findByIdSingle requires exactly one id field, but "${entityName}" has [${config.id.join(', ')}]`
        );
      }

      const idField = config.id[0];
      const records = data.entities[entityName] || [];
      const found = records.find(r => r[idField] === value);
      return found ? JSON.parse(JSON.stringify(found)) : null;
    });
  }

  /**
   * Returns all records for an entity.
   *
   * @param {string} entityName
   * @returns {object[]}
   */
  async findAll(entityName) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();
      this._getTableConfig(data, entityName);
      return JSON.parse(JSON.stringify(data.entities[entityName] || []));
    });
  }

  /**
   * Filters records by a function predicate or a plain object (deep field equality).
   * Object predicates support nested matching: { address: { city: 'Milano' } } works.
   *
   * @param {string} entityName
   * @param {Function|object} predicate
   * @returns {object[]}
   */
  async findWhere(entityName, predicate) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();
      this._getTableConfig(data, entityName);
      const records = data.entities[entityName] || [];

      let matchFn;
      if (typeof predicate === 'function') {
        matchFn = predicate;
      } else if (predicate !== null && typeof predicate === 'object' && !Array.isArray(predicate)) {
        matchFn = r => deepMatch(r, predicate);
      } else {
        throw new TypeError('predicate must be a function or a plain object');
      }

      return JSON.parse(JSON.stringify(records.filter(matchFn)));
    });
  }

  /**
   * Updates a record identified by idObject, merging updates into existing fields.
   * id fields are immutable and cannot be changed via update.
   *
   * @param {string} entityName
   * @param {object} idObject
   * @param {object} updates
   * @returns {object} updated record
   */
  async update(entityName, idObject, updates) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();
      const config = this._getTableConfig(data, entityName);

      // Reject updates on id fields
      for (const idField of config.id) {
        if (Object.prototype.hasOwnProperty.call(updates, idField)) {
          throw new InvalidIdError(entityName, `id fields are immutable and cannot be updated ("${idField}")`);
        }
      }

      validateFullIdObject(entityName, idObject, config);

      const idKeys = Object.keys(idObject);
      const records = data.entities[entityName] || [];
      const idx = records.findIndex(r => idKeys.every(k => r[k] === idObject[k]));

      if (idx === -1) {
        throw new RecordNotFoundError(entityName, idObject);
      }

      const existingRecord = records[idx];

      // Deep merge: nested object fields are merged recursively instead of replaced
      const merged = normalizeMinusZero(deepMerge(existingRecord, updates));

      validateRecord(entityName, merged, data, { isUpdate: true, existingRecord });

      records[idx] = merged;
      await this._db._write(data);
      return JSON.parse(JSON.stringify(merged));
    });
  }

  /**
   * Deletes a record identified by idObject.
   *
   * @param {string} entityName
   * @param {object} idObject
   * @returns {object} deleted record
   */
  async deleteRecord(entityName, idObject) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();
      const config = this._getTableConfig(data, entityName);

      validateFullIdObject(entityName, idObject, config);

      const idKeys = Object.keys(idObject);
      const records = data.entities[entityName] || [];
      const idx = records.findIndex(r => idKeys.every(k => r[k] === idObject[k]));

      if (idx === -1) {
        throw new RecordNotFoundError(entityName, idObject);
      }

      const deleted = records.splice(idx, 1)[0];
      await this._db._write(data);
      return JSON.parse(JSON.stringify(deleted));
    });
  }
}

module.exports = RecordManager;
