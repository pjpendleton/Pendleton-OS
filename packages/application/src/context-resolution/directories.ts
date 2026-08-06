import type { Actor, Environment } from '@pendleton-os/contracts';

export interface IdentityRecord {
  readonly principalId: string;
  readonly actor: Actor;
  readonly status: 'active' | 'disabled';
}

export interface ProjectRecord {
  readonly projectId: string;
  readonly aliases: readonly string[];
  readonly environment: Environment;
  readonly status: 'active' | 'archived';
  readonly authorizedActorIds: readonly string[];
  readonly resourceIds: readonly string[];
}

export interface IdentityDirectory {
  findByPrincipal(principalId: string): Promise<IdentityRecord | undefined>;
}

export interface ProjectDirectory {
  findById(projectId: string): Promise<ProjectRecord | undefined>;
  findByAlias(alias: string): Promise<readonly ProjectRecord[]>;
}

export class InMemoryIdentityDirectory implements IdentityDirectory {
  readonly #records: ReadonlyMap<string, IdentityRecord>;

  constructor(records: readonly IdentityRecord[]) {
    this.#records = new Map(records.map((record) => [record.principalId, record]));
  }

  findByPrincipal(principalId: string): Promise<IdentityRecord | undefined> {
    return Promise.resolve(this.#records.get(principalId));
  }
}

export class InMemoryProjectDirectory implements ProjectDirectory {
  readonly #records: readonly ProjectRecord[];

  constructor(records: readonly ProjectRecord[]) {
    this.#records = [...records];
  }

  findById(projectId: string): Promise<ProjectRecord | undefined> {
    return Promise.resolve(this.#records.find((record) => record.projectId === projectId));
  }

  findByAlias(alias: string): Promise<readonly ProjectRecord[]> {
    const normalizedAlias = alias.trim().toLocaleLowerCase('en-US');
    return Promise.resolve(
      this.#records.filter((record) =>
        record.aliases.some(
          (candidate) => candidate.trim().toLocaleLowerCase('en-US') === normalizedAlias,
        ),
      ),
    );
  }
}
