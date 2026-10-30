/**
 * Redirect `@deepseek-ai/dsh-tools` to the offline stub. The real package is a
 * peer dependency supplied by the harness, so a checkout has nothing to import.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: new URL('./dsh-tools.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
