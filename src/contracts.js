/**
 * 极简 JSON-Schema 子集校验器：支持 type / required / properties /
 * additionalProperties / items / enum，用于核对交换契约。
 */
export function validate(schema, value, path = "$") {
  const errors = [];
  const fail = (message) => errors.push(`${path}: ${message}`);

  if (schema.enum && !schema.enum.includes(value)) {
    fail(`取值 ${JSON.stringify(value)} 必须是 ${schema.enum.join(" / ")} 之一`);
    return errors;
  }
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail("必须是对象");
        return errors;
      }
      for (const key of schema.required ?? []) {
        if (!(key in value)) fail(`缺少必填字段 ${key}`);
      }
      const properties = schema.properties ?? {};
      for (const [key, sub] of Object.entries(properties)) {
        if (key in value) errors.push(...validate(sub, value[key], `${path}.${key}`));
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) fail(`不允许的字段 ${key}`);
        }
      }
      return errors;
    }
    case "array": {
      if (!Array.isArray(value)) {
        fail("必须是数组");
        return errors;
      }
      if (schema.items) {
        value.forEach((item, index) => {
          errors.push(...validate(schema.items, item, `${path}[${index}]`));
        });
      }
      return errors;
    }
    case "string":
      if (typeof value !== "string") fail("必须是字符串");
      return errors;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) fail("必须是数字");
      return errors;
    case "boolean":
      if (typeof value !== "boolean") fail("必须是布尔值");
      return errors;
    default:
      return errors;
  }
}
