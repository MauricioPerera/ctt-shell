/**
 * Content-addressable filesystem store (Git-inspired, like RepoMemory v2)
 * Zero dependencies - uses only Node.js built-ins.
 * Generic version: works with any CTT entity type.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Entity, EntityType } from '../types/entities.js';
import { ENTITY_TYPES } from '../types/entities.js';

export interface StoreConfig {
  /** Root directory for storage, defaults to .ctt-shell/store */
  root: string;
}

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function collectionDir(root: string, type: EntityType): string {
  return join(root, type);
}

export class Store {
  private root: string;

  constructor(config: StoreConfig) {
    this.root = config.root;
    this.ensureDirs();
  }

  private ensureDirs(): void {
    if (!existsSync(this.root)) {
      mkdirSync(this.root, { recursive: true });
    }
    for (const c of ENTITY_TYPES) {
      const dir = collectionDir(this.root, c);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  /** Save an entity. Generates id/timestamps if missing. Returns the saved entity. */
  save<T extends Entity>(entity: T): T {
    const now = new Date().toISOString();
    const saved = {
      ...entity,
      id: entity.id || randomUUID(),
      createdAt: entity.createdAt || now,
      updatedAt: now,
    } as T;

    const content = JSON.stringify(saved, null, 2);
    const hash = sha256(content);
    const dir = collectionDir(this.root, saved.type);
    const filePath = join(dir, `${saved.id}.json`);

    // Content-addressable: also store by hash for dedup
    const hashPath = join(dir, `.hash_${hash}`);
    if (existsSync(hashPath)) {
      // Exact duplicate, skip write
      return saved;
    }

    writeFileSync(filePath, content, 'utf-8');
    writeFileSync(hashPath, saved.id, 'utf-8');

    return saved;
  }

  /** Save many entities at once */
  saveBatch<T extends Entity>(entities: T[]): T[] {
    return entities.map(e => this.save(e));
  }

  /** Get entity by id and type */
  get<T extends Entity>(type: EntityType, id: string): T | null {
    const filePath = join(collectionDir(this.root, type), `${id}.json`);
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  }

  /** List all entities of a given type */
  list<T extends Entity>(type: EntityType): T[] {
    const dir = collectionDir(this.root, type);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .map(f => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as T);
  }

  /** Find entities matching a predicate */
  findBy<T extends Entity>(type: EntityType, predicate: (entity: T) => boolean): T[] {
    return this.list<T>(type).filter(predicate);
  }

  /** Delete entity by id */
  delete(type: EntityType, id: string): boolean {
    const filePath = join(collectionDir(this.root, type), `${id}.json`);
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    return true;
  }

  /** Count entities of a given type */
  count(type: EntityType): number {
    const dir = collectionDir(this.root, type);
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.')).length;
  }

  /** Get counts for all entity types */
  stats(): Record<EntityType, number> {
    const result = {} as Record<EntityType, number>;
    for (const type of ENTITY_TYPES) {
      result[type] = this.count(type);
    }
    return result;
  }
}
