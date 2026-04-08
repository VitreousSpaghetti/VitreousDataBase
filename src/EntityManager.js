'use strict';

const {
  EntityNotFoundError,
  EntityAlreadyExistsError,
  EntityTypeError,
  EntityInUseError,
  InvalidIdError,
  UnknownFieldError,
  NullConstraintError,
  UniqueConstraintError,
  InvalidMigrationError,
} = require('./errors');
const { detectCircularReference, deepEqual } = require('./Validator');

class EntityManager {
  constructor(db) {
    this._db = db;
  }

  /**
   * Creates a new entity (table or object type) and persists its configuration.
   *
   * @param {string} name
   * @param {object} config
   * @param {string} config.type          'table' | 'object'
   * @param {string[]} config.values      required — all allowed field names
   * @param {string[]} [config.id]        id fields (table only)
   * @param {string[]} [config.notnullable]
   * @param {string[]} [config.unique]
   * @param {string[]} [config.nested]    fields that are nested objects
   */
  async createEntity(name, config) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();

      // 1. name must be a non-empty string
      if (!name || typeof name !== 'string') {
        throw new TypeError('Entity name must be a non-empty string');
      }

      // 2. name must not already exist — use hasOwnProperty to avoid false positives
      //    for reserved names like '__proto__' that resolve to Object.prototype
      if (Object.prototype.hasOwnProperty.call(data.entitiesConfiguration, name)) {
        throw new EntityAlreadyExistsError(name);
      }

      // 3. type must be 'table' or 'object'
      const type = config.type;
      if (type !== 'table' && type !== 'object') {
        throw new TypeError(`Entity type must be "table" or "object", got "${type}"`);
      }

      // 4. values must be a non-empty array of unique strings
      const values = config.values;
      if (!Array.isArray(values) || values.length === 0) {
        throw new TypeError(`Entity "${name}" must have a non-empty "values" array`);
      }
      if (new Set(values).size !== values.length) {
        throw new TypeError(`Entity "${name}" has duplicate entries in "values"`);
      }

      // Validate that optional array fields are actually arrays (not strings, numbers, etc.)
      for (const [fieldName, val] of [
        ['id', config.id],
        ['notnullable', config.notnullable],
        ['unique', config.unique],
        ['nested', config.nested],
      ]) {
        if (val !== undefined && val !== null && !Array.isArray(val)) {
          throw new TypeError(
            `Entity "${name}": "${fieldName}" must be an array, got ${typeof val}`
          );
        }
      }

      // Deduplicate all arrays
      const id = config.id ? [...new Set(config.id)] : [];
      const notnullable = config.notnullable ? [...new Set(config.notnullable)] : [];
      const unique = config.unique ? [...new Set(config.unique)] : [];
      const nested = config.nested ? [...new Set(config.nested)] : [];

      // Auto-add id fields to values if not already present (BUG-5)
      for (const field of id) {
        if (!values.includes(field)) values.push(field);
      }

      const allArrays = { id, notnullable, unique, nested };

      // 5. All extra fields must be subsets of values
      for (const [, arr] of Object.entries(allArrays)) {
        for (const field of arr) {
          if (!values.includes(field)) {
            throw new UnknownFieldError(name, field);
          }
        }
      }

      // 6. id fields cannot be nested fields
      for (const field of id) {
        if (nested.includes(field)) {
          throw new InvalidIdError(name, `field "${field}" is in both "id" and "nested" — id fields cannot be nested objects`);
        }
      }

      // 7. object entities cannot have id
      if (type === 'object' && id.length > 0) {
        throw new InvalidIdError(name, 'object entities cannot have an id');
      }

      // 7b. object entities cannot declare unique constraints (validateNestedObject never applies them)
      if (type === 'object' && unique.length > 0) {
        throw new InvalidIdError(name, 'object entities cannot declare unique constraints');
      }

      // 8. table entities must declare at least one id field
      if (type === 'table' && id.length === 0) {
        throw new InvalidIdError(name, 'table entities must declare at least one id field');
      }

      // Normalize: id fields automatically added to notnullable.
      // Uniqueness for id fields is enforced as a COMPOSITE key in validateRecord,
      // not as individual per-field unique constraints.
      for (const field of id) {
        if (!notnullable.includes(field)) notnullable.push(field);
      }

      // 9. For each nested field: verify corresponding entity exists with type 'object'
      // Skip self-references — they will be caught by detectCircularReference in step 10
      for (const field of nested) {
        if (field === name) continue;
        const nestedConfig = data.entitiesConfiguration[field];
        if (!nestedConfig) {
          throw new EntityNotFoundError(field);
        }
        if (nestedConfig.type !== 'object') {
          throw new EntityTypeError(field, 'object', nestedConfig.type);
        }
      }

      // 10. Build the final config and add tentatively for circular reference check
      const finalConfig = { type, values, id, notnullable, unique, nested };
      const snapshot = JSON.parse(JSON.stringify(data));
      snapshot.entitiesConfiguration[name] = finalConfig;
      detectCircularReference(name, snapshot);

      // 11. Persist — use defineProperty to safely handle reserved names like '__proto__'
      Object.defineProperty(data.entitiesConfiguration, name, {
        value: finalConfig, writable: true, enumerable: true, configurable: true,
      });
      await this._db._write(data);

