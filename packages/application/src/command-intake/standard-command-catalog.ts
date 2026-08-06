export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
  readonly classification: 'invalid' | 'ambiguous';
}

export interface CommandDefinition {
  readonly commandType: string;
  validate(
    payload: Readonly<Record<string, unknown>>,
    targetResourceId?: string,
  ): readonly ValidationIssue[];
}

export interface CommandCatalog {
  get(commandType: string): CommandDefinition | undefined;
}

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const artifactCreate: CommandDefinition = {
  commandType: 'artifact.create',
  validate(payload) {
    return nonEmptyString(payload.title)
      ? []
      : [
          {
            code: 'PAYLOAD_TITLE_REQUIRED',
            message: 'Artifact title is required.',
            field: 'payload.title',
            classification: 'invalid',
          },
        ];
  },
};

const artifactUpdate: CommandDefinition = {
  commandType: 'artifact.update',
  validate(payload, targetResourceId) {
    const issues: ValidationIssue[] = [];
    if (!nonEmptyString(targetResourceId)) {
      issues.push({
        code: 'TARGET_RESOURCE_AMBIGUOUS',
        message: 'Artifact update requires exactly one resolved target resource.',
        field: 'projectContext.targetResourceId',
        classification: 'ambiguous',
      });
    }
    if (Object.keys(payload).length === 0) {
      issues.push({
        code: 'PAYLOAD_EMPTY',
        message: 'Artifact update requires at least one change.',
        field: 'payload',
        classification: 'invalid',
      });
    }
    return issues;
  },
};

const definitions = new Map(
  [artifactCreate, artifactUpdate].map((definition) => [definition.commandType, definition]),
);

export const standardCommandCatalog: CommandCatalog = {
  get(commandType) {
    return definitions.get(commandType);
  },
};
