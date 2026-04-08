'use strict';

class VitreousError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VitreousError';
  }
}

class FileAccessError extends VitreousError {
  constructor(filePath, reason) {
    super(`Cannot access file at "${filePath}": ${reason}`);
    this.name = 'FileAccessError';
    this.filePath = filePath;
    this.reason = reason;
  }
}

class EntityNotFoundError extends VitreousError {
  constructor(entityName) {
    super(`Entity "${entityName}" not found in entitiesConfiguration`);
    this.name = 'EntityNotFoundError';
    this.entityName = entityName;
  }
}

class EntityAlreadyExistsError extends VitreousError {
  constructor(entityName) {
    super(`Entity "${entityName}" already exists in entitiesConfiguration`);
    this.name = 'EntityAlreadyExistsError';
    this.entityName = entityName;
  }
}

class EntityTypeError extends VitreousError {
  constructor(entityName, expected, actual) {
    super(`Entity "${entityName}" has type "${actual}" but "${expected}" was required`);
    this.name = 'EntityTypeError';
    this.entityName = entityName;
    this.expected = expected;
    this.actual = actual;
  }
}

class EntityInUseError extends VitreousError {
  constructor(entityName, referencedBy) {
    super(
      `Cannot delete object entity "${entityName}": still referenced as nested by [${referencedBy.join(', ')}]`
    );
    this.name = 'EntityInUseError';
    this.entityName = entityName;
    this.referencedBy = referencedBy;
  }
}

class UnknownFieldError extends VitreousError {
  constructor(entityName, fieldName) {
    super(`Field "${fieldName}" is not declared in values of entity "${entityName}"`);
    this.name = 'UnknownFieldError';
    this.entityName = entityName;
    this.fieldName = fieldName;
  }
}

class NullConstraintError extends VitreousError {
  constructor(entityName, fieldName) {
    super(`Field "${fieldName}" of entity "${entityName}" is declared notnullable but received null or undefined`);
    this.name = 'NullConstraintError';
    this.entityName = entityName;
    this.fieldName = fieldName;
  }
}

class UniqueConstraintError extends VitreousError {
  constructor(entityName, fieldName, value) {
    super(`Field "${fieldName}" of entity "${entityName}" must be unique, but value "${value}" already exists`);
    this.name = 'UniqueConstraintError';
    this.entityName = entityName;
    this.fieldName = fieldName;
    this.value = value;
  }
}

class NestedTypeError extends VitreousError {
  constructor(entityName, fieldName) {
    super(`Field "${fieldName}" of entity "${entityName}" is declared as nested but received a non-object value`);
    this.name = 'NestedTypeError';
    this.entityName = entityName;
    this.fieldName = fieldName;
  }
}

class InvalidIdError extends VitreousError {
  constructor(entityName, reason) {
    super(`Invalid id configuration for entity "${entityName}": ${reason}`);
    this.name = 'InvalidIdError';
    this.entityName = entityName;
    this.reason = reason;
  }
}

class CircularReferenceError extends VitreousError {
  constructor(entityName, cycle) {
    super(`Circular nested reference detected starting from entity "${entityName}": ${cycle.join(' -> ')}`);
    this.name = 'CircularReferenceError';
    this.entityName = entityName;
    this.cycle = cycle;
  }
}

class RecordNotFoundError extends VitreousError {
  constructor(entityName, idObject) {
    super(`No record found in entity "${entityName}" matching ${JSON.stringify(idObject)}`);
    this.name = 'RecordNotFoundError';
    this.entityName = entityName;
    this.idObject = idObject;
  }
}

class InvalidMigrationError extends VitreousError {
  constructor(entityName, reason) {
    super(`[${entityName}] invalid migration: ${reason}`);
    this.name = 'InvalidMigrationError';
    this.entityName = entityName;
    this.reason = reason;
  }
}

module.exports = {
  VitreousError,
  FileAccessError,
  EntityNotFoundError,
  EntityAlreadyExistsError,
  EntityTypeError,
  EntityInUseError,
  UnknownFieldError,
  NullConstraintError,
  UniqueConstraintError,
  NestedTypeError,
  InvalidIdError,
  CircularReferenceError,
  RecordNotFoundError,
  InvalidMigrationError,
};
