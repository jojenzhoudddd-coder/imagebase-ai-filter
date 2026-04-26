/**
 * V2.5 B8: per-artifact write serialiser.
 *
 * 当 workflow 同时跑多个 subagent 都改同一个 idea / table / design 时,
 * 每个 subagent 自己读 → 算 → 写,几个 transaction interleave 起来后写入
 * 会基于同一个 base content,最后一个写覆盖前面 → 丢更新。
 *
 * 这个模块给"每个 artifact id"维护一个 Promise queue,把对它的写动作串
 * 行化:LLM 思考依然并发,只有最后真正落库的写动作排队。在不同 artifact
 * 间完全无锁(队列以 `<type>:<id>` 为 key 隔离)。
 *
 * 用法:
 *   const result = await withArtifactWriteLock("idea", ideaId, async () => {
 *     // 这里是 read-modify-write 的整段逻辑
 *     const cur = await getIdea(ideaId);
 *     return await saveIdea(cur.version, newContent);
 *   });
 *
 * 注意:这个锁是单进程的(in-memory Map),不能解决多 backend 实例间的
 * 并发。生产单进程部署 OK;多 worker 时 V3 改成 Postgres advisory lock。
 */

const queues = new Map<string, Promise<unknown>>();

export type ArtifactType = "idea" | "table" | "design" | "demo";

function key(artifactType: ArtifactType, artifactId: string): string {
  return `${artifactType}:${artifactId}`;
}

/**
 * Run `fn` exclusively for the given artifact. Multiple concurrent calls
 * for the same artifact id queue up; calls for different artifacts run
 * in parallel.
 *
 * `fn` 里抛错不会污染队列 —— 错误依然 throw 给调用方,但下一个排队的会
 * 接着跑。这一点和 idea-stream 的 lock 一致:queue 不背锅,业务自己处理。
 */
export async function withArtifactWriteLock<T>(
  artifactType: ArtifactType,
  artifactId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const k = key(artifactType, artifactId);
  const prev = queues.get(k) ?? Promise.resolve();
  // 关键点:next 也用 .then(fn, fn) 而不是 .then(fn).catch(...) —— 因为
  // 我们不希望 prev 失败时 next 直接跳过(失败的是不同的 fn,继任者应当
  // 照常跑)。最佳处理:用 finally 模式
  let release: () => void;
  const released = new Promise<void>((res) => {
    release = res;
  });
  const next = prev.finally(() => undefined).then(async () => {
    try {
      return await fn();
    } finally {
      release();
    }
  });
  // queue 指向"我跑完了"的 promise,后续 enqueue 拼到这个后面
  queues.set(k, released);
  // 解决 cleanup:released 完成后清掉 queue 那一栏(若 queue.get 还指向我)
  released.then(() => {
    if (queues.get(k) === released) queues.delete(k);
  });
  return next;
}

/** 当前正在排队的 artifact 数 — 给监控 / debug 看的。 */
export function activeArtifactLockCount(): number {
  return queues.size;
}
