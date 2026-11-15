export function formatTransportError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('ENOENT') || msg.includes('ECONNREFUSED')) {
    return [
      `ncl: cannot reach NanoMika host (${msg}).`,
      `Is the host running? Start it with \`pnpm start\` (or \`pnpm dev\`).`,
      ``,
    ].join('\n');
  }
  return `ncl: transport error: ${msg}\n`;
}
