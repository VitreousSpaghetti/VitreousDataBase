'use strict';

const path = require('path');
const {
  EntityNotFoundError,
  EntityTypeError,
  InvalidIdError,
  RecordNotFoundError,
  ShardKeyError,
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

// ---------------------------------------------------------------------------
// Entity-kind dispatch
//
// RecordManager operates on five kinds of record-bearing entities:
//
//   'table'              legacy: records in data.entities[name]
//   'subdatabase'        top-level container: records in <sidecar>/<name>.json (.records)
//   'sharded'            top-level partitioned container:
//                        records in <sidecar>/<name>/<shardfile>.json (.records)
//   'subdatabase-child'  table child of a subdatabase:
//                        records in <sidecar>/<parent>.json (.entities[child])
//   'sharded-child'      table child of a sharded parent:
//                        records in <sidecar>/<parent>/<shardfile>.json (.entities[child])
//
// Dotted paths ("parent.child") are used for sub-entity children. Public API
// methods accept either "entityName" or "parent.child" as the entity argument.
// ---------------------------------------------------------------------------

class RecordManager {
  constructor(db) {
    this._db = db;
    this._watchers = new Map(); // Map<dottedPath, Set<callback>>
  }

  /**
   * Subscribes to changes on an entity. Returns an unsubscribe function.
   * For sub-entity children, pass the dotted path ("parent.child").
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

  /**
   * Resolves an entity path to its kind and configuration. Accepts either a
   * single name ("users") or a dotted path ("countries.person"). Throws
   * EntityNotFoundError / EntityTypeError on invalid inputs.
   *
   * @returns {{ kind, name, dottedPath, config, parentName?, parentConfig?, childName? }}
   */
  _resolveEntity(data, dottedPath) {
    if (typeof dottedPath !== 'string' || dottedPath.length === 0) {
      throw new EntityNotFoundError(String(dottedPath));
    }
    const parts = dottedPath.split('.');
    if (parts.length === 1) {
      const name = parts[0];
      if (!Object.prototype.hasOwnProperty.call(data.entitiesConfiguration, name)) {
        throw new EntityNotFoundError(name);
      }
      const config = data.entitiesConfiguration[name];
      if (config.type === 'object') {
        // Preserves the legacy 'table' expected value so existing callers /
        // tests catching EntityTypeError still see expected==='table'.
        throw new EntityTypeError(name, 'table', 'object');
      }
      if (config.type !== 'table' && config.type !== 'subdatabase' && config.type !== 'sharded') {
        throw new EntityTypeError(name, 'table', config.type);
      }
      return { kind: config.type, name, dottedPath: name, config };
    }
    if (parts.length !== 2) {
      throw new EntityNotFoundError(dottedPath);
    }
    const [parentName, childName] = parts;
    if (!Object.prototype.hasOwnProperty.call(data.entitiesConfiguration, parentName)) {
      throw new EntityNotFoundError(parentName);
    }
    const parentConfig = data.entitiesConfiguration[parentName];
    if (parentConfig.type !== 'subdatabase' && parentConfig.type !== 'sharded') {
      throw new EntityTypeError(parentName, 'subdatabase|sharded', parentConfig.type);
    }
    const subEntities = parentConfig.subEntities || {};
    if (!Object.prototype.hasOwnProperty.call(subEntities, childName)) {
      throw new EntityNotFoundError(dottedPath);
    }
    const childConfig = subEntities[childName];
    if (childConfig.type !== 'table') {
      throw new EntityTypeError(dottedPath, 'table', childConfig.type);
    }
    return {
      kind: parentConfig.type === 'subdatabase' ? 'subdatabase-child' : 'sharded-child',
      name: dottedPath,
      dottedPath,
      config: childConfig,
      parentName,
      parentConfig,
      childName,
    };
  }

  /**
   * Builds a "fake" data snapshot whose entitiesConfiguration and entities both
   * have `validationKey` pointing to the given config (with type coerced to
   * 'table' for validateRecord's sake) and records array. Lets us reuse the
   * existing Validator without teaching it about sub/sharded kinds.
   */
  _buildFakeData(data, validationKey, config, scopedRecords) {
    const configForValidation = { ...config, type: 'table' };
    const fakeEC = { ...data.entitiesConfiguration };
    Object.defineProperty(fakeEC, validationKey, {
      value: configForValidation, writable: true, enumerable: true, configurable: true,
    });
    const fakeE = { ...data.entities };
    Object.defineProperty(fakeE, validationKey, {
      value: scopedRecords, writable: true, enumerable: true, configurable: true,
    });
    return { entitiesConfiguration: fakeEC, entities: fakeE };
  }

  /**
   * Resolves (and optionally loads) the single scope — records array + commit
   * closure — to read/mutate for the given entity kind.
   *
   * For 'sharded' / 'sharded-child', the shard tuple is read from `keySource`
   * (which is the record for insert, idObject for find/update/delete on top-level
   * sharded, or options.scope for sharded-child).
   *
   * When `createIfMissing` is false and the target shard does not yet exist in
   * the manifest, returns null. Callers interpret this as "no record".
   *
   * @returns {Promise<null | {
   *   records: any[],
   *   commit: () => Promise<void>,
   *   scopeKey: string,
   *   validationKey: string,
   *   validationData: object,
   * }>}
   */
  async _resolveScope(ctx, keySource, data, { createIfMissing = false } = {}) {
    switch (ctx.kind) {
      case 'table': {
        if (!Object.prototype.hasOwnProperty.call(data.entities, ctx.name)) {
          Object.defineProperty(data.entities, ctx.name, {
            value: [], writable: true, enumerable: true, configurable: true,
          });
        }
        const records = data.entities[ctx.name];
        return {
          records,
          commit: async () => { await this._db._write(data); },
          scopeKey: `table/${ctx.name}`,
          validationKey: ctx.name,
          validationData: data,
        };
      }
      case 'subdatabase': {
        const absPath = this._db._subdatabaseFilePath(ctx.name);
        const payload = await this._db._loadContainer(absPath);
        return {
          records: payload.records,
          commit: async () => { await this._db._writeContainer(absPath, payload); },
          scopeKey: `subdatabase/${ctx.name}`,
          validationKey: ctx.name,
          validationData: this._buildFakeData(data, ctx.name, ctx.config, payload.records),
        };
      }
      case 'sharded': {
        const shardValues = this._extractShardValues(ctx, ctx.config.shardKey, keySource, ctx.name);
        const absPath = await this._getShardPath(
          ctx.name, ctx.config.shardKey, shardValues, createIfMissing
        );
        if (!absPath) return null;
        const payload = await this._db._loadContainer(absPath);
        return {
          records: payload.records,
          commit: async () => { await this._db._writeContainer(absPath, payload); },
          scopeKey: `sharded/${ctx.name}/${path.basename(absPath)}`,
          validationKey: ctx.name,
          validationData: this._buildFakeData(data, ctx.name, ctx.config, payload.records),
        };
      }
      case 'subdatabase-child': {
        const absPath = this._db._subdatabaseFilePath(ctx.parentName);
        const payload = await this._db._loadContainer(absPath);
        if (!Object.prototype.hasOwnProperty.call(payload.entities, ctx.childName)) {
          Object.defineProperty(payload.entities, ctx.childName, {
            value: [], writable: true, enumerable: true, configurable: true,
          });
        }
        const records = payload.entities[ctx.childName];
        return {
          records,
          commit: async () => { await this._db._writeContainer(absPath, payload); },
          scopeKey: `subdatabase/${ctx.parentName}/${ctx.childName}`,
          validationKey: ctx.dottedPath,
          validationData: this._buildFakeData(data, ctx.dottedPath, ctx.config, records),
        };
      }
      case 'sharded-child': {
        const shardValues = this._extractShardValues(
          ctx, ctx.parentConfig.shardKey, keySource, ctx.dottedPath, true
        );
        const absPath = await this._getShardPath(
          ctx.parentName, ctx.parentConfig.shardKey, shardValues, createIfMissing
        );
        if (!absPath) return null;
        const payload = await this._db._loadContainer(absPath);
        if (!Object.prototype.hasOwnProperty.call(payload.entities, ctx.childName)) {
          Object.defineProperty(payload.entities, ctx.childName, {
            value: [], writable: true, enumerable: true, configurable: true,
          });
        }
        const records = payload.entities[ctx.childName];
        return {
          records,
          commit: async () => { await this._db._writeContainer(absPath, payload); },
          scopeKey: `sharded/${ctx.parentName}/${path.basename(absPath)}/${ctx.childName}`,
          validationKey: ctx.dottedPath,
          validationData: this._buildFakeData(data, ctx.dottedPath, ctx.config, records),
        };
      }
      default:
        throw new EntityTypeError(ctx.name, 'table|subdatabase|sharded', ctx.kind);
    }
  }

  _extractShardValues(ctx, shardKeyFields, keySource, displayName, isParentScope = false) {
    if (!keySource || typeof keySource !== 'object') {
      throw new ShardKeyError(
        displayName,
        `${isParentScope ? 'options.scope' : 'record/idObject'} must supply shardKey fields [${shardKeyFields.join(', ')}]`
      );
    }
    const values = [];
    for (const f of shardKeyFields) {
      const v = keySource[f];
      if (v === undefined || v === null) {
        throw new ShardKeyError(
          displayName,
          `shardKey field "${f}" is missing or null`
        );
      }
      values.push(v);
    }
    return values;
  }

  /**
   * Returns the absolute shard file path for (entityName, shardValues), creating
   * the manifest entry if `createIfMissing` is true. Returns null when the shard
   * does not exist and creation is disabled.
   */
  async _getShardPath(entityName, shardKeyFields, shardValues, createIfMissing) {
    if (createIfMissing) {
      return this._db._resolveShardFile(entityName, shardKeyFields, shardValues);
    }
    const manifest = await this._db._loadShardedManifest(entityName);
    const { jsonKey } = this._db._encodeShardFilename(shardKeyFields, shardValues);
    if (!Object.prototype.hasOwnProperty.call(manifest.shards, jsonKey)) {
      return null;
    }
    return this._db._shardedShardFilePath(entityName, manifest.shards[jsonKey]);
  }

  /**
   * Returns every currently-registered scope for multi-scope operations
   * (findAll / findWhere). For sharded entities this is one entry per shard
   * file in the manifest; for sharded children it is one entry per parent shard
   * unless `options.scope` pins a specific parent.
   */
  async _listScopes(ctx, data, options = {}) {
    switch (ctx.kind) {
      case 'table': {
        const records = Object.prototype.hasOwnProperty.call(data.entities, ctx.name)
          ? data.entities[ctx.name]
          : [];
        return [{ records, scopeKey: `table/${ctx.name}` }];
      }
      case 'subdatabase': {
        const absPath = this._db._subdatabaseFilePath(ctx.name);
        const payload = await this._db._loadContainer(absPath);
        return [{ records: payload.records, scopeKey: `subdatabase/${ctx.name}` }];
      }
      case 'sharded': {
        const shardPaths = await this._shardedPaths(ctx, options.shardValues);
        const scopes = [];
        for (const absPath of shardPaths) {
          const payload = await this._db._loadContainer(absPath);
          scopes.push({
            records: payload.records,
            scopeKey: `sharded/${ctx.name}/${path.basename(absPath)}`,
          });
        }
        return scopes;
      }
      case 'subdatabase-child': {
        const absPath = this._db._subdatabaseFilePath(ctx.parentName);
        const payload = await this._db._loadContainer(absPath);
        const records = Object.prototype.hasOwnProperty.call(payload.entities, ctx.childName)
          ? payload.entities[ctx.childName]
          : [];
        return [{ records, scopeKey: `subdatabase/${ctx.parentName}/${ctx.childName}` }];
      }
      case 'sharded-child': {
        let shardPaths;
        if (options.scope) {
          const values = this._extractShardValues(
            ctx, ctx.parentConfig.shardKey, options.scope, ctx.dottedPath, true
          );
          const absPath = await this._getShardPath(
            ctx.parentName, ctx.parentConfig.shardKey, values, false
          );
          shardPaths = absPath ? [absPath] : [];
        } else {
          shardPaths = await this._db._listShardFiles(ctx.parentName);
        }
        const scopes = [];
        for (const absPath of shardPaths) {
          const payload = await this._db._loadContainer(absPath);
          const records = Object.prototype.hasOwnProperty.call(payload.entities, ctx.childName)
            ? payload.entities[ctx.childName]
            : [];
          scopes.push({
            records,
            scopeKey: `sharded/${ctx.parentName}/${path.basename(absPath)}/${ctx.childName}`,
          });
        }
        return scopes;
      }
      default:
        throw new EntityTypeError(ctx.name, 'table|subdatabase|sharded', ctx.kind);
    }
  }

  async _shardedPaths(ctx, pinnedShardValues) {
    if (pinnedShardValues) {
      const absPath = await this._getShardPath(
        ctx.name, ctx.config.shardKey, pinnedShardValues, false
      );
      return absPath ? [absPath] : [];
    }
    return this._db._listShardFiles(ctx.name);
  }

  /**
   * Attempts to prune a sharded-kind findWhere to a single shard by extracting
   * direct-equality values for every shardKey field from a plain-object predicate.
   * Returns null if the predicate is not prunable (function predicate, missing
   * shardKey field, or operator object on a shardKey field).
   */
  _tryPrunePredicate(ctx, predicate) {
    if (ctx.kind !== 'sharded' && ctx.kind !== 'sharded-child') return null;
    if (!isPlainObject(predicate)) return null;
    const shardKey = ctx.kind === 'sharded'
      ? ctx.config.shardKey
      : ctx.parentConfig.shardKey;
    const values = [];
    for (const f of shardKey) {
      if (!Object.prototype.hasOwnProperty.call(predicate, f)) return null;
      const v = predicate[f];
      if (isPlainObject(v)) {
        // Operator object or nested match — can't prune on it safely.
        if (Object.keys(v).some(k => k.startsWith('$'))) return null;
        return null;
      }
      if (v === undefined || v === null) return null;
      values.push(v);
    }
    return values;
  }

  // -------------------------------------------------------------------------
  // In-memory id index (eager mode only)
  //
  // Lazy-built per scopeKey. Insert appends to the map; id fields are
  // immutable so update does not shift keys; delete invalidates the whole
  // scope map (indexes after the deleted row shift by one).
  // -------------------------------------------------------------------------

  _idKey(idFields, record) {
    return JSON.stringify(idFields.map(f => record[f]));
  }

  _ensureIdIndex(scopeKey, records, idFields) {
    if (!this._db._eager || !this._db._idIndex) return null;
    let map = this._db._idIndex.get(scopeKey);
    if (!map) {
      map = new Map();
      for (let i = 0; i < records.length; i++) {
        map.set(this._idKey(idFields, records[i]), i);
      }
      this._db._idIndex.set(scopeKey, map);
    }
    return map;
  }

  _invalidateIdIndex(scopeKey) {
    if (this._db._idIndex) this._db._idIndex.delete(scopeKey);
  }

  _findIndexById(records, idFields, idObject, scopeKey) {
    const map = this._ensureIdIndex(scopeKey, records, idFields);
    if (map) {
      const key = JSON.stringify(idFields.map(f => idObject[f]));
      const idx = map.get(key);
      return idx !== undefined ? idx : -1;
    }
    return records.findIndex(r => idFields.every(f => r[f] === idObject[f]));
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Inserts a new record into the given entity.
   *
   * @param {string} entityName
   * @param {object} rawRecord
   * @param {{ scope?: object }} [options]  Required for sharded-child inserts:
   *                                         options.scope carries the parent
   *                                         shardKey values locating the shard.
   * @returns {object} inserted record (clone)
   */
  async insert(entityName, rawRecord, options = {}) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();
      const ctx = this._resolveEntity(data, entityName);
      if (!rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) {
        throw new TypeError('insert() record must be a plain object');
      }
      const record = normalizeMinusZero(rawRecord);

      const keySource = ctx.kind === 'sharded-child' ? options.scope : record;
      const scope = await this._resolveScope(ctx, keySource, data, { createIfMissing: true });

      validateRecord(scope.validationKey, record, scope.validationData);

      const clone = JSON.parse(JSON.stringify(record));
      scope.records.push(clone);

      // Update id index incrementally
      if (this._db._eager && this._db._idIndex) {
        const map = this._db._idIndex.get(scope.scopeKey);
        if (map) {
          map.set(this._idKey(ctx.config.id, clone), scope.records.length - 1);
        }
      }

      await scope.commit();
      const inserted = JSON.parse(JSON.stringify(clone));
      this._emit(ctx.dottedPath, { type: 'insert', record: inserted });
      return inserted;
    });
  }

  /**
   * Finds a record by a composite or single id object.
   *
   * @param {string} entityName
   * @param {object} idObject
   * @param {{ scope?: object }} [options]  Required for sharded-child lookups.
   */
  async findById(entityName, idObject, options = {}) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();
      const ctx = this._resolveEntity(data, entityName);
      validateFullIdObject(ctx.dottedPath, idObject, ctx.config);

      const keySource = ctx.kind === 'sharded-child' ? options.scope : idObject;
      const scope = await this._resolveScope(ctx, keySource, data, { createIfMissing: false });
      if (!scope) return null;

      const idx = this._findIndexById(scope.records, ctx.config.id, idObject, scope.scopeKey);
      return idx === -1 ? null : JSON.parse(JSON.stringify(scope.records[idx]));
    });
  }

  /**
   * Convenience for entities with a single id field.
   */
  async findByIdSingle(entityName, value, options = {}) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();
      const ctx = this._resolveEntity(data, entityName);

      if (ctx.config.id.length !== 1) {
        throw new InvalidIdError(
          ctx.dottedPath,
          `findByIdSingle requires exactly one id field, but "${ctx.dottedPath}" has [${ctx.config.id.join(', ')}]`
        );
      }
      const idField = ctx.config.id[0];
      const idObject = { [idField]: value };

      const keySource = ctx.kind === 'sharded-child' ? options.scope : idObject;
      const scope = await this._resolveScope(ctx, keySource, data, { createIfMissing: false });
      if (!scope) return null;

      const idx = this._findIndexById(scope.records, ctx.config.id, idObject, scope.scopeKey);
      return idx === -1 ? null : JSON.parse(JSON.stringify(scope.records[idx]));
    });
  }

  /**
   * Returns all records for an entity. For sharded entities this fans out
   * across every registered shard; for sharded-child, pass options.scope to
   * restrict to a single parent shard.
   */
  async findAll(entityName, options = {}) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();
      const ctx = this._resolveEntity(data, entityName);
      const scopes = await this._listScopes(ctx, data, options);
      const out = [];
      for (const scope of scopes) {
        for (const r of scope.records) out.push(r);
      }
      return JSON.parse(JSON.stringify(out));
    });
  }

  /**
   * Filters records by a function predicate or a plain object. For sharded
   * entities, a plain-object predicate that pins every shardKey field to a
   * direct value automatically prunes to a single shard.
   */
  async findWhere(entityName, predicate, options = {}) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();
      const ctx = this._resolveEntity(data, entityName);

      let matchFn;
      if (typeof predicate === 'function') {
        matchFn = predicate;
      } else if (isPlainObject(predicate)) {
        matchFn = r => deepMatch(r, predicate);
      } else {
        throw new TypeError('predicate must be a function or a plain object');
      }

      // Shard pruning: for sharded (top-level), try to extract shardKey from
      // the predicate. For sharded-child, an explicit options.scope already
      // does the pruning via _listScopes.
      let listOptions = options;
      if (ctx.kind === 'sharded') {
        const pinned = this._tryPrunePredicate(ctx, predicate);
        if (pinned) listOptions = { ...options, shardValues: pinned };
      }

      const scopes = await this._listScopes(ctx, data, listOptions);
      const out = [];
      for (const scope of scopes) {
        for (const r of scope.records) {
          if (matchFn(r)) out.push(r);
        }
      }
      return JSON.parse(JSON.stringify(out));
    });
  }

  /**
   * Updates a record identified by idObject, merging updates into existing
   * fields. id fields (and for sharded, shardKey fields — which are ⊆ id) are
   * immutable.
   */
  async update(entityName, idObject, updates, options = {}) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();
      const ctx = this._resolveEntity(data, entityName);

      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        throw new TypeError('update() updates must be a plain object');
      }
      for (const idField of ctx.config.id) {
        if (Object.prototype.hasOwnProperty.call(updates, idField)) {
          throw new InvalidIdError(ctx.dottedPath, `id fields are immutable and cannot be updated ("${idField}")`);
        }
      }
      validateFullIdObject(ctx.dottedPath, idObject, ctx.config);

      const keySource = ctx.kind === 'sharded-child' ? options.scope : idObject;
      const scope = await this._resolveScope(ctx, keySource, data, { createIfMissing: false });
      if (!scope) throw new RecordNotFoundError(ctx.dottedPath, idObject);

      const idx = this._findIndexById(scope.records, ctx.config.id, idObject, scope.scopeKey);
      if (idx === -1) throw new RecordNotFoundError(ctx.dottedPath, idObject);

      const existingRecord = scope.records[idx];
      const previous = JSON.parse(JSON.stringify(existingRecord));

      const merged = normalizeMinusZero(deepMerge(existingRecord, updates));
      validateRecord(scope.validationKey, merged, scope.validationData, {
        isUpdate: true, existingRecord,
      });

      scope.records[idx] = merged;
      await scope.commit();
      const updated = JSON.parse(JSON.stringify(merged));
      this._emit(ctx.dottedPath, { type: 'update', record: updated, previous });
      return updated;
    });
  }

  /**
   * Deletes a record identified by idObject.
   */
  async deleteRecord(entityName, idObject, options = {}) {
    return this._db._enqueue(async () => {
      const data = await this._db._read();
      const ctx = this._resolveEntity(data, entityName);
      validateFullIdObject(ctx.dottedPath, idObject, ctx.config);

      const keySource = ctx.kind === 'sharded-child' ? options.scope : idObject;
      const scope = await this._resolveScope(ctx, keySource, data, { createIfMissing: false });
      if (!scope) throw new RecordNotFoundError(ctx.dottedPath, idObject);

      const idx = this._findIndexById(scope.records, ctx.config.id, idObject, scope.scopeKey);
      if (idx === -1) throw new RecordNotFoundError(ctx.dottedPath, idObject);

      const deleted = scope.records.splice(idx, 1)[0];
      // Index entries after idx have shifted — invalidate the whole scope.
      this._invalidateIdIndex(scope.scopeKey);

      await scope.commit();
      const deletedClone = JSON.parse(JSON.stringify(deleted));
      this._emit(ctx.dottedPath, { type: 'delete', record: deletedClone });
      return deletedClone;
    });
  }
}

module.exports = RecordManager;
