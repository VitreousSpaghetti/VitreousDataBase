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
  ShardKeyError,
} = require('./errors');
const { detectCircularReference, deepEqual } = require('./Validator');

const TOP_LEVEL_TYPES = ['table', 'object', 'subdatabase', 'sharded'];
const SUB_ENTITY_TYPES = ['table', 'object'];
const RECORD_KINDS_WITH_ID = new Set(['table', 'subdatabase', 'sharded']);

/**
 * Builds and validates a normalized entity config. Used both for top-level
 * createEntity and recursively for each child entity declared in subEntities.
 *
 * @param {string}   name       Fully qualified display name ("countries" or "countries.person")
 * @param {object}   rawConfig  The user-supplied config
 * @param {object}   opts
 * @param {object}   opts.data         Current DB snapshot (for resolving top-level nested refs)
 * @param {boolean}  opts.isSubEntity  True when validating a child inside subEntities
 * @returns {object} Normalized config, ready to persist
 */
function buildConfig(name, rawConfig, { data, isSubEntity }) {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new TypeError(`Entity "${name}": config must be a plain object`);
  }

  // 1. type
  const type = rawConfig.type;
  const allowed = isSubEntity ? SUB_ENTITY_TYPES : TOP_LEVEL_TYPES;
  if (!allowed.includes(type)) {
    throw new TypeError(
      `Entity "${name}": type must be one of [${allowed.join(', ')}], got "${type}"`
    );
  }

  // 2. values: non-empty array of unique entries
  if (!Array.isArray(rawConfig.values) || rawConfig.values.length === 0) {
    throw new TypeError(`Entity "${name}" must have a non-empty "values" array`);
  }
  if (new Set(rawConfig.values).size !== rawConfig.values.length) {
    throw new TypeError(`Entity "${name}" has duplicate entries in "values"`);
  }
  let values = [...rawConfig.values];

  // 3. optional arrays must actually be arrays
  for (const [fieldName, val] of [
    ['id', rawConfig.id],
    ['notnullable', rawConfig.notnullable],
    ['unique', rawConfig.unique],
    ['nested', rawConfig.nested],
    ['shardKey', rawConfig.shardKey],
  ]) {
    if (val !== undefined && val !== null && !Array.isArray(val)) {
      throw new TypeError(
        `Entity "${name}": "${fieldName}" must be an array, got ${typeof val}`
      );
    }
  }

  // 4. dedupe
  const id          = rawConfig.id          ? [...new Set(rawConfig.id)]          : [];
  const notnullable = rawConfig.notnullable ? [...new Set(rawConfig.notnullable)] : [];
  const unique      = rawConfig.unique      ? [...new Set(rawConfig.unique)]      : [];
  const nested      = rawConfig.nested      ? [...new Set(rawConfig.nested)]      : [];
  const shardKey    = rawConfig.shardKey    ? [...new Set(rawConfig.shardKey)]    : [];

  // 5a. Object-type restrictions (no id / unique / shardKey on object)
  if (type === 'object') {
    if (id.length > 0)        throw new InvalidIdError(name, 'object entities cannot have an id');
    if (unique.length > 0)    throw new InvalidIdError(name, 'object entities cannot declare unique constraints');
    if (shardKey.length > 0)  throw new ShardKeyError(name, 'object entities cannot declare a shardKey');
  }

  // 5b. shardKey restricted to sharded type
  if (type !== 'sharded' && shardKey.length > 0) {
    throw new ShardKeyError(name, `shardKey is only allowed on "sharded" entities, not "${type}"`);
  }

  // 6. Auto-add id and shardKey fields to values (normalization)
  for (const field of id) {
    if (!values.includes(field)) values.push(field);
  }
  for (const field of shardKey) {
    if (!values.includes(field)) values.push(field);
  }

  // 7. All extra arrays must be subsets of values (UnknownFieldError)
  for (const arr of [id, notnullable, unique, nested, shardKey]) {
    for (const field of arr) {
      if (!values.includes(field)) {
        throw new UnknownFieldError(name, field);
      }
    }
  }

  // 8. id and shardKey fields cannot be nested (must be primitive-comparable)
  for (const field of id) {
    if (nested.includes(field)) {
      throw new InvalidIdError(
        name,
        `field "${field}" is in both "id" and "nested" — id fields cannot be nested objects`
      );
    }
  }
  for (const field of shardKey) {
    if (nested.includes(field)) {
      throw new ShardKeyError(
        name,
        `shardKey field "${field}" cannot be declared as nested — must be primitive-comparable`
      );
    }
  }

  // 9. table / subdatabase / sharded must declare at least one id field.
  //    This check runs AFTER the UnknownFieldError check so callers passing
  //    bad field names in notnullable/unique still see UnknownFieldError first
  //    (preserves pre-existing error ordering).
  if (RECORD_KINDS_WITH_ID.has(type) && id.length === 0) {
    throw new InvalidIdError(name, `${type} entities must declare at least one id field`);
  }

  // 9b. sharded requires a non-empty shardKey (declared after UnknownFieldError
  //     for the same ordering-preservation reason).
  if (type === 'sharded' && shardKey.length === 0) {
    throw new ShardKeyError(name, 'sharded entities must declare a non-empty shardKey');
  }

  // 10. sharded-only: id ⊇ shardKey, unique ⊆ shardKey
  if (type === 'sharded') {
    for (const field of shardKey) {
      if (!id.includes(field)) {
        throw new ShardKeyError(
          name,
          `id must include every shardKey field (missing "${field}")`
        );
      }
    }
    for (const field of unique) {
      if (!shardKey.includes(field)) {
        throw new ShardKeyError(
          name,
          `unique field "${field}" must also be declared in shardKey for sharded entities`
        );
      }
    }
  }

  // 11. Auto-add id and shardKey to notnullable
  for (const field of id) {
    if (!notnullable.includes(field)) notnullable.push(field);
  }
  for (const field of shardKey) {
    if (!notnullable.includes(field)) notnullable.push(field);
  }

  // 11. Validate nested refs resolve to a top-level 'object' entity.
  //     v1: nested refs on sub-entity children must also point to top-level objects
  //     (not siblings), so the existing Validator.validateNestedObject logic applies
  //     unchanged at record validation time.
  for (const field of nested) {
    if (field === name) continue; // self-ref — detectCircularReference handles it
    const nestedCfg = Object.prototype.hasOwnProperty.call(data.entitiesConfiguration, field)
      ? data.entitiesConfiguration[field]
      : undefined;
    if (!nestedCfg) {
      throw new EntityNotFoundError(field);
    }
    if (nestedCfg.type !== 'object') {
      throw new EntityTypeError(field, 'object', nestedCfg.type);
    }
  }

  // 12. subEntities: only allowed on container types (subdatabase, sharded).
  //     In v1 each child must be 'table' or 'object'.
  let subEntities;
  if (type === 'subdatabase' || type === 'sharded') {
    const raw = rawConfig.subEntities;
    if (raw !== undefined && raw !== null) {
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new TypeError(`Entity "${name}": "subEntities" must be a plain object`);
      }
      subEntities = {};
      for (const [childName, childRaw] of Object.entries(raw)) {
        if (!childName || typeof childName !== 'string') {
          throw new TypeError(`Entity "${name}": subEntity name must be a non-empty string`);
        }
        if (childName === '_self') {
          throw new TypeError(`Entity "${name}": subEntity name "_self" is reserved`);
        }
        const childFinal = buildConfig(`${name}.${childName}`, childRaw, {
          data,
          isSubEntity: true,
        });
        Object.defineProperty(subEntities, childName, {
          value: childFinal, writable: true, enumerable: true, configurable: true,
        });
      }
    } else {
      subEntities = {};
    }
  } else if (rawConfig.subEntities !== undefined) {
    throw new TypeError(
      `Entity "${name}": "subEntities" is only allowed on "subdatabase" and "sharded" entities`
    );
  }

  // 13. Build final config in a consistent key order
  const finalConfig = { type, values, id, notnullable, unique, nested };
  if (type === 'sharded') finalConfig.shardKey = shardKey;
  if (type === 'subdatabase' || type === 'sharded') finalConfig.subEntities = subEntities;

  return finalConfig;
}

