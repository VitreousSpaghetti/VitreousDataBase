'use strict';

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { FileAccessError, ShardKeyError } = require('./errors');

const EMPTY_DB = { entitiesConfiguration: {}, entities: {} };
// Sidecar container file format, shared by subdatabase and sharded entities:
//   records  — array of the container's own records (multi-instance model)
//   entities — map of child-entity-name -> records array
const EMPTY_CONTAINER = () => ({ records: [], entities: {} });
const EMPTY_MANIFEST = () => ({ version: 1, shards: {} });

// Max encoded shard filename length before falling back to sha1-based naming.
const SHARD_FILENAME_MAX_LEN = 120;
// Characters disallowed in the encoded filename (conservative, post-encodeURIComponent).
const UNSAFE_FILENAME_CHARS = /[\/\\\x00]|\.\./;

class Database {
  constructor(filePath, options = {}) {
    this._filePath = path.resolve(filePath);
    this._sidecarDir = this._filePath + '.vdb';
    this._eager = Boolean(options.eager);
    this._cache = null;
    this._dirty = false;
    this._queue = Promise.resolve();
    this._closed = false;

    // Eager-mode sidecar cache: relativeFilePath -> { payload, dirty }
    this._shardCache = new Map();
    // Per-sharded-entity manifest cache (always populated after first access)
    this._shardManifests = new Map();
    // True if any sidecar directory has been created in this session (lazy mkdir guard)
    this._sidecarEnsured = false;

    // In-memory id index (eager mode only), populated by RecordManager on demand.
    // Key: "<scope>" where scope is e.g. "table/users" or "countries/code=US.json/person"
    this._idIndex = new Map();

    this.entityManager = null;
    this.recordManager = null;
  }

  static async create(filePath, options = {}) {
    const db = new Database(filePath, options);
    await db._init();

    const EntityManager = require('./EntityManager');
    const RecordManager = require('./RecordManager');
    db.entityManager = new EntityManager(db);
    db.recordManager = new RecordManager(db);

    return db;
  }

  async _init() {
    const dir = path.dirname(this._filePath);

    try {
      await fsPromises.access(dir, fs.constants.R_OK | fs.constants.W_OK);
    } catch {
      throw new FileAccessError(this._filePath, `directory "${dir}" is not accessible`);
    }

    let fileExists = true;
    try {
      await fsPromises.access(this._filePath, fs.constants.F_OK);
    } catch {
      fileExists = false;
    }

    if (!fileExists) {
      const emptyData = JSON.parse(JSON.stringify(EMPTY_DB));
      await this._atomicWrite(emptyData);
      if (this._eager) {
        this._cache = emptyData;
        this._dirty = false;
        this._registerExitHandler();
      }
    } else {
      let raw;
      try {
        raw = await fsPromises.readFile(this._filePath, 'utf8');
      } catch (e) {
        throw new FileAccessError(this._filePath, `cannot read file: ${e.message}`);
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        throw new FileAccessError(this._filePath, `file exists but is not valid JSON: ${e.message}`);
      }
      if (this._eager) {
        this._cache = parsed;
        this._dirty = false;
        this._registerExitHandler();
      }
    }
  }

  _registerExitHandler() {
    this._exitHandler = () => {
      if (!this._eager || !this._dirty) return;
      // Best effort: main file + every dirty sidecar entry. Errors are swallowed
      // because exit handlers cannot propagate.
      const syncAtomicWrite = (targetPath, data) => {
        try {
          const dir = path.dirname(targetPath);
          fs.mkdirSync(dir, { recursive: true });
          const tempPath = targetPath + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
          fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
          fs.renameSync(tempPath, targetPath);
        } catch {
          // swallow
        }
      };
      if (this._cache !== null) {
        syncAtomicWrite(this._filePath, this._cache);
      }
      for (const entry of this._shardCache.values()) {
        if (entry.dirty) {
          syncAtomicWrite(entry.absPath, entry.payload);
        }
      }
    };
    process.on('exit', this._exitHandler);
  }

  _enqueue(fn) {
    const next = this._queue.then(fn);
    this._queue = next.catch(() => {});
    return next;
  }

