'use strict';

const Database = require('./src/Database');
const errors = require('./src/errors');

module.exports = { Database, ...errors };