class EntityManager {
  constructor(db) {
    this._db = db;
  }

  /**
   * Creates a new entity and persists its configuration.
   *
   * Supported types:
   *   - "table"       records live in the main file under data.entities[name]
   *   - "object"      schema-only, used as a nested inline object inside other entities
   *   - "subdatabase" single-instance container, stored in <sidecar>/<name>.json
   *   - "sharded"     multi-instance partitioned container, stored in <sidecar>/<name>/<shardFile>.json
   *
   * @param {string} name
   * @param {object} config
   * @param {string}   config.type
   * @param {string[]} config.values      required — all allowed field names
   * @param {string[]} [config.id]        id fields (required for table/subdatabase/sharded)
   * @param {string[]} [config.notnullable]
   * @param {string[]} [config.unique]
   * @param {string[]} [config.nested]    fields that are nested "object" entities
   * @param {string[]} [config.shardKey]  required for "sharded"; must be a subset of id
   * @param {object}   [config.subEntities] map of child entity configs (subdatabase/sharded only)
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

      // 3. Normalize + validate the whole config tree (including subEntities)
      const finalConfig = buildConfig(name, config, { data, isSubEntity: false });

      // 4. Tentatively add to a snapshot and run circular-reference check
      //    (detectCircularReference walks nested refs on top-level entities)
      const snapshot = JSON.parse(JSON.stringify(data));
      snapshot.entitiesConfiguration[name] = finalConfig;
      detectCircularReference(name, snapshot);

      // 5. Persist — use defineProperty to safely handle reserved names like '__proto__'
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
      if (
        config.type === 'sharded' &&
        Array.isArray(config.shardKey) &&
        config.shardKey.includes(fieldName)
      ) {
        throw new ShardKeyError(entityName, `cannot remove shardKey field "${fieldName}"`);
      }
      config.values     = config.values.filter(f => f !== fieldName);
      config.notnullable = config.notnullable.filter(f => f !== fieldName);
      config.unique      = config.unique.filter(f => f !== fieldName);
      config.nested      = config.nested.filter(f => f !== fieldName);
      // Record data stripping only applies to regular tables stored in the main file.
      // Sub/sharded record cleanup is out of scope for v1 removeField.
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

      // Sharded entities: unique fields must be in shardKey so uniqueness can be
      // enforced shard-locally without loading every shard.
      if (constraint === 'unique' && config.type === 'sharded') {
        const shardKey = Array.isArray(config.shardKey) ? config.shardKey : [];
        for (const field of fields) {
          if (!shardKey.includes(field)) {
            throw new ShardKeyError(
              entityName,
              `unique field "${field}" must also be declared in shardKey for sharded entities`
            );
          }
        }
      }

      // Safety scan against existing records. For sub/sharded entities, records
      // live in sidecar files and are NOT scanned by v1 addConstraint — the schema
      // is updated but pre-existing sidecar data is not checked for violations.
      const records = (config.type === 'table' && Object.prototype.hasOwnProperty.call(data.entities, entityName))
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

  /**
   * Deletes an entity and its records.
   *
   * - "table":       removes the entry from data.entities
   * - "object":      schema-only; checks no other entity still references it as nested
   * - "subdatabase": removes the single sidecar file <sidecar>/<name>.json
   * - "sharded":     removes the sidecar directory <sidecar>/<name>/ recursively
   *
   * Throws EntityInUseError if an object type is still referenced by another
   * entity (or by any subEntity of a container).
   *
   * @param {string} name
   */
  async deleteEntity(name) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();