  async _read() {
    if (this._closed) throw new FileAccessError(this._filePath, 'database is closed');
    if (this._eager) {
      return this._cache;
    }
    let raw;
    try {
      raw = await fsPromises.readFile(this._filePath, 'utf8');
    } catch (e) {
      throw new FileAccessError(this._filePath, `cannot read file: ${e.message}`);
    }
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new FileAccessError(this._filePath, `file is not valid JSON: ${e.message}`);
    }
  }

  async _write(data) {
    if (this._closed) throw new FileAccessError(this._filePath, 'database is closed');
    if (this._eager) {
      this._cache = data;
      this._dirty = true;
      return;
    }
    await this._atomicWrite(data);
  }

  async _atomicWrite(data) {
    await this._atomicWriteToPath(this._filePath, data);
  }

  /**
   * Atomic write (temp + rename) to an arbitrary target path. Used for both the
   * main file and every sidecar file (shard payloads, subdatabase files, manifests).
   * Creates parent directories lazily.
   */
  async _atomicWriteToPath(targetPath, data) {
    const dir = path.dirname(targetPath);
    try {
      await fsPromises.mkdir(dir, { recursive: true });
    } catch (e) {
      throw new FileAccessError(targetPath, `cannot create directory "${dir}": ${e.message}`);
    }
    const tempPath = targetPath + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      await fsPromises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
      await fsPromises.rename(tempPath, targetPath);
    } catch (e) {
      try { await fsPromises.unlink(tempPath); } catch { /* ignore */ }
      throw new FileAccessError(targetPath, `cannot write file: ${e.message}`);
    }
  }

  // ===========================================================================
  // Sidecar I/O — subdatabase files and sharded entity shard files
  //
  // Layout:
  //   <filePath>.vdb/
  //     <subdatabaseName>.json                 (single file per subdatabase entity)
  //     <shardedName>/
  //       manifest.json                        ({ version, shards: { jsonKey -> filename } })
  //       <encodedShardFilename>.json          (one per shard tuple)
  //
  // Each subdatabase/shard file has the shape: { _self, entities } where _self is the
  // container's own record (null until first insert) and entities holds child-entity
  // records keyed by child name.
  //
  // All these methods are intended to be called from INSIDE an _enqueue callback
  // started by EntityManager/RecordManager. They must not be re-enqueued.
  // ===========================================================================

  _subdatabaseFilePath(entityName) {
    return path.join(this._sidecarDir, entityName + '.json');
  }

  _shardedDir(entityName) {
    return path.join(this._sidecarDir, entityName);
  }

  _shardedManifestFilePath(entityName) {
    return path.join(this._shardedDir(entityName), 'manifest.json');
  }

  _shardedShardFilePath(entityName, shardFilename) {
    return path.join(this._shardedDir(entityName), shardFilename);
  }

  _sidecarRelativeKey(absPath) {
    // Cache key inside _shardCache: path relative to sidecar dir, using forward slashes
    // so Windows and POSIX agree.
    const rel = path.relative(this._sidecarDir, absPath);
    return rel.split(path.sep).join('/');
  }

  /**
   * Encodes a shard tuple into a filename. Returns { filename, jsonKey }.
   *   filename: the file to create on disk
   *   jsonKey:  the stable manifest key (JSON.stringify of the values array)
   *
   * Primary format: <field1>=<enc1>__<field2>=<enc2>.json
   * Fallback (when too long or contains unsafe characters): sha1-<hex16>.json
   */
  _encodeShardFilename(shardKeyFields, shardValues) {
    const jsonKey = JSON.stringify(shardValues);
    const parts = [];
    for (let i = 0; i < shardKeyFields.length; i++) {
      const f = shardKeyFields[i];
      const v = shardValues[i];
      // Stringify primitives safely. JSON.stringify handles strings/numbers/booleans/null.
      const strVal = typeof v === 'string' ? v : JSON.stringify(v);
      parts.push(`${encodeURIComponent(f)}=${encodeURIComponent(strVal)}`);
    }
    const primary = parts.join('__') + '.json';
    if (primary.length > SHARD_FILENAME_MAX_LEN || UNSAFE_FILENAME_CHARS.test(primary)) {
      const hash = crypto.createHash('sha1').update(jsonKey).digest('hex').slice(0, 16);
      return { filename: `sha1-${hash}.json`, jsonKey };
    }
    return { filename: primary, jsonKey };
  }

  /**
   * Loads a sharded entity's manifest. Creates an empty one if the file does not
   * exist yet. Cached in _shardManifests on first access.
   */
  async _loadShardedManifest(entityName) {
    if (this._shardManifests.has(entityName)) {
      return this._shardManifests.get(entityName);
    }
    const manifestPath = this._shardedManifestFilePath(entityName);
    let manifest;
    try {
      const raw = await fsPromises.readFile(manifestPath, 'utf8');
      manifest = JSON.parse(raw);
      if (!manifest || typeof manifest !== 'object' || typeof manifest.shards !== 'object') {
        throw new Error('manifest is malformed');
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        manifest = EMPTY_MANIFEST();
      } else {
        throw new FileAccessError(manifestPath, `cannot read manifest: ${e.message}`);
      }
    }
    this._shardManifests.set(entityName, manifest);
    return manifest;
  }

  /**
   * Persists a sharded entity's manifest to disk via atomic write. In eager mode the
   * manifest is kept in _shardManifests and also written through on every change
   * (manifests are small and infrequent).
   */
  async _writeShardedManifest(entityName, manifest) {
    this._shardManifests.set(entityName, manifest);
    await this._atomicWriteToPath(this._shardedManifestFilePath(entityName), manifest);
  }

  /**
   * Resolves (or creates) the shard filename for a given tuple. Updates the manifest
   * on disk if a new entry is added. Returns the absolute file path.
   */
  async _resolveShardFile(entityName, shardKeyFields, shardValues) {
    const manifest = await this._loadShardedManifest(entityName);
    const { filename, jsonKey } = this._encodeShardFilename(shardKeyFields, shardValues);
    if (!Object.prototype.hasOwnProperty.call(manifest.shards, jsonKey)) {
      // Defensive: two different jsonKeys could collide on the sha1 fallback; detect
      // that case and disambiguate by appending a counter.
      let finalFilename = filename;
      const existingFilenames = new Set(Object.values(manifest.shards));
      let counter = 1;
      while (existingFilenames.has(finalFilename)) {
        finalFilename = filename.replace(/\.json$/, `-${counter}.json`);
        counter++;
      }
      Object.defineProperty(manifest.shards, jsonKey, {
        value: finalFilename, writable: true, enumerable: true, configurable: true,
      });
      await this._writeShardedManifest(entityName, manifest);
      return this._shardedShardFilePath(entityName, finalFilename);
    }
    return this._shardedShardFilePath(entityName, manifest.shards[jsonKey]);
  }

  /**
   * Returns the list of absolute shard file paths currently registered in the
   * manifest for a sharded entity. Order is insertion order.
   */
  async _listShardFiles(entityName) {
    const manifest = await this._loadShardedManifest(entityName);
    return Object.values(manifest.shards).map(fn => this._shardedShardFilePath(entityName, fn));
  }

  /**
   * Loads a container file (subdatabase or shard file) from disk or the eager cache.
   * Returns an empty container ({ records: [], entities: {} }) if the file does not
   * exist yet.
   */
  async _loadContainer(absFilePath) {
    if (this._closed) throw new FileAccessError(absFilePath, 'database is closed');
    if (this._eager) {
      const key = this._sidecarRelativeKey(absFilePath);
      if (this._shardCache.has(key)) {
        return this._shardCache.get(key).payload;
      }
    }
    let payload;
    try {
      const raw = await fsPromises.readFile(absFilePath, 'utf8');
      payload = JSON.parse(raw);
      if (!payload || typeof payload !== 'object') {
        throw new Error('container payload is not an object');
      }
      if (!('entities' in payload) || typeof payload.entities !== 'object') payload.entities = {};
      if (!('records' in payload) || !Array.isArray(payload.records)) payload.records = [];
    } catch (e) {
      if (e.code === 'ENOENT') {
        payload = EMPTY_CONTAINER();
      } else {
        throw new FileAccessError(absFilePath, `cannot read container: ${e.message}`);
      }
    }
    if (this._eager) {
      const key = this._sidecarRelativeKey(absFilePath);
      this._shardCache.set(key, { payload, dirty: false, absPath: absFilePath });
    }
    return payload;
  }

  /**
   * Persists a container file. In eager mode the write is buffered in _shardCache
   * (flushed by flush()/close()/exit handler). In non-eager mode it is written
   * through immediately via atomic write.
   */
  async _writeContainer(absFilePath, payload) {
    if (this._closed) throw new FileAccessError(absFilePath, 'database is closed');
    if (this._eager) {
      const key = this._sidecarRelativeKey(absFilePath);
      this._shardCache.set(key, { payload, dirty: true, absPath: absFilePath });
      this._dirty = true;
      return;
    }
    await this._atomicWriteToPath(absFilePath, payload);
  }

  /**
   * Drops every _idIndex entry that belongs to the given top-level entity,
   * across all its record-bearing scopes. Called by EntityManager.deleteEntity
   * so that a later createEntity+insert of the same name cannot inherit a
   * stale map from the previous incarnation.
   *
   * Scope key formats cleared:
   *   "table/<name>"
   *   "subdatabase/<name>"            (container records)
   *   "subdatabase/<name>/<child>"    (subdatabase children)
   *   "sharded/<name>/<shardfile>"    (sharded records)
   *   "sharded/<name>/<shardfile>/<child>"  (sharded children)
   */
  _purgeIdIndexForEntity(name) {
    for (const key of Array.from(this._idIndex.keys())) {
      if (
        key === `table/${name}` ||
        key === `subdatabase/${name}` ||
        key.startsWith(`subdatabase/${name}/`) ||
        key.startsWith(`sharded/${name}/`)
      ) {
        this._idIndex.delete(key);
      }
    }
  }

  /**
   * Recursively removes a sidecar path (file or directory) belonging to an entity
   * being deleted. Safety: refuses to act on anything outside this._sidecarDir.
   * Also evicts any matching entries from _shardCache and _shardManifests.
   */
  async _removeSidecarPath(absPath) {
    const resolved = path.resolve(absPath);
    const sidecar = path.resolve(this._sidecarDir);
    if (resolved !== sidecar && !resolved.startsWith(sidecar + path.sep)) {
      throw new FileAccessError(absPath, 'refusing to remove path outside sidecar directory');
    }
    // Evict from cache
    const prefix = this._sidecarRelativeKey(resolved);
    for (const key of Array.from(this._shardCache.keys())) {
      if (key === prefix || key.startsWith(prefix + '/')) {
        this._shardCache.delete(key);
      }
    }
    try {
      await fsPromises.rm(resolved, { recursive: true, force: true });
    } catch (e) {
      throw new FileAccessError(absPath, `cannot remove sidecar path: ${e.message}`);
    }
  }

  /**
   * Runs multiple operations atomically. All operations share a forked in-memory
   * snapshot; if any operation throws, no changes are persisted. On success, a
   * single atomic write is performed.
   *
   * Watch callbacks registered on the real recordManager do NOT fire for
   * operations inside a transaction. Nested transactions are not supported.
   *
   * @param {(tx: { entityManager: EntityManager, recordManager: RecordManager }) => Promise<any>} fn
   * @returns {Promise<any>} resolves with the return value of fn
   */
  async transaction(fn) {
    return this._enqueue(async () => {
      const data = await this._read();
      let snapshot = JSON.parse(JSON.stringify(data));

      const rejectSidecar = () => {
        throw new ShardKeyError(
          '<transaction>',
          'sharded and subdatabase record operations are not supported inside db.transaction() in v1'
        );
      };
      const txDb = {
        _closed: false,
        _read:    async ()        => snapshot,
        _write:   async (newData) => { snapshot = newData; },
        _enqueue: (txFn)          => txFn(),
        // Sidecar I/O is not available inside transactions. Any sub/sharded record
        // op routed through RecordManager will hit one of these and throw.
        _loadContainer:        async ()  => rejectSidecar(),
        _writeContainer:       async ()  => rejectSidecar(),
        _loadShardedManifest:  async ()  => rejectSidecar(),
        _writeShardedManifest: async ()  => rejectSidecar(),
        _resolveShardFile:     async ()  => rejectSidecar(),
        _listShardFiles:       async ()  => rejectSidecar(),
        _removeSidecarPath:    async ()  => rejectSidecar(),
        _subdatabaseFilePath:  () => rejectSidecar(),
        _shardedDir:           () => rejectSidecar(),
        // Transactions have their own (empty) id index; no sharing with the real db.
        _idIndex: new Map(),
        _eager: false,
      };

      const EntityManager = require('./EntityManager');
      const RecordManager = require('./RecordManager');
      const tx = {
        entityManager: new EntityManager(txDb),
        recordManager: new RecordManager(txDb),
      };

      const result = await fn(tx);

      await this._write(snapshot);
      // Every derived in-memory index built from the pre-transaction snapshot is
      // now stale: the committed snapshot is a fresh object graph with different
      // array identities and potentially different row positions. Lazy rebuild
      // on the next lookup is safe; keeping the old map would silently return
      // wrong-row reads.
      this._idIndex.clear();
      return result;
    });
  }

  async flush() {
    if (!this._eager) return;
    if (this._cache !== null && this._dirty) {
      await this._atomicWrite(this._cache);
    }
    // Flush every dirty sidecar container as well.
    for (const entry of this._shardCache.values()) {
      if (entry.dirty) {
        await this._atomicWriteToPath(entry.absPath, entry.payload);
        entry.dirty = false;
      }
    }
    this._dirty = false;
  }

  async close() {
    return this._enqueue(async () => {
      await this.flush();
      if (this._exitHandler) {
        process.removeListener('exit', this._exitHandler);
        this._exitHandler = null;
      }
      this._cache = null;
      this._closed = true;
    });
  }
}

