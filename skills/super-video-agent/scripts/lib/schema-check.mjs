// Minimal, dependency-free validator for plan.schema.json. Not a general
// JSON-Schema engine — it only implements the subset plan.schema.json uses
// (object/required/additionalProperties/properties/enum/pattern/array/
// minItems/maxItems/items/type/minimum/maximum/exclusiveMinimum/minLength, an
// additionalProperties schema, and local "#/definitions/<name>" $ref), which is
// enough to validate this one schema exactly and report the failing path.

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function checkType(value, type, path, errors) {
  const actual = typeOf(value);
  if (type === "integer") {
    if (actual !== "number" || !Number.isInteger(value)) {
      errors.push(`${path}: expected integer, got ${actual}`);
      return false;
    }
    return true;
  }
  if (actual !== type) {
    errors.push(`${path}: expected ${type}, got ${actual}`);
    return false;
  }
  return true;
}

const REF_PREFIX = "#/definitions/";

/** The schema a local "#/definitions/<name>" $ref points at. */
function resolveRef(root, ref) {
  const target = ref.startsWith(REF_PREFIX) ? (root.definitions || {})[ref.slice(REF_PREFIX.length)] : null;
  if (!target) throw new Error(`schema: unresolved $ref "${ref}"`);
  return target;
}

function validateNode(value, node, path, errors, root) {
  const schema = node.$ref ? resolveRef(root, node.$ref) : node;
  if (schema.oneOf) {
    const attempts = schema.oneOf.map((sub) => {
      const subErrors = [];
      validateNode(value, sub, path, subErrors, root);
      return subErrors;
    });
    if (!attempts.some((e) => e.length === 0)) errors.push(`${path}: matches none of the allowed forms (${attempts.map((e) => e[0]).join("; ")})`);
    return;
  }
  if (schema.type) {
    if (!checkType(value, schema.type, path, errors)) return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (schema.pattern && typeof value === "string") {
    const re = new RegExp(schema.pattern);
    if (!re.test(value)) errors.push(`${path}: "${value}" does not match pattern ${schema.pattern}`);
  }
  if (typeof value === "string" && schema.minLength != null && value.length < schema.minLength) {
    errors.push(`${path}: string shorter than minLength ${schema.minLength}`);
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum)
      errors.push(`${path}: ${value} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
  }
  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const props = schema.properties || {};
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push(`${path}: missing required property "${req}"`);
    }
    const extra = schema.additionalProperties;
    for (const key of Object.keys(value)) {
      if (key in props) continue;
      if (extra === false) errors.push(`${path}: unexpected property "${key}"`);
      else if (extra && typeof extra === "object") validateNode(value[key], extra, `${path}.${key}`, errors, root);
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) validateNode(value[key], sub, `${path}.${key}`, errors, root);
    }
  }
  if (schema.type === "array" && Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push(`${path}: array shorter than minItems ${schema.minItems}`);
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      errors.push(`${path}: array longer than maxItems ${schema.maxItems}`);
    }
    if (schema.items) {
      value.forEach((item, i) => validateNode(item, schema.items, `${path}[${i}]`, errors, root));
    }
  }
}

/**
 * Validate `data` against `schema`, or against one of its local definitions when `ref`
 * ("#/definitions/<name>") is given.
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validate(data, schema, ref = null) {
  const errors = [];
  validateNode(data, ref ? { $ref: ref } : schema, "$", errors, schema);
  return { valid: errors.length === 0, errors };
}
