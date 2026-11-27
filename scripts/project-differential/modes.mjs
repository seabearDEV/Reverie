// The project-resolution setups of gatediff.mjs, in the order run.mjs runs them.
//   proj          a project, and a cwd outside it (CLI and MCP)
//   legacy        an unparseable legacy .codexcli.json
//   legacyro      a valid legacy file in a read-only directory (cannot be migrated)
//   legacydir     a directory named .codexcli.json
//   legacyparent  an unmigratable legacy file in a subdirectory of a project
//   stale…stale6  an MCP server started outside any project; a project appears
//                 in its cwd after one first call (stale4: no call first)
//   nearer        an MCP server in a project's subdirectory; an empty project
//                 appears in that subdirectory (nearer2: one with entries)
export const MODES = ['proj', 'legacy', 'legacyro', 'legacydir', 'legacyparent', 'stale', 'stale2', 'stale3', 'stale4', 'stale5', 'stale6', 'nearer', 'nearer2'];
