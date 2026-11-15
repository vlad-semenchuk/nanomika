// Host-side provider container-config barrel.
// Providers that need host-side container setup (extra mounts, env passthrough,
// per-session directories) self-register on import. Providers with no host
// needs (claude, mock) don't appear here.
//
// Add a provider by appending one import line below, e.g.
// `import './claude.js';` (see claude.ts for when that is useful).
