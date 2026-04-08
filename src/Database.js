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
      await this._atomicWrite(JSON.parse(JSON.stringify(EMPTY_DB)));
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
    process.on('exit', () => {
      if (this._eager && this._dirty && this._cache !== null) {
        try {
          const tempPath = this._filePath + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
          fs.writeFileSync(tempPath, JSON.stringify(this._cache, null, 2), 'utf8');
          fs.renameSync(tempPath, this._filePath);
        } catch {
          // best effort — cannot throw in exit handler
        }
      }
    });
  }

  _enqueue(fn) {
    const next = this._queue.then(fn);
    this._queue = next.catch(() => {});
    return next;
  }

  async _read() {
    if (this._closed) throw new FileAccessError(this._filePath, 'database is closed');
    if (this._eager) {
      if (this._cache === null) {
        const raw = await fsPromises.readFile(this._filePath, 'utf8');
        this._cache = JSON.parse(raw);
      }
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