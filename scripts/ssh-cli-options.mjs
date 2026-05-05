export function parseOptions(args) {
  const options = {};
  const positional = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const [flag, inlineValue] = arg.split("=", 2);
    const readValue = () => {
      if (inlineValue !== undefined) {
        if (!inlineValue) {
          throw new Error(`Option ${flag} requires a value.`);
        }
        return inlineValue;
      }
      const nextValue = args[i + 1];
      if (!nextValue || nextValue.startsWith("--")) {
        throw new Error(`Option ${flag} requires a value.`);
      }
      i += 1;
      return nextValue;
    };

    if (flag === "--sudo") {
      options.sudo = true;
    } else if (flag === "--raw") {
      options.raw = true;
    } else if (flag === "--no-sudo") {
      options.includeSudo = false;
    } else if (flag === "--timeout-ms") {
      options.timeoutMs = Number(readValue());
    } else if (flag === "--port") {
      options.port = Number(readValue());
    } else if (flag === "--identity-file") {
      options.identityFile = readValue();
    } else if (flag === "--jump-host") {
      options.jumpHost = readValue();
    } else if (flag === "--path") {
      options.path = readValue();
    } else if (flag === "--depth") {
      options.depth = Number(readValue());
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  return { options, positional };
}
