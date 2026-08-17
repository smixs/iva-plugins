// One tool, the smallest working form. The file name is the tool name, and the mount
// Iva generates adds the namespace of the plugin: the model calls it `hello__hello`.
//
// `inputSchema` is a plain JSON Schema object rather than a Zod one on purpose: the
// plugin then has no dependencies at all, so nothing is installed before the build.
// Zod works the same way (`inputSchema: z.object({ name: z.string().optional() })`)
// once the plugin declares it in `dependencies`.
import { defineTool } from "eve/tools";

export default defineTool({
  description:
    "Greet somebody by name. Returns the greeting as a string. " +
    "Without a name it greets the world.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Who to greet" },
    },
    additionalProperties: false,
  },
  execute(input) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    return `Hello, ${name || "world"}!`;
  },
});
