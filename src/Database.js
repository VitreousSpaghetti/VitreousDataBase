'use strict';

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { FileAccessError } = require('./errors');

const EMPTY_DB = { entitiesConfiguration: {}, entities: {} };

class Database {
  constructor(filePath, options = {}) {
    this._filePath = path.resolve(filePath);
    this._eager = Boolean(options.eager);
    this._cache = null;
    this._dirty = false;
    this._queue = Promise.resolve();
    this._closed = false;

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
      if (this._eager && this._dirty && this._cache !== null) {
        try {
          const tempPath = this._filePath + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
          fs.writeFileSync(tempPath, JSON.stringify(this._cache, null, 2), 'utf8');
          fs.renameSync(tempPath, this._filePath);
        } catch {
          // best effort — cannot throw in exit handler
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
    const tempPath = this._filePath + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      await fsPromises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
      await fsPromises.rename(tempPath, this._filePath);
    } catch (e) {
      try { await fsPromises.unlink(tempPath); } catch { /* ignore */ }
      throw new FileAccessError(this._filePath, `cannot write file: ${e.message}`);
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

      const txDb = {
        _closed: false,
        _read:    async ()        => snapshot,
        _write:   async (newData) => { snapshot = newData; },
        _enqueue: (txFn)          => txFn(),
      };

      const EntityManager = require('./EntityManager');
      const RecordManager = require('./RecordManager');
      const tx = {
        entityManager: new EntityManager(txDb),
        recordManager: new RecordManager(txDb),
      };

      const result = await fn(tx);

      await this._write(snapshot);
      return result;
    });
  }

  async flush() {
    if (!this._eager) return;
    if (this._cache !== null && this._dirty) {
      await this._atomicWrite(this._cache);
      this._dirty = false;
    }
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