import type { Environment } from '@pendleton-os/contracts';
import type { ProjectDirectory, ProjectRecord } from '../context-resolution/directories.js';

export type ProjectStatus = ProjectRecord['status'];
export type ProjectResourceProvider =
  | 'google-drive'
  | 'local-filesystem'
  | 'gmail'
  | 'microsoft-graph'
  | 'manual';

export type ProjectResourceType =
  | 'project-root'
  | 'folder'
  | 'document'
  | 'mailbox'
  | 'repository'
  | 'other';

export interface ProjectResourceRecord {
  readonly resourceId: string;
  readonly projectId: string;
  readonly provider: ProjectResourceProvider;
  readonly resourceType: ProjectResourceType;
  readonly externalId: string;
  readonly displayName: string;
  readonly canonicalUrl?: string;
  readonly status: 'active' | 'disconnected';
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly discoveredAt: string;
  readonly updatedAt: string;
}

export interface ProjectResourceInput {
  readonly resourceId: string;
  readonly provider: ProjectResourceProvider;
  readonly resourceType: ProjectResourceType;
  readonly externalId: string;
  readonly displayName: string;
  readonly canonicalUrl?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ProjectCandidateInput {
  readonly projectId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
  readonly environment?: Environment;
  readonly resources?: readonly ProjectResourceInput[];
}

export interface ProjectRegistry extends ProjectDirectory {
  list(status?: ProjectStatus): Promise<readonly ProjectRecord[]>;
  getResources(projectId: string): Promise<readonly ProjectResourceRecord[]>;
  importCandidates(
    candidates: readonly ProjectCandidateInput[],
    ownerActorId: string,
  ): Promise<readonly ProjectRecord[]>;
  setStatus(projectId: string, status: ProjectStatus): Promise<ProjectRecord | undefined>;
  findResource(
    projectId: string,
    provider: ProjectResourceProvider,
    resourceType: ProjectResourceType,
  ): Promise<ProjectResourceRecord | undefined>;
}
