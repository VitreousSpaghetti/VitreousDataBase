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

// Normalize -0 to 0 for top-level fields only (not recursive)
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

function isOperatorObject(obj) {
  if (!isPlainObject(obj)) return false;
  const keys = Object.keys(obj);
  if (keys.length === 0) return false;
  const hasOperator = keys.some(k => k.startsWith('$'));
  const hasNonOperator = keys.some(k => !k.startsWith('$'));
  if (hasOperator && hasNonOperator) {
    throw new TypeError('Query predicate cannot mix operator keys ($...) with plain field keys');
  }
  return hasOperator;
}

function applyOperators(value, ops) {
  for (const [op, operand] of Object.entries(ops)) {
    switch (op) {
      case '$eq':  if (value !== operand) return false; break;
      case '$ne':  if (value === operand) return false; break;
      case '$gt':  if (!(value > operand)) return false; break;
      case '$gte': if (!(value >= operand)) return false; break;
      case '$lt':  if (!(value < operand)) return false; break;
      case '$lte': if (!(value <= operand)) return false; break;
      case '$in':
        if (!Array.isArray(operand)) throw new TypeError('$in operand must be an array');
        if (!operand.some(v => v === value)) return false;
        break;
      case '$nin':
        if (!Array.isArray(operand)) throw new TypeError('$nin operand must be an array');
        if (operand.some(v => v === value)) return false;
        break;
      case '$exists':
        if (operand ? value === undefined : value !== undefined) return false;
        break;
      default:
        throw new TypeError(`Unknown query operator: ${op}`);
    }
  }
  return true;
}

function deepMatch(record, predicate) {
  for (const key of Object.keys(predicate)) {
    if (key === '$and') {
      if (!Array.isArray(predicate.$and)) throw new TypeError('$and operand must be an array');
      if (!predicate.$and.every(p => deepMatch(record, p))) return false;
    } else if (key === '$or') {
      if (!Array.isArray(predicate.$or)) throw new TypeError('$or operand must be an array');
      if (!predicate.$or.some(p => deepMatch(record, p))) return false;
    } else if (key === '$not') {
      if (!isPlainObject(predicate.$not)) throw new TypeError('$not operand must be a plain object');
      if (deepMatch(record, predicate.$not)) return false;
    } else {
      const pVal = predicate[key];
      const rVal = record[key];
      if (isOperatorObject(pVal)) {
        if (!applyOperators(rVal, pVal)) return false;
      } else if (isPlainObject(pVal) && isPlainObject(rVal)) {
        if (!deepMatch(rVal, pVal)) return false;
      } else if (rVal !== pVal) {
        return false;
      }
    }
  }
  return true;
}

class RecordManager {
  constructor(db) {
    this._db = db;
    this._watchers = new Map(); // Map<entityName, Set<callback>>
  }

  /**
   * Subscribes to changes on an entity. Returns an unsubscribe function.
   * Callback receives: { type: 'insert'|'update'|'delete', record, previous? }
   * Callbacks that throw are silently ignored — they must not abort a write.
   *
   * @param {string} entityName
   * @param {Function} callback
   * @returns {Function} unsubscribe
   */
  watch(entityName, callback) {
    if (typeof callback !== 'function') {
      throw new TypeError(`watch() callback must be a function, got ${typeof callback}`);
    }
    if (!this._watchers.has(entityName)) {
      this._watchers.set(entityName, new Set());
    }
    this._watchers.get(entityName).add(callback);
    return () => {
      this._watchers.get(entityName)?.delete(callback);
    };
  }

  _emit(entityName, event) {
    const fns = this._watchers.get(entityName);
    if (!fns) return;
    for (const fn of fns) {
      try { fn(event); } catch (_) {}
    }
  }

  _getTableConfig(data, entityName) {
    if (!Object.prototype.hasOwnProperty.call(data.entitiesConfiguration, entityName)) {
      throw new EntityNotFoundError(entityName);
    }
    const config = data.entitiesConfiguration[entityName];
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
      if (!Object.prototype.hasOwnProperty.call(data.entities, entityName)) {
        Object.defineProperty(data.entities, entityName, {
          value: [], writable: true, enumerable: true, configurable: true,
        });
      }
      const clone = JSON.parse(JSON.stringify(record));
      data.entities[entityName].push(clone);
      await this._db._write(data);
      const inserted = JSON.parse(JSON.stringify(clone));
      this._emit(entityName, { type: 'insert', record: inserted });
      return inserted;
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
      const records = Object.prototype.hasOwnProperty.call(data.entities, entityName) ? data.entities[entityName] : [];
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
      const records = Object.prototype.hasOwnProperty.call(data.entities, entityName) ? data.entities[entityName] : [];
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
      return JSON.parse(JSON.stringify(Object.prototype.hasOwnProperty.call(data.entities, entityName) ? data.entities[entityName] : []));
    });
  }

  /**
   * Filters records by a function predicate or a plain object.
   * Plain-object predicates support deep field equality and query operators.
   *
   * Comparison operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $exists
   * Logical operators (root-level): $and, $or, $not
   *
   * Examples:
   *   findWhere('orders', { total: { $gt: 100 }, status: { $ne: 'cancelled' } })
   *   findWhere('orders', { $or: [{ status: 'new' }, { status: 'pending' }] })
   *   findWhere('orders', r => r.total > 100) // function predicate — unchanged
   *
   * @param {string} entityName
   * @param {Function|object} predicate
   * @returns {object[]}
   */
  async findWhere(entityName, predicate) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();
      this._getTableConfig(data, entityName);
      const records = Object.prototype.hasOwnProperty.call(data.entities, entityName) ? data.entities[entityName] : [];

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
      const records = Object.prototype.hasOwnProperty.call(data.entities, entityName) ? data.entities[entityName] : [];
      const idx = records.findIndex(r => idKeys.every(k => r[k] === idObject[k]));

      if (idx === -1) {
        throw new RecordNotFoundError(entityName, idObject);
      }

      const existingRecord = records[idx];
      const previous = JSON.parse(JSON.stringify(existingRecord));

      // Deep merge: nested object fields are merged recursively instead of replaced
      const merged = normalizeMinusZero(deepMerge(existingRecord, updates));

      validateRecord(entityName, merged, data, { isUpdate: true, existingRecord });

      records[idx] = merged;
      await this._db._write(data);
      const updated = JSON.parse(JSON.stringify(merged));
      this._emit(entityName, { type: 'update', record: updated, previous });
      return updated;
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
      const records = Object.prototype.hasOwnProperty.call(data.entities, entityName) ? data.entities[entityName] : [];
      const idx = records.findIndex(r => idKeys.every(k => r[k] === idObject[k]));

      if (idx === -1) {
        throw new RecordNotFoundError(entityName, idObject);
      }

      const deleted = records.splice(idx, 1)[0];
      await this._db._write(data);
      const deletedClone = JSON.parse(JSON.stringify(deleted));
      this._emit(entityName, { type: 'delete', record: deletedClone });
      return deletedClone;
    });
  }
}

module.exports = RecordManager;
