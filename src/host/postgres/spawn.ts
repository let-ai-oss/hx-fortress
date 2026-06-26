export interface Spawner {
  run(cmd: string[], opts?: { cwd?: string }): Promise<{ code: number; stderr: string }>;
}

export const defaultSpawner: Spawner = {
  async run(cmd, opts) {
    const proc = Bun.spawn(cmd, { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    return { code, stderr };
  },
};
