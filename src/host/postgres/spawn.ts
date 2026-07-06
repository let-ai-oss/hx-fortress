export interface Spawner {
  // `stdout` is optional so existing mock spawners (which only surface exit code
  // + stderr) still satisfy the type; the real spawner always captures it, which
  // safe-extract's archive audit relies on.
  run(
    cmd: string[],
    opts?: { cwd?: string },
  ): Promise<{ code: number; stdout?: string; stderr: string }>;
}

export const defaultSpawner: Spawner = {
  async run(cmd, opts) {
    const proc = Bun.spawn(cmd, { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe" });
    // Read both pipes concurrently before awaiting exit so a child that fills
    // one pipe's buffer can't deadlock waiting for us to drain the other.
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  },
};
