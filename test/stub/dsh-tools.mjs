/**
 * Offline stand-in for @deepseek-ai/dsh-tools.
 *
 * Mirrors the two contracts this plugin depends on: `defineTool` requires a
 * name, an `output { schema, render }` and an `execute`, and the registry hands
 * the definition back unchanged.
 */
export function defineTool(options) {
  if (!options || typeof options !== 'object') throw new TypeError('defineTool requires an options object');
  if (!options.name) throw new TypeError('tool must declare a name');
  if (!options.output || !options.output.schema || typeof options.output.render !== 'function') {
    throw new TypeError(`tool "${options.name}" must declare output { schema, render }`);
  }
  if (typeof options.execute !== 'function') throw new TypeError(`tool "${options.name}" must declare execute`);
  return options;
}