      if (!Object.prototype.hasOwnProperty.call(data.entitiesConfiguration, name)) {
        throw new EntityNotFoundError(name);
      }
      const config = data.entitiesConfiguration[name];

      if (config.type === 'object') {
        const referencedBy = [];
        for (const [n, cfg] of Object.entries(data.entitiesConfiguration)) {
          if (n === name) continue;
          if ((cfg.nested || []).includes(name)) {
            referencedBy.push(n);
            continue;
          }
          // Also scan subEntities children (v1: only table/object children,
          // which may have nested refs to top-level objects).
          if (cfg.subEntities) {
            for (const [childName, childCfg] of Object.entries(cfg.subEntities)) {
              if ((childCfg.nested || []).includes(name)) {
                referencedBy.push(`${n}.${childName}`);
              }
            }
          }
        }

        if (referencedBy.length > 0) {
          throw new EntityInUseError(name, referencedBy);
        }
      }

      if (config.type === 'table') {
        delete data.entities[name];
      }

      // Sidecar cleanup for container types. When this runs inside a transaction
      // the txDb proxy's _removeSidecarPath stub throws ShardKeyError — matching
      // the record-op behaviour documented for transactions.
      if (config.type === 'subdatabase') {
        await this._db._removeSidecarPath(this._db._subdatabaseFilePath(name));
      } else if (config.type === 'sharded') {
        await this._db._removeSidecarPath(this._db._shardedDir(name));
        if (this._db._shardManifests) this._db._shardManifests.delete(name);
      }

      // Purge any stale _idIndex entries for this entity so a later
      // createEntity with the same name starts from an empty index.
      if (this._db._purgeIdIndexForEntity) {
        this._db._purgeIdIndexForEntity(name);
      }

      delete data.entitiesConfiguration[name];
      await this._db._write(data);
    });
  }
}

module.exports = EntityManager;
