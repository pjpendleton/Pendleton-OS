import type { Actor, PendletonError, ProjectContext } from '@pendleton-os/contracts';
import type { IdentityDirectory, ProjectDirectory, ProjectRecord } from './directories.js';

export type ProjectSelector =
  | { readonly projectId: string; readonly alias?: never }
  | { readonly alias: string; readonly projectId?: never };

export interface ContextResolutionRequest {
  readonly principalId: string;
  readonly project: ProjectSelector;
  readonly targetResourceId?: string;
}

export type ContextResolutionOutcome =
  | {
      readonly disposition: 'resolved';
      readonly actor: Actor;
      readonly projectContext: ProjectContext;
    }
  | {
      readonly disposition: 'rejected';
      readonly errors: readonly PendletonError[];
    };

export interface ContextResolutionDependencies {
  readonly identities: IdentityDirectory;
  readonly projects: ProjectDirectory;
}

const nonEmpty = (value: string): boolean => value.trim().length > 0;

const resolutionError = (
  code: string,
  category: PendletonError['category'],
  message: string,
  details?: Readonly<Record<string, unknown>>,
): PendletonError => ({
  code,
  category,
  message,
  retryable: false,
  ...(details === undefined ? {} : { details }),
});

export class ContextResolutionService {
  readonly #identities: IdentityDirectory;
  readonly #projects: ProjectDirectory;

  constructor(dependencies: ContextResolutionDependencies) {
    this.#identities = dependencies.identities;
    this.#projects = dependencies.projects;
  }

  async resolve(request: ContextResolutionRequest): Promise<ContextResolutionOutcome> {
    if (!nonEmpty(request.principalId)) {
      return {
        disposition: 'rejected',
        errors: [
          resolutionError(
            'PRINCIPAL_REQUIRED',
            'authentication',
            'An authenticated principal is required.',
          ),
        ],
      };
    }

    const identity = await this.#identities.findByPrincipal(request.principalId.trim());
    if (identity === undefined) {
      return {
        disposition: 'rejected',
        errors: [
          resolutionError(
            'IDENTITY_NOT_FOUND',
            'authentication',
            'The authenticated principal is not registered.',
          ),
        ],
      };
    }
    if (identity.status !== 'active') {
      return {
        disposition: 'rejected',
        errors: [
          resolutionError(
            'IDENTITY_DISABLED',
            'authentication',
            'The registered identity is disabled.',
          ),
        ],
      };
    }

    const projectResult = await this.#resolveProject(request.project);
    if (projectResult.disposition === 'rejected') return projectResult;
    const project = projectResult.project;

    if (project.status !== 'active') {
      return {
        disposition: 'rejected',
        errors: [
          resolutionError(
            'PROJECT_ARCHIVED',
            'authorization',
            'The resolved project is not active.',
            { projectId: project.projectId },
          ),
        ],
      };
    }
    if (!project.authorizedActorIds.includes(identity.actor.actorId)) {
      return {
        disposition: 'rejected',
        errors: [
          resolutionError(
            'PROJECT_ACCESS_DENIED',
            'authorization',
            'The actor is not authorized for the resolved project.',
            { projectId: project.projectId },
          ),
        ],
      };
    }
    if (
      request.targetResourceId !== undefined &&
      !project.resourceIds.includes(request.targetResourceId)
    ) {
      return {
        disposition: 'rejected',
        errors: [
          resolutionError(
            'TARGET_RESOURCE_NOT_FOUND',
            'authorization',
            'The target resource is not registered in the resolved project.',
            { projectId: project.projectId },
          ),
        ],
      };
    }

    return {
      disposition: 'resolved',
      actor: identity.actor,
      projectContext: {
        projectId: project.projectId,
        environment: project.environment,
        ...(request.targetResourceId === undefined
          ? {}
          : { targetResourceId: request.targetResourceId }),
      },
    };
  }

  async #resolveProject(
    selector: ProjectSelector,
  ): Promise<
    | { readonly disposition: 'resolved'; readonly project: ProjectRecord }
    | { readonly disposition: 'rejected'; readonly errors: readonly PendletonError[] }
  > {
    if ('projectId' in selector) {
      if (!nonEmpty(selector.projectId)) {
        return {
          disposition: 'rejected',
          errors: [
            resolutionError(
              'PROJECT_SELECTOR_INVALID',
              'validation',
              'Project identifier cannot be empty.',
            ),
          ],
        };
      }
      const project = await this.#projects.findById(selector.projectId.trim());
      return project === undefined
        ? {
            disposition: 'rejected',
            errors: [
              resolutionError(
                'PROJECT_NOT_FOUND',
                'authorization',
                'No project matches the supplied identifier.',
              ),
            ],
          }
        : { disposition: 'resolved', project };
    }

    if (!nonEmpty(selector.alias)) {
      return {
        disposition: 'rejected',
        errors: [
          resolutionError(
            'PROJECT_SELECTOR_INVALID',
            'validation',
            'Project alias cannot be empty.',
          ),
        ],
      };
    }
    const candidates = await this.#projects.findByAlias(selector.alias);
    if (candidates.length === 0) {
      return {
        disposition: 'rejected',
        errors: [
          resolutionError(
            'PROJECT_NOT_FOUND',
            'authorization',
            'No project matches the supplied alias.',
          ),
        ],
      };
    }
    if (candidates.length > 1) {
      return {
        disposition: 'rejected',
        errors: [
          resolutionError(
            'PROJECT_AMBIGUOUS',
            'validation',
            'The supplied alias matches more than one project.',
            { candidateCount: candidates.length },
          ),
        ],
      };
    }
    const project = candidates[0];
    if (project === undefined) throw new Error('Project resolution invariant failed.');
    return { disposition: 'resolved', project };
  }
}
