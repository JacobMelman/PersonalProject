// Large encoded artifacts (video segments, screenshots) live in the Origin Private File System.
async function dirFor(path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop()!;
  let dir = await navigator.storage.getDirectory();
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return { dir, name };
}

export async function opfsWrite(path: string, data: Blob | Uint8Array): Promise<void> {
  const { dir, name } = await dirFor(path, true);
  const handle = await dir.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  try {
    await w.write(data as FileSystemWriteChunkType);
    await w.close();
  } catch (e) {
    await w.abort().catch(() => undefined);
    throw e;
  }
}

export async function opfsRead(path: string): Promise<File> {
  const { dir, name } = await dirFor(path, false);
  return (await dir.getFileHandle(name)).getFile();
}

export async function opfsRemove(path: string): Promise<void> {
  try {
    const { dir, name } = await dirFor(path, false);
    await dir.removeEntry(name);
  } catch {
    /* already gone */
  }
}

export async function opfsExists(path: string): Promise<boolean> {
  try {
    await opfsRead(path);
    return true;
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usageMB: number; quotaMB: number; persisted: boolean }> {
  const est = await navigator.storage.estimate();
  const persisted = (await navigator.storage.persisted?.()) ?? false;
  return { usageMB: (est.usage ?? 0) / 1048576, quotaMB: (est.quota ?? 0) / 1048576, persisted };
}