module.exports = Database;
/*

                            ▒▒▒▒▓▓▒▒▒▒▓▓▒▒░░                          
                      ▓▓▒▒▒▒▒▒░░▓▓░░▒▒▒▒░░▓▓▓▓▒▒▓▓                    
                  ░░░░░░░░▒▒    ▒▒  ░░    ░░▒▒▒▒▒▒▓▓▒▒░░              
              ░░░░░░                    ░░▒▒░░░░░░░░▒▒▓▓▒▒░░          
            ░░░░░░                          ░░    ░░░░▒▒░░▓▓          
          ░░░░░░                  ░░▒▒░░            ░░▒▒▒▒▒▒▓▓        
        ░░░░░░░░                    ░░                ░░▒▒░░▒▒▒▒      
        ░░░░                                      ▒▒    ▒▒░░░░░░      
      ░░░░░░    ░░                                        ▒▒▒▒░░      
    ░░░░░░░░        ░░                                      ▒▒░░░░    
    ░░░░░░░░    ▒▒  ▒▒      ░░▒▒▓▓▓▓▓▓▒▒▒▒░░        ▒▒  ▒▒░░░░▓▓░░░░  
  ░░░░░░  ░░      ▓▓  ░░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▓░░  ░░░░░░░░░░░░░░░░░░  
  ░░░░                ░░▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░░▒▒▒▒░░  ▒▒░░        ░░░░░░
  ░░░░                ▒▒▒▒▒▒░░░░░░░░▒▒▒▒░░  ░░▒▒▒▒  ░░          ▒▒░░░░
  ░░            ░░  ▒▒▒▒▒▒▒▒░░░░░░██▒▒▒▒▒▒▒▒▒▒▒▒▒▒░░            ░░░░░░
░░▒▒            ░░  ▒▒▒▒▒▒▒▒░░░░████▒▒██▒▒▒▒▒▒▒▒▒▒▒▒              ░░░░
▒▒                  ▒▒▒▒▒▒▒▒░░▒▒████  ██▓▓▒▒▒▒▒▒▒▒▒▒          ░░  ░░░░
░░░░        ▒▒      ▒▒░░▒▒▒▒▒▒▓▓██████████▒▒▒▒▒▒▒▒▒▒            ░░░░░░
░░░░░░      ▒▒  ▒▒  ▒▒░░░░▒▒▒▒▓▓██████████░░▒▒▒▒▒▒▒▒  ░░        ░░▒▒░░
░░░░            ░░  ▒▒░░░░  ░░▒▒▓▓██████░░░░▒▒▒▒▓▓▒▒  ░░░░        ░░░░
░░▒▒            ░░  ░░▒▒▒▒░░░░░░▒▒▒▒▒▒░░░░░░░░▒▒▒▒░░            ░░░░░░
  ░░░░░░░░            ▒▒▒▒▒▒▒▒▒▒▒▒▒▒░░░░▒▒▒▒▒▒▒▒▒▒░░          ░░▒▒▒▒░░
  ▒▒░░░░              ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒          ░░░░░░░░░░
  ▒▒░░▒▒░░            ▒▒░░▒▒▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒            ░░▒▒░░░░  
    ░░▒▒▒▒░░░░        ░░    ▒▒▓▓▒▒▒▒▒▒▒▒▒▒░░              ░░  ░░░░░░  
    ░░▓▓▒▒▒▒░░          ▒▒                                ░░░░░░░░    
      ▒▒▓▓░░░░░░░░░░░░▒▒  ░░░░                            ░░░░░░      
        ░░░░░░▒▒▒▒▒▒  ▒▒                                ░░  ░░        
          ▒▒▒▒▒▒▒▒░░░░░░                              ▒▒░░░░░░        
            ░░▒▒▒▒▒▒▒▒░░▒▒▒▒▒▒            ░░░░░░    ░░░░░░░░          
                ▓▓░░▒▒░░░░░░▒▒░░  ░░  ░░░░░░▒▒░░░░░░░░░░░░            
                  ░░▒▒▒▒▒▒░░▓▓▒▒▒▒░░░░▒▒░░░░░░░░░░░░                  
                        ▒▒▓▓▓▓▒▒▓▓▒▒░░░░░░░░░░                        
*/