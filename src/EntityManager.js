'use strict';

const {
  EntityNotFoundError,
  EntityAlreadyExistsError,
  EntityTypeError,
  EntityInUseError,
  InvalidIdError,
} = require('./errors');
const { detectCircularReference } = require('./Validator');

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

      // 2. name must not already exist
      if (data.entitiesConfiguration[name]) {
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
      for (const [arrayName, arr] of Object.entries(allArrays)) {
        for (const field of arr) {
          if (!values.includes(field)) {
            throw new TypeError(
              `Entity "${name}": field "${field}" in "${arrayName}" is not in "values"`
            );
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
        throw new TypeError(
          `Entity "${name}" of type "object" cannot declare "unique" constraints`
        );
      }

      // 8. table entities must declare at least one id field
      if (type === 'table' && id.length === 0) {
        throw new TypeError(`Entity "${name}" of type "table" must declare at least one id field`);
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

      // 11. Persist
      data.entitiesConfiguration[name] = finalConfig;
      await this._db._write(data);

      return finalConfig;
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
      const config = data.entitiesConfiguration[name];
      if (!config) throw new EntityNotFoundError(name);
      return JSON.parse(JSON.stringify(config));
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
  async deleteEntity(name) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();

      const config = data.entitiesConfiguration[name];
      if (!config) throw new EntityNotFoundError(name);

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
