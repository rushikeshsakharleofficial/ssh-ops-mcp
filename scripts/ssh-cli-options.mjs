import { parseArgs } from "node:util";

const STRING_FLAGS = ["identity-file", "jump-host", "path"];
const NUMERIC_FLAGS = ["timeout-ms", "port", "depth"];
const BOOLEAN_FLAGS = ["sudo", "raw", "no-sudo"];

const PARSE_ARGS_OPTIONS = {};
for (const flag of STRING_FLAGS) PARSE_ARGS_OPTIONS[flag] = { type: "string" };
for (const flag of NUMERIC_FLAGS) PARSE_ARGS_OPTIONS[flag] = { type: "string" };
for (const flag of BOOLEAN_FLAGS) PARSE_ARGS_OPTIONS[flag] = { type: "boolean" };

export function parseOptions(args) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: PARSE_ARGS_OPTIONS,
      strict: true,
      allowPositionals: true
    }));
  } catch (error) {
    const match = /'(--[\w-]+)/.exec(error.message);
    if (match && /argument missing|argument is ambiguous/.test(error.message)) {
      throw new Error(`Option ${match[1]} requires a value.`);
    }
    if (match && /^Unknown option/.test(error.message)) {
      throw new Error(`Unknown option: ${match[1]}`);
    }
    throw error;
  }

  const options = {};
  if (values.sudo) options.sudo = true;
  if (values.raw) options.raw = true;
  if (values["no-sudo"]) options.includeSudo = false;
  if (values["timeout-ms"] !== undefined) options.timeoutMs = Number(values["timeout-ms"]);
  if (values.port !== undefined) options.port = Number(values.port);
  if (values["identity-file"] !== undefined) options.identityFile = values["identity-file"];
  if (values["jump-host"] !== undefined) options.jumpHost = values["jump-host"];
  if (values.path !== undefined) options.path = values.path;
  if (values.depth !== undefined) options.depth = Number(values.depth);

  return { options, positional: positionals };
}
