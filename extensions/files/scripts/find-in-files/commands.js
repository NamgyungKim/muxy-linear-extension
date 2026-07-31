import { OUTPUT_LINE_LIMIT, SEARCH_TIMEOUT_MS } from "./constants.js";
import { pattern_stdin } from "./query.js";

export function rg_request(variants, options) {
  return {
    argv: rg_argv(options),
    stdin: pattern_stdin(variants),
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxLines: OUTPUT_LINE_LIMIT,
  };
}

export function grep_request(variants, options) {
  return {
    argv: grep_argv(options),
    stdin: pattern_stdin(variants),
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxLines: OUTPUT_LINE_LIMIT,
  };
}

function rg_argv(options) {
  return [
    "rg",
    "-n",
    "--null",
    "--no-config",
    "--color",
    "never",
    "--no-messages",
    "--threads",
    "2",
    "--max-filesize",
    "512K",
    "--max-count",
    "3",
    "--glob",
    "!node_modules/**",
    "--glob",
    "!.git/**",
    "--glob",
    "!dist/**",
    "--glob",
    "!build/**",
    "--glob",
    "!.build/**",
    "--glob",
    "!coverage/**",
    "--glob",
    "!.next/**",
    "--glob",
    "!.omo/**",
    "--glob",
    "!**/package-lock.json",
    "--glob",
    "!**/pnpm-lock.yaml",
    "--glob",
    "!**/yarn.lock",
    "--glob",
    "!**/bun.lockb",
    "--glob",
    "!**/*.map",
    "--glob",
    "!**/*.min.js",
    "--glob",
    "!**/*.{png,jpg,jpeg,gif,webp,svg,wasm}",
    ...rg_flags(options),
    "-f",
    "-",
    "--",
    ".",
  ];
}

function grep_argv(options) {
  return [
    "grep",
    ...grep_flags(options),
    "-m",
    "3",
    "--exclude-dir=node_modules",
    "--exclude-dir=.git",
    "--exclude-dir=dist",
    "--exclude-dir=build",
    "--exclude-dir=.build",
    "--exclude-dir=coverage",
    "--exclude-dir=.next",
    "--exclude-dir=.omo",
    "--exclude=package-lock.json",
    "--exclude=pnpm-lock.yaml",
    "--exclude=yarn.lock",
    "--exclude=bun.lockb",
    "--exclude=*.map",
    "--exclude=*.min.js",
    "--exclude=*.png",
    "--exclude=*.jpg",
    "--exclude=*.jpeg",
    "--exclude=*.gif",
    "--exclude=*.webp",
    "--exclude=*.svg",
    "--exclude=*.wasm",
    "-f",
    "-",
    "--",
    ".",
  ];
}

function rg_flags(options) {
  const flags = [];
  if (!options.caseSensitive) flags.push("-i");
  if (options.wholeWord) flags.push("-w");
  if (!options.regex) flags.push("-F");
  return flags;
}

function grep_flags(options) {
  return [
    "-rnI",
    "--color=never",
    !options.caseSensitive ? "-i" : "",
    options.wholeWord ? "-w" : "",
    options.regex ? "-E" : "-F",
  ].filter(Boolean);
}