      return JSON.parse(JSON.stringify(finalConfig));
    });
  }

  /**
   * Returns the configuration of an entity, or throws EntityNotFoundError.
   *
   * @param {string} name
   * @returns {object} config
   */
  async getEntity(name) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();
      if (!Object.prototype.hasOwnProperty.call(data.entitiesConfiguration, name)) {
        throw new EntityNotFoundError(name);
      }
      return JSON.parse(JSON.stringify(data.entitiesConfiguration[name]));
    });
  }

  /**
   * Lists entity names, optionally filtered by type.
   *
   * @param {'table'|'object'|undefined} type
   * @returns {string[]}
   */
  async listEntities(type) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();
      const names = Object.keys(data.entitiesConfiguration);
      if (!type) return names;
      return names.filter(n => data.entitiesConfiguration[n].type === type);
    });
  }

  /**
   * Deletes an entity and its records (if table type).
   * Throws EntityInUseError if an object type is still referenced by a table.
   *
   * @param {string} name
   */
  /**
   * Adds a new optional field to an entity's values list.
   *
   * @param {string} entityName
   * @param {string} fieldName
   * @returns {object} updated config
   */
  async addField(entityName, fieldName) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();
      if (!Object.prototype.hasOwnProperty.call(data.entitiesConfiguration, entityName)) {
        throw new EntityNotFoundError(entityName);
      }
      const config = data.entitiesConfiguration[entityName];
      if (config.values.includes(fieldName)) {
        throw new InvalidMigrationError(entityName, `field "${fieldName}" already exists in values`);
      }
      config.values.push(fieldName);
      await this._db._write(data);
      return JSON.parse(JSON.stringify(config));
    });
  }

  /**
   * Removes a field from an entity and strips it from all existing records.
   * Cannot remove id fields.
   *
   * @param {string} entityName
   * @param {string} fieldName
   */
  async removeField(entityName, fieldName) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();
      if (!Object.prototype.hasOwnProperty.call(data.entitiesConfiguration, entityName)) {
        throw new EntityNotFoundError(entityName);
      }
      const config = data.entitiesConfiguration[entityName];
      if (!config.values.includes(fieldName)) {
        throw new InvalidMigrationError(entityName, `field "${fieldName}" not found in values`);
      }
      if (config.id.includes(fieldName)) {
        throw new InvalidIdError(entityName, `cannot remove id field "${fieldName}"`);
      }
      config.values     = config.values.filter(f => f !== fieldName);
      config.notnullable = config.notnullable.filter(f => f !== fieldName);
      config.unique      = config.unique.filter(f => f !== fieldName);
      config.nested      = config.nested.filter(f => f !== fieldName);
      if (config.type === 'table' && Object.prototype.hasOwnProperty.call(data.entities, entityName)) {
        for (const record of data.entities[entityName]) {
          delete record[fieldName];
        }
      }
      await this._db._write(data);
    });
  }

  /**
   * Adds a constraint ('notnullable' or 'unique') to the given fields of an entity.
   * Performs a safety check against existing records before persisting.
   *
   * @param {string} entityName
   * @param {'notnullable'|'unique'} constraint
   * @param {string[]} fields
   */
  async addConstraint(entityName, constraint, fields) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();
      if (!Object.prototype.hasOwnProperty.call(data.entitiesConfiguration, entityName)) {
        throw new EntityNotFoundError(entityName);
      }
      const config = data.entitiesConfiguration[entityName];

      if (constraint !== 'notnullable' && constraint !== 'unique') {
        throw new InvalidMigrationError(entityName, `unknown constraint "${constraint}", must be "notnullable" or "unique"`);
      }
      if (constraint === 'unique' && config.type === 'object') {
        throw new InvalidMigrationError(entityName, 'object entities cannot have unique constraints');
      }

      for (const field of fields) {
        if (!config.values.includes(field)) {
          throw new InvalidMigrationError(entityName, `field "${field}" not found in values`);
        }
      }

      const records = Object.prototype.hasOwnProperty.call(data.entities, entityName)
        ? data.entities[entityName]
        : [];

      if (constraint === 'notnullable') {
        for (const field of fields) {
          for (const record of records) {
            if (record[field] === null || record[field] === undefined) {
              throw new NullConstraintError(entityName, field);
            }
          }
        }
        for (const field of fields) {
          if (!config.notnullable.includes(field)) config.notnullable.push(field);
        }
      }

      if (constraint === 'unique') {
        const isNested = config.nested || [];
        for (const field of fields) {
          for (let i = 0; i < records.length; i++) {
            const val = records[i][field];
            if (val === null || val === undefined) continue;
            for (let j = i + 1; j < records.length; j++) {
              const other = records[j][field];
              const equal = isNested.includes(field)
                ? deepEqual(val, other)
                : Object.is(val, other);
              if (equal) {
                throw new UniqueConstraintError(entityName, field, val);
              }
            }
          }
        }
        for (const field of fields) {
          if (!config.unique.includes(field)) config.unique.push(field);
        }
      }

      await this._db._write(data);
    });
  }

  async deleteEntity(name) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();

      if (!Object.prototype.hasOwnProperty.call(data.entitiesConfiguration, name)) {
        throw new EntityNotFoundError(name);
      }
      const config = data.entitiesConfiguration[name];

      if (config.type === 'object') {
        const referencedBy = Object.entries(data.entitiesConfiguration)
          .filter(([n, cfg]) => n !== name && (cfg.nested || []).includes(name))
          .map(([n]) => n);

        if (referencedBy.length > 0) {
          throw new EntityInUseError(name, referencedBy);
        }
      }

      if (config.type === 'table') {
        delete data.entities[name];
      }

      delete data.entitiesConfiguration[name];
      await this._db._write(data);
    });
  }
}

module.exports = EntityManager;
