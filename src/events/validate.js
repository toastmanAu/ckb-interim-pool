'use strict';
/**
 * validate.js — event schema validation against the checked-in JSON Schemas
 * (schemas/*.schema.json) using Ajv. The same validator is used by the edge
 * (before publish) and the central ingestion service (before insert).
 */

const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv/dist/2020.js');

const SCHEMA_DIR = path.join(__dirname, '..', '..', 'schemas');

const ajv = new Ajv({ strict: true, allErrors: true });
const validators = new Map();

for (const f of fs.readdirSync(SCHEMA_DIR)) {
  if (!f.endsWith('.schema.json')) continue;
  const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, f), 'utf8'));
  ajv.addSchema(schema);
}

function validatorFor(schemaName) {
  if (!validators.has(schemaName)) {
    const v = ajv.getSchema(schemaName);
    if (!v) return null;
    validators.set(schemaName, v);
  }
  return validators.get(schemaName);
}

/** Validate an event object against its declared schema. */
function validate(event) {
  if (!event || typeof event !== 'object') return { ok: false, errors: 'not an object' };
  if (typeof event.schema !== 'string') return { ok: false, errors: 'missing schema' };
  const v = validatorFor(event.schema);
  if (!v) return { ok: false, errors: `unknown schema: ${event.schema}` };
  if (!v(event)) return { ok: false, errors: JSON.stringify(v.errors) };
  return { ok: true };
}

module.exports = { validate, validatorFor };
