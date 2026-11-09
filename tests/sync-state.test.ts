import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createSyncState, loadSyncState, saveSyncState } from '../src/sync-config';

function tempStatePath(prefix: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, path: join(dir, 'nested', 'sync-state.json') };
}

describe('增量状态 v2', () => {
  it('文件不存在 → 空状态', () => {
    const { dir, path } = tempStatePath('state-empty-');
    try {
      expect(loadSyncState(path)).toEqual({
        marks: {},
        targets: {},
        progress: {},
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('旧版本文件被拒绝：不做任何字段级兼容', () => {
    const { dir, path } = tempStatePath('state-v1-');
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          updatedAt: '2026-11-01T00:00:00.000Z',
          marks: { 'uuid-a': 'sha1aaa' },
        }),
        'utf8',
      );
      expect(loadSyncState(path)).toEqual(createSyncState());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('版本号缺失或字段缺失 → 空状态', () => {
    const { dir, path } = tempStatePath('state-shape-');
    try {
      mkdirSync(dirname(path), { recursive: true });
      const cases = [
        { updatedAt: 'x', marks: {}, targets: {}, progress: {} },
        { version: 2, updatedAt: 'x', marks: {}, targets: {} },
        { version: 2, updatedAt: 'x', marks: {}, progress: {} },
      ];
      for (const doc of cases) {
        writeFileSync(path, JSON.stringify(doc), 'utf8');
        expect(loadSyncState(path)).toEqual(createSyncState());
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('字段类型不对 → 空状态（不做宽容解析）', () => {
    const { dir, path } = tempStatePath('state-type-');
    try {
      mkdirSync(dirname(path), { recursive: true });
      const cases = [
        { version: 2, updatedAt: 'x', marks: { a: 1 }, targets: {}, progress: {} },
        { version: 2, updatedAt: 'x', marks: {}, targets: { a: '1' }, progress: {} },
        {
          version: 2,
          updatedAt: 'x',
          marks: {},
          targets: {},
          progress: { a: 'pending' },
        },
        { version: 2, updatedAt: 'x', marks: [], targets: {}, progress: {} },
      ];
      for (const doc of cases) {
        writeFileSync(path, JSON.stringify(doc), 'utf8');
        expect(loadSyncState(path)).toEqual(createSyncState());
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('写入后是 v2，且 marks 形状不变', () => {
    const { dir, path } = tempStatePath('state-save-');
    try {
      saveSyncState(path, {
        marks: { 'uuid-a': 'sha1aaa' },
        targets: { 'uuid-a': 12345 },
        progress: { 'uuid-a': 'done' },
      });

      const raw = JSON.parse(readFileSync(path, 'utf8')) as {
        version: number;
        marks: Record<string, string>;
        targets: Record<string, number>;
        progress: Record<string, string>;
        updatedAt: string;
      };
      expect(raw.version).toBe(2);
      expect(raw.marks).toEqual({ 'uuid-a': 'sha1aaa' });
      expect(raw.targets).toEqual({ 'uuid-a': 12345 });
      expect(raw.progress).toEqual({ 'uuid-a': 'done' });
      expect(typeof raw.updatedAt).toBe('string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('保存后可原样读回', () => {
    const { dir, path } = tempStatePath('state-roundtrip-');
    try {
      const before = {
        marks: { a: 'h1', b: 'h2' },
        targets: { a: 1, b: 2 },
        progress: { a: 'done' as const },
      };
      saveSyncState(path, before);
      expect(loadSyncState(path)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('损坏文件回落空状态，不抛异常', () => {
    const { dir, path } = tempStatePath('state-broken-');
    try {
      // 先借 saveSyncState 建好父目录，再写入非法内容。
      saveSyncState(path, createSyncState());
      writeFileSync(path, '{ not json', 'utf8');
      expect(loadSyncState(path)).toEqual({
        marks: {},
        targets: {},
        progress: {},
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('createSyncState 每次返回独立对象', () => {
    const a = createSyncState();
    const b = createSyncState();
    a.marks.x = 'h';
    expect(b.marks).toEqual({});
  });
});
